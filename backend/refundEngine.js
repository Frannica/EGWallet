'use strict';
/**
 * refundEngine.js
 *
 * Stripe refund-to-original-payment-method state machine + wallet hold logic.
 * No HTTP layer here — pure data functions called from index.js / webhooks /
 * adminRefunds.js.
 *
 * CRITICAL RULES:
 *  - Refunds ONLY go to the original Stripe PaymentIntent payment method.
 *  - Never accept a user-supplied destination card.
 *  - Atomic wallet hold BEFORE calling Stripe.
 *  - Finalize wallet debit only after verified Stripe success.
 *  - Release hold (restore balance) on failure / cancellation ONLY after
 *    Stripe has been re-queried and confirmed no refund exists
 *    (see refundStripeSafety.js). HTTP 502 / timeout / idempotency noise
 *    must NEVER restore funds when Stripe already succeeded.
 *  - All transitions are auditable via statusHistory and retry-safe.
 *  - Webhook + API retry must be idempotent (no double debit / credit).
 */

const { v4: uuidv4 } = require('uuid');

const VALID_TRANSITIONS = {
  // Stripe may return status=succeeded synchronously from refunds.create,
  // so requested → succeeded is a valid fast path (still after the hold).
  requested:       ['pending', 'requires_action', 'succeeded', 'failed', 'cancelled'],
  pending:         ['succeeded', 'failed', 'requires_action', 'cancelled'],
  requires_action: ['pending', 'succeeded', 'failed', 'cancelled'],
  succeeded:       [],
  // failed/cancelled → succeeded only when Stripe confirms a refund already
  // exists after a false local failure (recovery / webhook / admin reconcile).
  failed:          ['succeeded'],
  cancelled:       ['succeeded'],
};

/** Statuses that still consume refundable capacity on a deposit. */
const ACTIVE_OR_SUCCEEDED = new Set(['requested', 'pending', 'requires_action', 'succeeded']);

/** Stripe refund window (days) — matches Stripe's typical card refund limit. */
const REFUND_WINDOW_DAYS = Number(process.env.STRIPE_REFUND_WINDOW_DAYS || 180);
const REFUND_WINDOW_MS = REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function appendLedger(db, entry) {
  if (!db.ledger) db.ledger = [];
  db.ledger.push({ id: uuidv4(), ...entry });
}

function recordStatusChange(refund, status, by, reason) {
  if (!Array.isArray(refund.statusHistory)) refund.statusHistory = [];
  refund.statusHistory.push({
    status,
    at: Date.now(),
    by,
    ...(reason ? { reason } : {}),
  });
  refund.status = status;
  refund.updatedAt = Date.now();
}

function assertTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw Object.assign(
      new Error(`Invalid refund transition ${from} → ${to}`),
      { status: 409, errorCode: 'INVALID_REFUND_TRANSITION' }
    );
  }
}

function ensureRefundCollections(db) {
  if (!Array.isArray(db.refundRequests)) db.refundRequests = [];
  if (!Array.isArray(db.ledger)) db.ledger = [];
}

/** Sum of wallet amounts already claimed against a deposit (active + succeeded). */
function sumClaimedRefundAmount(db, depositTransactionId, excludeRefundId) {
  ensureRefundCollections(db);
  return (db.refundRequests || [])
    .filter((r) =>
      r.depositTransactionId === depositTransactionId &&
      ACTIVE_OR_SUCCEEDED.has(r.status) &&
      r.id !== excludeRefundId
    )
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
}

/**
 * Compute how much of a deposit's net credit remains refundable from the wallet.
 * Does not call Stripe — caller must also check Stripe's amount_refunded.
 */
function getWalletRefundableAmount(db, depositTx) {
  if (!depositTx || depositTx.type !== 'deposit' || depositTx.status !== 'completed') return 0;
  if (!depositTx.stripeIntentId || !String(depositTx.stripeIntentId).startsWith('pi_')) return 0;
  const net = Number(depositTx.amount || 0);
  if (!Number.isFinite(net) || net <= 0) return 0;
  const claimed = sumClaimedRefundAmount(db, depositTx.id);
  return Math.max(0, net - claimed);
}

function isWithinRefundWindow(depositTx, now = Date.now()) {
  const ts = typeof depositTx.timestamp === 'number'
    ? depositTx.timestamp
    : new Date(depositTx.timestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  return (now - ts) <= REFUND_WINDOW_MS;
}

/**
 * Map a requested wallet refund amount to the Stripe refund amount (minor units).
 * Full remaining refund of the deposit → refund the remaining Stripe chargeable
 * amount (so the fee portion returns to the card on a full refund).
 * Partial → proportional share of the original gross charge.
 */
function computeStripeRefundAmount({ walletAmount, depositNet, depositGross, stripeRemaining }) {
  const net = Number(depositNet || 0);
  const gross = Number(depositGross || depositNet || 0);
  const remaining = Number(stripeRemaining);
  if (!(walletAmount > 0) || !(net > 0) || !(remaining > 0)) return 0;

  // Full remaining wallet refund → use the full remaining Stripe amount.
  if (walletAmount >= net) {
    return Math.min(remaining, Math.max(0, Math.round(remaining)));
  }

  // Partial: proportional to gross/net, never exceeding Stripe remaining.
  const proportional = Math.round((walletAmount * gross) / net);
  return Math.min(remaining, Math.max(1, proportional));
}

/**
 * Create a refund request and place an atomic wallet hold.
 * Caller must persist via commitCreateRefundPostgres afterwards.
 *
 * @throws {status, errorCode, message}
 */
function createRefundRequest(db, userId, fields) {
  ensureRefundCollections(db);
  const {
    depositTransactionId,
    amount,
    idempotencyKey,
    stripeRefundAmount,
    stripePaymentIntentId,
  } = fields;

  if (!depositTransactionId || !Number.isInteger(amount) || amount <= 0) {
    throw Object.assign(new Error('Invalid refund request'), { status: 400, errorCode: 'INVALID_REFUND_REQUEST' });
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw Object.assign(new Error('Idempotency key required'), { status: 400, errorCode: 'IDEMPOTENCY_KEY_REQUIRED' });
  }

  // Durable client-key replay (in-memory layer; Postgres layer also checks).
  const existingByKey = db.refundRequests.find(
    (r) => r.userId === userId && r.idempotencyKey === idempotencyKey
  );
  if (existingByKey) {
    return { replay: true, refund: existingByKey };
  }

  const depositTx = (db.transactions || []).find((t) => t.id === depositTransactionId);
  if (!depositTx || depositTx.type !== 'deposit') {
    throw Object.assign(new Error('Deposit not found'), { status: 404, errorCode: 'DEPOSIT_NOT_FOUND' });
  }

  const wallet = (db.wallets || []).find((w) => w.id === depositTx.toWalletId && w.userId === userId);
  if (!wallet) {
    throw Object.assign(new Error('Wallet not found'), { status: 404, errorCode: 'WALLET_NOT_FOUND' });
  }

  // Ownership: deposit must belong to this user's wallet.
  if (wallet.userId !== userId) {
    throw Object.assign(new Error('Deposit does not belong to this user'), { status: 403, errorCode: 'DEPOSIT_NOT_OWNED' });
  }

  if (depositTx.status !== 'completed') {
    throw Object.assign(new Error('Only completed deposits can be refunded'), { status: 400, errorCode: 'DEPOSIT_NOT_COMPLETED' });
  }

  if (!depositTx.stripeIntentId || !String(depositTx.stripeIntentId).startsWith('pi_')) {
    throw Object.assign(new Error('This deposit was not made via Stripe card and cannot be refunded to a card'), {
      status: 400, errorCode: 'NOT_STRIPE_DEPOSIT',
    });
  }

  if (stripePaymentIntentId && stripePaymentIntentId !== depositTx.stripeIntentId) {
    throw Object.assign(new Error('PaymentIntent mismatch'), { status: 400, errorCode: 'PAYMENT_INTENT_MISMATCH' });
  }

  if (!isWithinRefundWindow(depositTx)) {
    throw Object.assign(new Error(`Refund window of ${REFUND_WINDOW_DAYS} days has expired`), {
      status: 400, errorCode: 'REFUND_WINDOW_EXPIRED',
    });
  }

  const refundable = getWalletRefundableAmount(db, depositTx);
  if (amount > refundable) {
    throw Object.assign(
      new Error(`Refundable amount is ${refundable} ${depositTx.currency}; requested ${amount}`),
      { status: 400, errorCode: 'AMOUNT_EXCEEDS_REFUNDABLE', refundable }
    );
  }

  const currency = depositTx.currency;
  const balance = (wallet.balances || []).find((b) => b.currency === currency);
  if (!balance || balance.amount < amount) {
    throw Object.assign(new Error('Insufficient wallet balance to refund this deposit'), {
      status: 400, errorCode: 'INSUFFICIENT_BALANCE',
    });
  }

  const stripeAmt = Number(stripeRefundAmount);
  if (!Number.isInteger(stripeAmt) || stripeAmt <= 0) {
    throw Object.assign(new Error('Invalid Stripe refund amount'), { status: 400, errorCode: 'INVALID_STRIPE_AMOUNT' });
  }

  // ── Place hold: debit available, credit hold ──────────────────────────────
  const balanceBefore = balance.amount;
  balance.amount -= amount;
  if (!wallet.holdBalance) wallet.holdBalance = {};
  wallet.holdBalance[currency] = (wallet.holdBalance[currency] || 0) + amount;

  const now = Date.now();
  const refund = {
    id: uuidv4(),
    userId,
    walletId: wallet.id,
    depositTransactionId: depositTx.id,
    stripePaymentIntentId: depositTx.stripeIntentId,
    stripeRefundId: null,
    amount,
    stripeRefundAmount: stripeAmt,
    currency,
    status: 'requested',
    statusHistory: [{ status: 'requested', at: now, by: 'user' }],
    idempotencyKey,
    holdPlaced: true,
    holdReleased: false,
    walletDebited: false,
    failureReason: null,
    stripeStatus: null,
    reconciliationResult: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  db.refundRequests.push(refund);

  appendLedger(db, {
    type: 'deposit_refund_hold',
    refundRequestId: refund.id,
    userId,
    walletId: wallet.id,
    currency,
    amount,
    balanceBefore,
    balanceAfter: balance.amount,
    at: now,
    by: 'user',
    note: `refund_hold:${refund.id}:deposit:${depositTx.id}`,
  });

  return { replay: false, refund, depositTx };
}

function _findRefund(db, refundId) {
  ensureRefundCollections(db);
  const refund = db.refundRequests.find((r) => r.id === refundId);
  if (!refund) {
    throw Object.assign(new Error('Refund not found'), { status: 404, errorCode: 'REFUND_NOT_FOUND' });
  }
  return refund;
}

function _getWalletBalance(db, refund) {
  const wallet = (db.wallets || []).find((w) => w.id === refund.walletId);
  if (!wallet) {
    throw Object.assign(new Error('Wallet not found for refund'), { status: 404, errorCode: 'WALLET_NOT_FOUND' });
  }
  const balance = (wallet.balances || []).find((b) => b.currency === refund.currency);
  if (!balance) {
    // Ensure the currency row exists for restore paths.
    if (!wallet.balances) wallet.balances = [];
    const row = { currency: refund.currency, amount: 0 };
    wallet.balances.push(row);
    return { wallet, balance: row };
  }
  return { wallet, balance };
}

/**
 * After Stripe accepts the refund create call — move to pending / requires_action
 * / succeeded based on Stripe's returned status. Does NOT finalize the debit
 * unless Stripe status is already 'succeeded'.
 */
function markRefundSubmitted(db, refundId, { stripeRefundId, stripeStatus, by = 'system' }) {
  const refund = _findRefund(db, refundId);
  const normalized = String(stripeStatus || 'pending').toLowerCase();

  // Already fully settled — idempotent.
  if (refund.status === 'succeeded' && refund.walletDebited) {
    if (stripeRefundId) refund.stripeRefundId = refund.stripeRefundId || stripeRefundId;
    return refund;
  }

  // Stripe confirms success after a false local failure/cancel — recover.
  if (
    (refund.status === 'failed' || refund.status === 'cancelled')
    && normalized === 'succeeded'
  ) {
    return markRefundSucceeded(db, refundId, { stripeRefundId, by });
  }

  // Other terminal local states: do not regress on ambiguous Stripe status.
  if (refund.status === 'failed' || refund.status === 'cancelled') {
    if (stripeRefundId) refund.stripeRefundId = refund.stripeRefundId || stripeRefundId;
    refund.stripeStatus = stripeStatus || refund.stripeStatus;
    return refund;
  }

  if (refund.stripeRefundId && stripeRefundId && refund.stripeRefundId !== stripeRefundId) {
    throw Object.assign(new Error('Stripe refund ID conflict'), { status: 409, errorCode: 'STRIPE_REFUND_ID_CONFLICT' });
  }

  refund.stripeRefundId = stripeRefundId || refund.stripeRefundId;
  refund.stripeStatus = stripeStatus || refund.stripeStatus;

  let next;
  if (normalized === 'succeeded') next = 'succeeded';
  else if (normalized === 'failed' || normalized === 'canceled' || normalized === 'cancelled') next = 'failed';
  else if (normalized === 'requires_action') next = 'requires_action';
  else next = 'pending';

  if (refund.status !== next) {
    assertTransition(refund.status, next);
    recordStatusChange(refund, next, by);
  }

  if (next === 'succeeded') {
    _settleWalletForStripeSuccess(db, refund, by);
  } else if (next === 'failed') {
    _releaseHoldRestore(db, refund, by, `Stripe status: ${normalized}`);
  }

  return refund;
}

function _ensureDepositRefundTransaction(db, refund) {
  if (!Array.isArray(db.transactions)) db.transactions = [];
  const already = db.transactions.find(
    (t) => t.type === 'deposit_refund' && t.refundRequestId === refund.id
  );
  if (already) return already;
  const tx = {
    id: uuidv4(),
    type: 'deposit_refund',
    fromWalletId: refund.walletId,
    toWalletId: null,
    amount: refund.amount,
    currency: refund.currency,
    status: 'completed',
    direction: 'out',
    memo: 'Refund to original payment method',
    stripeIntentId: refund.stripePaymentIntentId,
    stripeRefundId: refund.stripeRefundId,
    refundRequestId: refund.id,
    depositTransactionId: refund.depositTransactionId,
    timestamp: Date.now(),
  };
  db.transactions.push(tx);
  return tx;
}

/**
 * Finalize: release hold WITHOUT restoring available balance.
 * Wallet was already decremented at hold time — this just clears the escrow.
 */
function _finalizeDebit(db, refund, by) {
  if (refund.walletDebited) return; // idempotent
  if (!refund.holdPlaced) return;

  const { wallet, balance } = _getWalletBalance(db, refund);
  if (!wallet.holdBalance) wallet.holdBalance = {};
  const holdBefore = wallet.holdBalance[refund.currency] || 0;
  if (!refund.holdReleased) {
    wallet.holdBalance[refund.currency] = Math.max(0, holdBefore - refund.amount);
    refund.holdReleased = true;
  }
  refund.walletDebited = true;
  refund.completedAt = Date.now();
  refund.updatedAt = Date.now();
  refund.failureReason = null;

  appendLedger(db, {
    type: 'deposit_refund_debit',
    refundRequestId: refund.id,
    userId: refund.userId,
    walletId: refund.walletId,
    currency: refund.currency,
    amount: refund.amount,
    balanceBefore: balance.amount,
    balanceAfter: balance.amount, // available already reduced at hold time
    at: Date.now(),
    by,
    note: `refund_debit:${refund.id}:pi:${refund.stripePaymentIntentId}`,
  });

  _ensureDepositRefundTransaction(db, refund);
}

/**
 * Recovery after a false hold-release: available was restored locally but Stripe
 * already succeeded. Permanently re-debit available. Idempotent via walletDebited.
 */
function _redebitAfterFalseRelease(db, refund, by) {
  if (refund.walletDebited) return;
  if (!refund.holdPlaced) return;

  const { wallet, balance } = _getWalletBalance(db, refund);
  const balanceBefore = Number(balance.amount || 0);
  if (balanceBefore < Number(refund.amount)) {
    refund.reconciliationResult = {
      conflict: 'insufficient_for_redebit',
      at: Date.now(),
      balanceBefore,
      required: refund.amount,
    };
    throw Object.assign(
      new Error(`Insufficient balance to re-debit refund ${refund.id}`),
      { status: 409, errorCode: 'INSUFFICIENT_FOR_REDEBIT' }
    );
  }

  balance.amount = balanceBefore - Number(refund.amount);
  if (!wallet.holdBalance) wallet.holdBalance = {};
  // Hold should already be zero after a false release; clear any residue.
  wallet.holdBalance[refund.currency] = Math.max(
    0,
    (wallet.holdBalance[refund.currency] || 0) - Number(refund.amount)
  );
  refund.holdReleased = true;
  refund.walletDebited = true;
  refund.completedAt = Date.now();
  refund.updatedAt = Date.now();
  refund.failureReason = null;
  refund.reconciliationResult = {
    ...(refund.reconciliationResult || {}),
    outcome: 'redebit_after_false_release',
    at: Date.now(),
    by,
  };

  appendLedger(db, {
    type: 'deposit_refund_redebit',
    refundRequestId: refund.id,
    userId: refund.userId,
    walletId: refund.walletId,
    currency: refund.currency,
    amount: refund.amount,
    balanceBefore,
    balanceAfter: balance.amount,
    at: Date.now(),
    by,
    note: `refund_redebit:${refund.id}:stripe:${refund.stripeRefundId || 'unknown'}:false_release_recovery`,
  });

  _ensureDepositRefundTransaction(db, refund);
}

/**
 * Settle wallet for Stripe success — normal finalize, or redebit if a prior
 * false failure already restored available funds.
 */
function _settleWalletForStripeSuccess(db, refund, by) {
  if (refund.walletDebited) return;
  const { wallet } = _getWalletBalance(db, refund);
  if (!wallet.holdBalance) wallet.holdBalance = {};
  const holdAmt = Number(wallet.holdBalance[refund.currency] || 0);
  const holdStillEscrowed = !refund.holdReleased && holdAmt >= Number(refund.amount);
  if (holdStillEscrowed) {
    _finalizeDebit(db, refund, by);
  } else {
    _redebitAfterFalseRelease(db, refund, by);
  }
}

/**
 * Release hold AND restore available balance (failure / cancel path).
 */
function _releaseHoldRestore(db, refund, by, reason) {
  if (refund.walletDebited) return; // already finalized — never restore
  if (refund.holdReleased) {
    refund.failureReason = reason || refund.failureReason;
    return;
  }

  const { wallet, balance } = _getWalletBalance(db, refund);
  const balanceBefore = balance.amount;
  balance.amount += refund.amount;
  if (!wallet.holdBalance) wallet.holdBalance = {};
  wallet.holdBalance[refund.currency] = Math.max(
    0,
    (wallet.holdBalance[refund.currency] || 0) - refund.amount
  );
  refund.holdReleased = true;
  refund.failureReason = reason || refund.failureReason;
  refund.completedAt = Date.now();
  refund.updatedAt = Date.now();

  appendLedger(db, {
    type: 'deposit_refund_release',
    refundRequestId: refund.id,
    userId: refund.userId,
    walletId: refund.walletId,
    currency: refund.currency,
    amount: refund.amount,
    balanceBefore,
    balanceAfter: balance.amount,
    at: Date.now(),
    by,
    note: `refund_release:${refund.id}:${reason || 'failed'}`,
  });
}

function markRefundSucceeded(db, refundId, { stripeRefundId, by = 'stripe_webhook' } = {}) {
  const refund = _findRefund(db, refundId);
  if (refund.status === 'succeeded' && refund.walletDebited) return refund;
  if (stripeRefundId) refund.stripeRefundId = refund.stripeRefundId || stripeRefundId;
  refund.stripeStatus = 'succeeded';
  if (refund.status !== 'succeeded') {
    const prior = refund.status;
    // Recovery: Stripe confirmed success after a false local failure/cancel
    // that restored available funds — transition and re-debit.
    assertTransition(prior, 'succeeded');
    recordStatusChange(
      refund,
      'succeeded',
      by,
      (prior === 'failed' || prior === 'cancelled' || refund.holdReleased)
        ? 'stripe_confirmed_success_after_local_failure'
        : undefined
    );
  }
  _settleWalletForStripeSuccess(db, refund, by);
  return refund;
}

function markRefundFailed(db, refundId, reason, { by = 'stripe_webhook', stripeStatus } = {}) {
  const refund = _findRefund(db, refundId);
  if (refund.status === 'succeeded' && refund.walletDebited) {
    // Out-of-order failure after success — never auto-restore; admin reconcile.
    refund.reconciliationResult = {
      conflict: 'failed_after_success',
      reason,
      at: Date.now(),
    };
    return refund;
  }
  if (refund.status === 'failed' || refund.status === 'cancelled') {
    _releaseHoldRestore(db, refund, by, reason);
    return refund;
  }
  assertTransition(refund.status, 'failed');
  recordStatusChange(refund, 'failed', by, reason);
  if (stripeStatus) refund.stripeStatus = stripeStatus;
  _releaseHoldRestore(db, refund, by, reason);
  return refund;
}

function markRefundCancelled(db, refundId, reason, { by = 'user' } = {}) {
  const refund = _findRefund(db, refundId);
  if (refund.status === 'cancelled') return refund;
  if (refund.status === 'succeeded' || refund.walletDebited) {
    throw Object.assign(new Error('Cannot cancel a completed refund'), {
      status: 409, errorCode: 'REFUND_ALREADY_SUCCEEDED',
    });
  }
  // Only allow cancel before Stripe accepted the refund (no stripeRefundId yet)
  // or from requires_action/pending via admin — user cancel only from requested.
  if (refund.stripeRefundId && by === 'user') {
    throw Object.assign(new Error('Refund already submitted to Stripe; wait for settlement or contact support'), {
      status: 409, errorCode: 'REFUND_ALREADY_SUBMITTED',
    });
  }
  assertTransition(refund.status, 'cancelled');
  recordStatusChange(refund, 'cancelled', by, reason);
  _releaseHoldRestore(db, refund, by, reason || 'cancelled');
  return refund;
}

/**
 * Apply a Stripe Refund object from a webhook (refund.created / updated / failed)
 * or from charge.refunded's refunds list entry.
 */
function applyStripeRefundObject(db, stripeRefund, eventType) {
  ensureRefundCollections(db);
  const stripeRefundId = stripeRefund.id;
  const metaRefundId = stripeRefund.metadata?.refundRequestId || stripeRefund.metadata?.egwalletRefundId;
  let refund = null;
  if (metaRefundId) {
    refund = db.refundRequests.find((r) => r.id === metaRefundId) || null;
  }
  if (!refund && stripeRefundId) {
    refund = db.refundRequests.find((r) => r.stripeRefundId === stripeRefundId) || null;
  }
  if (!refund) {
    return { handled: false, reason: 'no_matching_refund_request' };
  }

  const status = String(stripeRefund.status || '').toLowerCase();
  refund.stripeRefundId = refund.stripeRefundId || stripeRefundId;
  refund.stripeStatus = status;

  if (status === 'succeeded') {
    markRefundSucceeded(db, refund.id, { stripeRefundId, by: `stripe:${eventType}` });
    return { handled: true, reason: 'succeeded', refundId: refund.id };
  }
  if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
    markRefundFailed(db, refund.id, `Stripe ${eventType}: ${status}`, {
      by: `stripe:${eventType}`,
      stripeStatus: status,
    });
    return { handled: true, reason: status, refundId: refund.id };
  }
  // pending / requires_action
  if (refund.status === 'requested') {
    assertTransition(refund.status, status === 'requires_action' ? 'requires_action' : 'pending');
    recordStatusChange(refund, status === 'requires_action' ? 'requires_action' : 'pending', `stripe:${eventType}`);
  } else if (refund.status === 'pending' && status === 'requires_action') {
    assertTransition(refund.status, 'requires_action');
    recordStatusChange(refund, 'requires_action', `stripe:${eventType}`);
  }
  return { handled: true, reason: 'status_synced', refundId: refund.id };
}

function sanitizeRefundForResponse(refund) {
  if (!refund) return null;
  return {
    id: refund.id,
    userId: refund.userId,
    walletId: refund.walletId,
    depositTransactionId: refund.depositTransactionId,
    stripePaymentIntentId: refund.stripePaymentIntentId,
    stripeRefundId: refund.stripeRefundId,
    amount: refund.amount,
    stripeRefundAmount: refund.stripeRefundAmount,
    currency: refund.currency,
    status: refund.status,
    statusHistory: refund.statusHistory || [],
    holdPlaced: !!refund.holdPlaced,
    holdReleased: !!refund.holdReleased,
    walletDebited: !!refund.walletDebited,
    failureReason: refund.failureReason || null,
    stripeStatus: refund.stripeStatus || null,
    reconciliationResult: refund.reconciliationResult || null,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
    completedAt: refund.completedAt,
    // Never expose anything that looks like a destination card.
  };
}

module.exports = {
  VALID_TRANSITIONS,
  ACTIVE_OR_SUCCEEDED,
  REFUND_WINDOW_DAYS,
  REFUND_WINDOW_MS,
  getWalletRefundableAmount,
  sumClaimedRefundAmount,
  isWithinRefundWindow,
  computeStripeRefundAmount,
  createRefundRequest,
  markRefundSubmitted,
  markRefundSucceeded,
  markRefundFailed,
  markRefundCancelled,
  applyStripeRefundObject,
  sanitizeRefundForResponse,
  // Exported for focused unit tests of recovery paths.
  _settleWalletForStripeSuccess,
  _redebitAfterFalseRelease,
};
