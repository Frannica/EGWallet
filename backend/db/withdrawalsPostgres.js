'use strict';

const { pool } = require('./pool');
const { saveAppState } = require('./appStateStore');
const { lockWalletBalanceRow, lockWalletHoldRow } = require('./walletBalanceAlign');

function msToDate(ms) {
  return ms ? new Date(Number(ms)) : null;
}

function mapWithdrawalRow(w) {
  return {
    id: w.id,
    idempotency_key: w.idempotencyKey || w.id,
    user_id: w.userId,
    wallet_id: w.walletId,
    amount: Number(w.amount || 0),
    currency: w.currency || 'USD',
    fee_amount: w.feeAmount === undefined ? null : Number(w.feeAmount),
    fee_rate: w.feeRate === undefined ? null : String(w.feeRate),
    net_payout: w.netPayout === undefined ? null : Number(w.netPayout),
    method: w.method || null,
    is_international: !!w.isInternational,
    country: w.country || null,
    bank_code: w.bankCode || null,
    branch_code: w.branchCode || null,
    bank_name: w.bankName || null,
    account_number: w.accountNumber || null,
    account_holder_name: w.accountHolderName || null,
    iban: w.iban || null,
    swift_bic: w.swiftBic || null,
    account_mask: w.accountMask || null,
    bank_name_display: w.bankNameDisplay || null,
    status: w.status || 'pending_review',
    status_history: JSON.stringify(Array.isArray(w.statusHistory) ? w.statusHistory : []),
    hold_released: !!w.holdReleased,
    refund_issued: !!w.refundIssued,
    payout_attempts: Number(w.payoutAttempts || 0),
    payout_provider: w.payoutProvider || null,
    payout_reference: w.payoutReference || null,
    payout_dispatch_ref: w.payoutDispatchRef || null,
    payout_error: w.payoutError || null,
    processed_by: w.processedBy || null,
    internal_note: w.internalNote || null,
    created_at: msToDate(w.createdAt) || new Date(),
    approved_at: msToDate(w.approvedAt),
    paid_at: msToDate(w.paidAt),
    failed_at: msToDate(w.failedAt),
    reversed_at: msToDate(w.reversedAt),
  };
}

async function upsertWithdrawal(client, w) {
  const row = mapWithdrawalRow(w);
  await client.query(
    `INSERT INTO withdrawals (
      id, idempotency_key, user_id, wallet_id, amount, currency, fee_amount, fee_rate, net_payout,
      method, is_international, country, bank_code, branch_code, bank_name, account_number,
      account_holder_name, iban, swift_bic, account_mask, bank_name_display, status, status_history,
      hold_released, refund_issued, payout_attempts, payout_provider, payout_reference, payout_dispatch_ref,
      payout_error, processed_by, internal_note, created_at, approved_at, paid_at, failed_at, reversed_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,
      $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      status_history = EXCLUDED.status_history,
      hold_released = EXCLUDED.hold_released,
      refund_issued = EXCLUDED.refund_issued,
      payout_attempts = EXCLUDED.payout_attempts,
      payout_provider = EXCLUDED.payout_provider,
      payout_reference = EXCLUDED.payout_reference,
      payout_dispatch_ref = EXCLUDED.payout_dispatch_ref,
      payout_error = EXCLUDED.payout_error,
      processed_by = EXCLUDED.processed_by,
      internal_note = EXCLUDED.internal_note,
      approved_at = EXCLUDED.approved_at,
      paid_at = EXCLUDED.paid_at,
      failed_at = EXCLUDED.failed_at,
      reversed_at = EXCLUDED.reversed_at`,
    [
      row.id,
      row.idempotency_key,
      row.user_id,
      row.wallet_id,
      row.amount,
      row.currency,
      row.fee_amount,
      row.fee_rate,
      row.net_payout,
      row.method,
      row.is_international,
      row.country,
      row.bank_code,
      row.branch_code,
      row.bank_name,
      row.account_number,
      row.account_holder_name,
      row.iban,
      row.swift_bic,
      row.account_mask,
      row.bank_name_display,
      row.status,
      row.status_history,
      row.hold_released,
      row.refund_issued,
      row.payout_attempts,
      row.payout_provider,
      row.payout_reference,
      row.payout_dispatch_ref,
      row.payout_error,
      row.processed_by,
      row.internal_note,
      row.created_at,
      row.approved_at,
      row.paid_at,
      row.failed_at,
      row.reversed_at,
    ]
  );
}

/**
 * Applies a RELATIVE delta to the wallet's available balance and/or hold
 * escrow, using Postgres as the sole source of truth (locked via
 * lockWalletBalanceRow / lockWalletHoldRow). This replaces the old
 * `upsertWalletRows`, which absolute-overwrote both columns with values
 * computed from the JSON app_metadata blob — meaning a stale JSON snapshot
 * could silently roll back an already-correct Postgres balance/hold. A
 * relative delta can never do that: it only ever applies the exact
 * documented change for this withdrawal lifecycle step.
 */
async function applyWalletBalanceHoldDelta(client, walletId, currency, { balanceDelta = 0, holdDelta = 0 } = {}) {
  await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  const balanceBefore = await lockWalletBalanceRow(client, walletId, currency);
  const holdBefore = await lockWalletHoldRow(client, walletId, currency);

  if (balanceDelta !== 0) {
    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [balanceDelta, walletId, currency]
    );
  }
  if (holdDelta !== 0) {
    await client.query(
      'UPDATE wallet_holds SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [holdDelta, walletId, currency]
    );
  }

  return {
    balanceBefore,
    balanceAfter: balanceBefore + Number(balanceDelta),
    holdBefore,
    holdAfter: Math.max(0, holdBefore + Number(holdDelta)),
  };
}

/**
 * Maps a withdrawal-lifecycle ledger entry (appended by withdrawalEngine.js
 * in the same in-memory mutation that produced `withdrawal`) to the exact
 * relative balance/hold delta it represents. This is how
 * commitWithdrawalTransitionPostgres knows what actually changed without
 * ever trusting an absolute JSON-derived balance snapshot.
 */
function deltaForLedgerType(type, amount) {
  const amt = Number(amount || 0);
  switch (type) {
    case 'withdrawal_hold':
      // Funds move from available balance into hold escrow.
      return { balanceDelta: -amt, holdDelta: amt };
    case 'withdrawal_paid':
      // Provider confirmed payout — hold is released, balance was already debited at hold time.
      return { balanceDelta: 0, holdDelta: -amt };
    case 'withdrawal_failed_refund':
    case 'withdrawal_reversed':
      // Hold released back to available balance.
      return { balanceDelta: amt, holdDelta: -amt };
    default:
      // Unknown/no-op ledger type (e.g. a pure status-only transition with no
      // money movement) — do not touch balance or hold.
      return { balanceDelta: 0, holdDelta: 0 };
  }
}

async function getDurableWithdrawalIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function commitCreateWithdrawalPostgres({
  stateDb,
  withdrawal,
  userId,
  clientKey,
  responseBody,
  userLimitTracking,
  skipRuntimeStateSync = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (clientKey) {
      const replay = await client.query(
        'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
        [clientKey, userId]
      );
      if (replay.rowCount > 0) {
        await client.query('COMMIT');
        return { replay: true, response: replay.rows[0].response };
      }
    }

    // Postgres is the sole source of truth for the pre-operation balance
    // (JSON only ever seeds a brand-new, never-before-seen row).
    const balanceBefore = await lockWalletBalanceRow(client, withdrawal.walletId, withdrawal.currency, {
      stateDb, pendingDebit: withdrawal.amount,
    });
    if (balanceBefore < Number(withdrawal.amount)) {
      await client.query('ROLLBACK');
      return { insufficientFunds: true };
    }

    // Hold creation: debit available balance, credit hold escrow — a pure
    // relative delta, never an absolute overwrite derived from JSON.
    await applyWalletBalanceHoldDelta(client, withdrawal.walletId, withdrawal.currency, {
      balanceDelta: -Number(withdrawal.amount),
      holdDelta: Number(withdrawal.amount),
    });

    await upsertWithdrawal(client, withdrawal);

    const holdLedger = (stateDb.ledger || []).find((l) => l.withdrawalId === withdrawal.id && l.type === 'withdrawal_hold');
    if (holdLedger) {
      await client.query(
        `INSERT INTO ledger(
          id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        ) ON CONFLICT (id) DO NOTHING`,
        [
          holdLedger.id,
          holdLedger.withdrawalId || null,
          holdLedger.userId,
          holdLedger.walletId,
          holdLedger.currency,
          holdLedger.type,
          Number(holdLedger.amount || 0),
          Number(holdLedger.balanceBefore || 0),
          Number(holdLedger.balanceAfter || 0),
          msToDate(holdLedger.at || holdLedger.timestamp || Date.now()),
          holdLedger.by || null,
          holdLedger.note || null,
        ]
      );
    }

    if (userLimitTracking) {
      await client.query(
        'UPDATE users SET limit_tracking = $1::jsonb WHERE id = $2',
        [JSON.stringify(userLimitTracking), userId]
      );
    }

    if (clientKey) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(responseBody)]
      );
    }

    await client.query('COMMIT');
    return { replay: false, insufficientFunds: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && clientKey) {
      const replay = await getDurableWithdrawalIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function commitWithdrawalTransitionPostgres({
  stateDb,
  withdrawal,
  expectedStatus,
  skipRuntimeStateSync = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      'SELECT id, status FROM withdrawals WHERE id = $1 FOR UPDATE',
      [withdrawal.id]
    );
    if (lock.rowCount === 0) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }
    if (expectedStatus && lock.rows[0].status !== expectedStatus) {
      await client.query('ROLLBACK');
      return { notFound: false, conflict: true };
    }

    // Determine the exact relative delta from the ledger entry this
    // transition just appended (withdrawalEngine.js), rather than trusting
    // an absolute "next balance" computed from the JSON blob. This is the
    // fix for the dual-write desync risk: Postgres can never be rolled
    // backwards by a stale JSON snapshot, because it is never overwritten —
    // only ever adjusted by the documented delta for this exact transition.
    //
    // IMPORTANT: not every transition appends a new ledger entry (e.g.
    // approved/processing are pure status changes with no money movement).
    // In that case `latest` is the same entry a *previous* call already
    // applied and persisted — re-applying its delta would double-count the
    // hold. Guard by checking whether this exact ledger row id has already
    // been committed to Postgres; only apply the delta and insert the row
    // the first time we see it.
    const ledgers = (stateDb.ledger || []).filter((l) => l.withdrawalId === withdrawal.id);
    const latest = ledgers[ledgers.length - 1];
    let alreadyApplied = true;
    if (latest) {
      const existing = await client.query('SELECT 1 FROM ledger WHERE id = $1', [latest.id]);
      alreadyApplied = existing.rowCount > 0;
    }

    if (latest && !alreadyApplied) {
      const delta = deltaForLedgerType(latest.type, latest.amount);
      await applyWalletBalanceHoldDelta(client, withdrawal.walletId, withdrawal.currency, delta);
      await client.query(
        `INSERT INTO ledger(
          id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        ) ON CONFLICT (id) DO NOTHING`,
        [
          latest.id,
          latest.withdrawalId || null,
          latest.userId,
          latest.walletId,
          latest.currency,
          latest.type,
          Number(latest.amount || 0),
          Number(latest.balanceBefore || 0),
          Number(latest.balanceAfter || 0),
          msToDate(latest.at || latest.timestamp || Date.now()),
          latest.by || null,
          latest.note || null,
        ]
      );
    } else {
      // No new money-moving ledger entry for this transition (e.g. a pure
      // status change) — still touch the row so concurrent transitions on
      // the same wallet/currency serialize correctly.
      await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [withdrawal.walletId]);
    }

    await upsertWithdrawal(client, withdrawal);

    await client.query('COMMIT');
    return { notFound: false, conflict: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function upsertPayoutLockPostgres({ withdrawalId, pid, claimedAt, expiresAt }) {
  await pool.query(
    `INSERT INTO payout_locks(withdrawal_id, pid, claimed_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (withdrawal_id) DO UPDATE SET
       pid = EXCLUDED.pid,
       claimed_at = EXCLUDED.claimed_at,
       expires_at = EXCLUDED.expires_at`,
    [withdrawalId, pid, msToDate(claimedAt), msToDate(expiresAt)]
  );
}

async function releasePayoutLockPostgres({ withdrawalId }) {
  await pool.query('DELETE FROM payout_locks WHERE withdrawal_id = $1', [withdrawalId]);
}

async function commitWithdrawalStateUpdate(stateDb, withdrawal, expectedStatus) {
  const pgResult = await commitWithdrawalTransitionPostgres({
    stateDb,
    withdrawal,
    expectedStatus,
  });
  if (!pgResult.conflict && !pgResult.notFound) {
    saveAppState(stateDb);
  }
  return pgResult;
}

module.exports = {
  getDurableWithdrawalIdempotency,
  commitCreateWithdrawalPostgres,
  commitWithdrawalTransitionPostgres,
  commitWithdrawalStateUpdate,
  upsertPayoutLockPostgres,
  releasePayoutLockPostgres,
};
