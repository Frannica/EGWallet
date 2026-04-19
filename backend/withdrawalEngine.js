'use strict';
/**
 * withdrawalEngine.js
 * Handles all withdrawal state transitions, fund holds, ledger writes,
 * idempotency guards, and refund logic.
 *
 * No HTTP layer here — pure data functions called from index.js routes.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ─── Allowed status transitions (state machine) ──────────────────────────────
const VALID_TRANSITIONS = {
  pending_review: ['approved', 'failed', 'reversed'],
  approved:       ['processing', 'failed', 'reversed'],
  processing:     ['paid', 'failed', 'reversed'],
  paid:           ['reversed'],
  failed:         [],
  reversed:       [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Deterministic idempotency key: sha256(userId:amount:currency:createdAt).
 * Stored permanently on the withdrawal record.
 */
function makeIdempotencyKey(userId, amount, currency, createdAt) {
  return crypto
    .createHash('sha256')
    .update(`${userId}:${amount}:${currency}:${createdAt}`)
    .digest('hex');
}

/** Append an immutable entry to db.ledger[]. */
function appendLedger(db, entry) {
  if (!db.ledger) db.ledger = [];
  db.ledger.push({ id: uuidv4(), ...entry });
}

/** Push to statusHistory[] and update top-level status. */
function recordStatusChange(withdrawal, status, by) {
  withdrawal.statusHistory.push({ status, at: Date.now(), by });
  withdrawal.status = status;
}

// ─── createWithdrawal ────────────────────────────────────────────────────────
/**
 * Called from POST /withdrawals.
 * Validates balance, locks funds into holdBalance, creates withdrawal record,
 * writes a withdrawal_hold ledger entry.
 *
 * @param {object} db            - live db object (caller must saveDB after)
 * @param {string} userId
 * @param {object} fields
 * @returns {object}             - the new withdrawal record
 * @throws                       - { message, status } on validation failure
 */
function createWithdrawal(db, userId, fields) {
  const {
    walletId, amount, currency, method, isInternational,
    country, bankName, accountNumber, accountHolderName,
    bankCode, branchCode, iban, swiftBic,
    feeAmount, feeRate, netPayout,
  } = fields;

  // ── 1. Locate wallet ──────────────────────────────────────────────────────
  const wallet = (db.wallets || []).find(w => w.id === walletId && w.userId === userId);
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { status: 404 });

  const balance = (wallet.balances || []).find(b => b.currency === currency);
  if (!balance || balance.amount < amount)
    throw Object.assign(new Error('Insufficient funds'), { status: 400 });

  // ── 2. Server-side idempotency key ────────────────────────────────────────
  const createdAt = Date.now();
  const idempotencyKey = makeIdempotencyKey(userId, amount, currency, createdAt);

  // Reject if a record with the same key already exists (clock collision / retry)
  const duplicate = (db.withdrawals || []).find(w => w.idempotencyKey === idempotencyKey);
  if (duplicate)
    throw Object.assign(new Error('Duplicate withdrawal — please retry in a moment'), { status: 409 });

  // ── 3. Lock funds into hold ───────────────────────────────────────────────
  const balanceBefore = balance.amount;
  balance.amount -= amount;                                    // debit available balance
  if (!wallet.holdBalance) wallet.holdBalance = {};
  wallet.holdBalance[currency] = (wallet.holdBalance[currency] || 0) + amount; // escrow

  // ── 4. Build withdrawal record ────────────────────────────────────────────
  const withdrawal = {
    id: uuidv4(),
    idempotencyKey,
    userId,
    walletId,

    // Money
    amount,
    currency,
    feeAmount,
    feeRate,
    netPayout,

    // Routing details (stored exactly as submitted)
    method,                                 // 'bank' | 'mobile' | 'debit'
    isInternational: !!isInternational,
    country:          country          || null,
    bankName:         bankName         || null,
    accountNumber:    accountNumber    || null,
    accountHolderName: accountHolderName || null,
    bankCode:         bankCode         || null,
    branchCode:       branchCode       || null,
    iban:             iban             || null,
    swiftBic:         swiftBic         || null,

    // Status lifecycle
    status: 'pending_review',
    statusHistory: [{ status: 'pending_review', at: createdAt, by: 'system' }],

    // Safety flags
    holdReleased:   false,   // true once hold is settled (paid or refunded)
    refundIssued:   false,   // true once _issueRefund has run — prevents double-refund
    payoutAttempts: 0,       // incremented only when marking 'paid'

    // Timestamps
    createdAt,
    approvedAt:   null,
    processedAt:  null,
    paidAt:       null,
    failedAt:     null,
    reversedAt:   null,

    // Admin
    processedBy:  null,
    internalNote: null,

    // Payout provider  (filled in by payoutProviders.js after real API call)
    payoutProvider:  null,   // 'stripe' | 'kora'
    payoutReference: null,   // provider's transaction/payout ID
    payoutError:     null,   // error message if failed via provider
  };

  if (!db.withdrawals) db.withdrawals = [];
  db.withdrawals.push(withdrawal);

  // ── 5. Ledger entry — withdrawal_hold ─────────────────────────────────────
  appendLedger(db, {
    withdrawalId:  withdrawal.id,
    userId,
    walletId,
    currency,
    type:          'withdrawal_hold',
    amount,
    balanceBefore,
    balanceAfter:  balance.amount,
    at:            createdAt,
    by:            'system',
    note:          null,
  });

  return withdrawal;
}

// ─── adminTransition ─────────────────────────────────────────────────────────
/**
 * Moves a withdrawal through the state machine.
 * Called from admin routes.  Caller must saveDB after.
 *
 * @param {object} db
 * @param {string} withdrawalId
 * @param {string} newStatus    - one of the valid status values
 * @param {string} adminId
 * @param {string|null} note
 * @returns {object}            - updated withdrawal record
 */
function adminTransition(db, withdrawalId, newStatus, adminId, note) {
  const w = (db.withdrawals || []).find(x => x.id === withdrawalId);
  if (!w) throw Object.assign(new Error('Withdrawal not found'), { status: 404 });

  // ── State machine guard ───────────────────────────────────────────────────
  const allowed = VALID_TRANSITIONS[w.status] || [];
  if (!allowed.includes(newStatus))
    throw Object.assign(
      new Error(`Invalid transition: ${w.status} → ${newStatus}`),
      { status: 409 }
    );

  const now = Date.now();
  recordStatusChange(w, newStatus, adminId);
  if (note) w.internalNote = note;
  w.processedBy = adminId;

  // ── Per-status side-effects ───────────────────────────────────────────────
  if (newStatus === 'approved') {
    w.approvedAt = now;
  }

  if (newStatus === 'processing') {
    w.processedAt = now;
  }

  if (newStatus === 'paid') {
    // Guard: cannot mark paid more than once
    if (w.holdReleased)
      throw Object.assign(new Error('Payout already recorded for this withdrawal'), { status: 409 });

    w.paidAt = now;
    w.payoutAttempts += 1;
    w.holdReleased = true;

    // Release hold — the actual bank payout happened, so do NOT return to balance
    _releaseHoldOnly(db, w);

    appendLedger(db, {
      withdrawalId: w.id,
      userId:       w.userId,
      walletId:     w.walletId,
      currency:     w.currency,
      type:         'withdrawal_paid',
      amount:       w.amount,
      balanceBefore: null,   // hold released — available balance unchanged
      balanceAfter:  null,
      at:           now,
      by:           adminId,
      note:         note || null,
    });
  }

  if (newStatus === 'failed') {
    w.failedAt = now;
    _issueRefund(db, w, adminId, 'withdrawal_failed_refund');
  }

  if (newStatus === 'reversed') {
    w.reversedAt = now;
    _issueRefund(db, w, adminId, 'withdrawal_reversed');
  }

  return w;
}

// ─── Internal — _releaseHoldOnly ─────────────────────────────────────────────
/** Removes amount from escrow without returning it to available balance. */
function _releaseHoldOnly(db, w) {
  const wallet = (db.wallets || []).find(x => x.id === w.walletId);
  if (!wallet) return;
  wallet.holdBalance = wallet.holdBalance || {};
  wallet.holdBalance[w.currency] = Math.max(
    0,
    (wallet.holdBalance[w.currency] || 0) - w.amount
  );
}

// ─── Internal — _issueRefund ─────────────────────────────────────────────────
/**
 * Returns held amount to the user's available balance.
 * Guarded by refundIssued flag — runs exactly once per withdrawal.
 */
function _issueRefund(db, w, by, ledgerType) {
  if (w.refundIssued) return;   // ← idempotency guard: never refund twice
  w.refundIssued = true;
  w.holdReleased = true;

  const wallet = (db.wallets || []).find(x => x.id === w.walletId);
  if (!wallet) return;

  const balance = (wallet.balances || []).find(b => b.currency === w.currency);
  const balanceBefore = balance ? balance.amount : 0;

  // Return to available balance
  if (balance) balance.amount += w.amount;

  // Remove from hold escrow
  wallet.holdBalance = wallet.holdBalance || {};
  wallet.holdBalance[w.currency] = Math.max(
    0,
    (wallet.holdBalance[w.currency] || 0) - w.amount
  );

  appendLedger(db, {
    withdrawalId:  w.id,
    userId:        w.userId,
    walletId:      w.walletId,
    currency:      w.currency,
    type:          ledgerType,           // 'withdrawal_failed_refund' | 'withdrawal_reversed'
    amount:        w.amount,
    balanceBefore,
    balanceAfter:  balanceBefore + w.amount,
    at:            Date.now(),
    by,
    note:          null,
  });
}

module.exports = {
  createWithdrawal,
  adminTransition,
  advanceToProcessing,
  markWithdrawalPaid,
  markWithdrawalFailed,
};

// ─── advanceToProcessing ─────────────────────────────────────────────────────
/**
 * Synchronously drives a freshly-created withdrawal from pending_review
 * through approved → processing.  Does NOT mark paid — that is done
 * by payoutProviders.js after the real API call succeeds.
 *
 * Called in the HTTP handler before saveDB() and res.json().
 * If the state machine cannot advance (logic error), marks failed + refunds.
 *
 * @param {object} db
 * @param {string} withdrawalId
 * @returns {object|null} the updated withdrawal, or null if not found
 */
function advanceToProcessing(db, withdrawalId) {
  const w = (db.withdrawals || []).find(x => x.id === withdrawalId);
  if (!w) return null;

  const now = Date.now();
  try {
    for (const step of ['approved', 'processing']) {
      const allowed = VALID_TRANSITIONS[w.status] || [];
      if (!allowed.includes(step))
        throw new Error(`Advance blocked: ${w.status} → ${step}`);
      recordStatusChange(w, step, 'system');
      if (step === 'approved')   w.approvedAt  = now;
      if (step === 'processing') w.processedAt = now;
    }
  } catch (err) {
    try {
      if ((VALID_TRANSITIONS[w.status] || []).includes('failed')) {
        recordStatusChange(w, 'failed', 'system');
        w.failedAt     = Date.now();
        w.internalNote = `Advance error: ${err.message}`;
        _issueRefund(db, w, 'system', 'withdrawal_failed_refund');
      }
    } catch (_) { /* best-effort */ }
  }
  return w;
}

// ─── markWithdrawalPaid ──────────────────────────────────────────────────────
/**
 * Marks a processing withdrawal as paid after the provider API confirms success.
 * Called by payoutProviders.js executePayout on success path.
 * Caller must saveDB after.
 *
 * @param {object} db
 * @param {string} withdrawalId
 * @param {string} providerRef   - provider's transaction/payout ID
 * @param {string} provider      - 'stripe' | 'kora'
 */
function markWithdrawalPaid(db, withdrawalId, providerRef, provider) {
  const w = (db.withdrawals || []).find(x => x.id === withdrawalId);
  if (!w) throw Object.assign(new Error('Withdrawal not found'), { status: 404 });

  const allowed = VALID_TRANSITIONS[w.status] || [];
  if (!allowed.includes('paid'))
    throw Object.assign(
      new Error(`Cannot mark paid from status: ${w.status}`),
      { status: 409 }
    );

  if (w.holdReleased)
    throw Object.assign(
      new Error('Payout already recorded — duplicate guard triggered'),
      { status: 409 }
    );

  const now = Date.now();
  recordStatusChange(w, 'paid', 'system');
  w.paidAt          = now;
  w.payoutAttempts += 1;
  w.holdReleased    = true;
  w.payoutProvider  = provider;
  w.payoutReference = providerRef;

  _releaseHoldOnly(db, w);

  appendLedger(db, {
    withdrawalId:  w.id,
    userId:        w.userId,
    walletId:      w.walletId,
    currency:      w.currency,
    type:          'withdrawal_paid',
    amount:        w.amount,
    balanceBefore: null,
    balanceAfter:  null,
    at:            now,
    by:            'system',
    note:          `${provider}:${providerRef}`,
  });

  return w;
}

// ─── markWithdrawalFailed ────────────────────────────────────────────────────
/**
 * Marks a withdrawal as failed and issues a full refund of the held funds.
 * Called by payoutProviders.js executePayout on error path.
 * Caller must saveDB after.
 *
 * @param {object} db
 * @param {string} withdrawalId
 * @param {string} reason         - error message from provider
 */
function markWithdrawalFailed(db, withdrawalId, reason) {
  const w = (db.withdrawals || []).find(x => x.id === withdrawalId);
  if (!w) throw Object.assign(new Error('Withdrawal not found'), { status: 404 });

  const allowed = VALID_TRANSITIONS[w.status] || [];
  if (!allowed.includes('failed'))
    throw Object.assign(
      new Error(`Cannot mark failed from status: ${w.status}`),
      { status: 409 }
    );

  const now = Date.now();
  recordStatusChange(w, 'failed', 'system');
  w.failedAt    = now;
  w.payoutError = reason;

  _issueRefund(db, w, 'system', 'withdrawal_failed_refund');

  return w;
}
