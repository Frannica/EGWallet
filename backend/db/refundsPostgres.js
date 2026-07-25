'use strict';
/**
 * refundsPostgres.js
 *
 * Atomic PostgreSQL persistence for Stripe refund-to-original-card requests.
 * Mirrors withdrawalsPostgres.js hold/transition patterns:
 *   - Relative balance/hold deltas only (never absolute JSON overwrites)
 *   - FOR UPDATE row locks on wallet_balances / wallet_holds
 *   - Durable idempotency via idempotency_records
 *   - Durable webhook-event idempotency via stripe_webhook_events
 */

const { pool } = require('./pool');
const { lockWalletBalanceRow, lockWalletHoldRow } = require('./walletBalanceAlign');

function msToDate(ms) {
  return ms ? new Date(Number(ms)) : null;
}

function mapRefundRow(r) {
  return {
    id: r.id,
    user_id: r.userId,
    wallet_id: r.walletId,
    deposit_transaction_id: r.depositTransactionId,
    stripe_payment_intent_id: r.stripePaymentIntentId,
    stripe_refund_id: r.stripeRefundId || null,
    amount: Number(r.amount || 0),
    stripe_refund_amount: Number(r.stripeRefundAmount || 0),
    currency: r.currency,
    status: r.status || 'requested',
    status_history: JSON.stringify(Array.isArray(r.statusHistory) ? r.statusHistory : []),
    idempotency_key: r.idempotencyKey,
    hold_placed: !!r.holdPlaced,
    hold_released: !!r.holdReleased,
    wallet_debited: !!r.walletDebited,
    failure_reason: r.failureReason || null,
    stripe_status: r.stripeStatus || null,
    reconciliation_result: r.reconciliationResult ? JSON.stringify(r.reconciliationResult) : null,
    created_at: msToDate(r.createdAt) || new Date(),
    updated_at: msToDate(r.updatedAt) || new Date(),
    completed_at: msToDate(r.completedAt),
  };
}

async function upsertRefund(client, r) {
  const row = mapRefundRow(r);
  await client.query(
    `INSERT INTO refund_requests (
      id, user_id, wallet_id, deposit_transaction_id, stripe_payment_intent_id, stripe_refund_id,
      amount, stripe_refund_amount, currency, status, status_history, idempotency_key,
      hold_placed, hold_released, wallet_debited, failure_reason, stripe_status,
      reconciliation_result, created_at, updated_at, completed_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21
    )
    ON CONFLICT (id) DO UPDATE SET
      stripe_refund_id = EXCLUDED.stripe_refund_id,
      status = EXCLUDED.status,
      status_history = EXCLUDED.status_history,
      hold_placed = EXCLUDED.hold_placed,
      hold_released = EXCLUDED.hold_released,
      wallet_debited = EXCLUDED.wallet_debited,
      failure_reason = EXCLUDED.failure_reason,
      stripe_status = EXCLUDED.stripe_status,
      reconciliation_result = EXCLUDED.reconciliation_result,
      updated_at = EXCLUDED.updated_at,
      completed_at = EXCLUDED.completed_at`,
    [
      row.id, row.user_id, row.wallet_id, row.deposit_transaction_id,
      row.stripe_payment_intent_id, row.stripe_refund_id,
      row.amount, row.stripe_refund_amount, row.currency, row.status,
      row.status_history, row.idempotency_key,
      row.hold_placed, row.hold_released, row.wallet_debited,
      row.failure_reason, row.stripe_status, row.reconciliation_result,
      row.created_at, row.updated_at, row.completed_at,
    ]
  );
}

async function applyWalletBalanceHoldDelta(client, walletId, currency, { balanceDelta = 0, holdDelta = 0 } = {}) {
  await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  const balanceBefore = await lockWalletBalanceRow(client, walletId, currency);
  const holdBefore = await lockWalletHoldRow(client, walletId, currency);

  if (balanceDelta !== 0) {
    // Guard: never allow a negative available balance.
    if (balanceDelta < 0 && balanceBefore + balanceDelta < 0) {
      const err = new Error('Insufficient funds for refund hold');
      err.code = 'INSUFFICIENT_FUNDS';
      throw err;
    }
    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [balanceDelta, walletId, currency]
    );
  }
  if (holdDelta !== 0) {
    await client.query(
      'UPDATE wallet_holds SET amount = GREATEST(0, amount + $1) WHERE wallet_id = $2 AND currency = $3',
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

function deltaForRefundLedgerType(type, amount) {
  const amt = Number(amount || 0);
  switch (type) {
    case 'deposit_refund_hold':
      return { balanceDelta: -amt, holdDelta: amt };
    case 'deposit_refund_debit':
      // Hold released; available already reduced at hold time.
      return { balanceDelta: 0, holdDelta: -amt };
    case 'deposit_refund_release':
      return { balanceDelta: amt, holdDelta: -amt };
    default:
      return { balanceDelta: 0, holdDelta: 0 };
  }
}

async function insertRefundLedger(client, entry) {
  if (!entry) return;
  await client.query(
    `INSERT INTO ledger(
      id, refund_request_id, user_id, wallet_id, currency, type, amount,
      balance_before, balance_after, at, by_actor, note
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO NOTHING`,
    [
      entry.id,
      entry.refundRequestId || null,
      entry.userId,
      entry.walletId,
      entry.currency,
      entry.type,
      Number(entry.amount || 0),
      Number(entry.balanceBefore || 0),
      Number(entry.balanceAfter || 0),
      msToDate(entry.at || Date.now()),
      entry.by || null,
      entry.note || null,
    ]
  );
}

async function getDurableRefundIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function commitCreateRefundPostgres({
  stateDb,
  refund,
  userId,
  clientKey,
  responseBody,
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

    // Concurrent over-refund guard: lock the deposit row, then sum active refunds.
    await client.query(
      'SELECT id FROM transactions WHERE id = $1 FOR UPDATE',
      [refund.depositTransactionId]
    );
    const claimed = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS claimed
         FROM refund_requests
        WHERE deposit_transaction_id = $1
          AND status IN ('requested','pending','requires_action','succeeded')`,
      [refund.depositTransactionId]
    );
    const deposit = await client.query(
      'SELECT amount FROM transactions WHERE id = $1',
      [refund.depositTransactionId]
    );
    const depositNet = Number(deposit.rows[0]?.amount || 0);
    const alreadyClaimed = Number(claimed.rows[0]?.claimed || 0);
    if (alreadyClaimed + Number(refund.amount) > depositNet) {
      await client.query('ROLLBACK');
      return { overRefund: true, refundable: Math.max(0, depositNet - alreadyClaimed) };
    }

    const balanceBefore = await lockWalletBalanceRow(client, refund.walletId, refund.currency, {
      stateDb, pendingDebit: refund.amount,
    });
    if (balanceBefore < Number(refund.amount)) {
      await client.query('ROLLBACK');
      return { insufficientFunds: true };
    }

    await applyWalletBalanceHoldDelta(client, refund.walletId, refund.currency, {
      balanceDelta: -Number(refund.amount),
      holdDelta: Number(refund.amount),
    });

    await upsertRefund(client, refund);

    const holdLedger = (stateDb.ledger || []).find(
      (l) => l.refundRequestId === refund.id && l.type === 'deposit_refund_hold'
    );
    await insertRefundLedger(client, holdLedger);

    if (clientKey) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(responseBody)]
      );
    }

    await client.query('COMMIT');
    return { replay: false, insufficientFunds: false, overRefund: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (error.code === '23505' && clientKey) {
      const replay = await getDurableRefundIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Persist a refund status transition and apply the matching relative
 * balance/hold delta based on newly appended ledger entries.
 */
async function commitRefundTransitionPostgres({
  stateDb,
  refund,
  expectedStatus,
  ledgerTypes = [],
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      'SELECT id, status, wallet_debited, hold_released FROM refund_requests WHERE id = $1 FOR UPDATE',
      [refund.id]
    );
    if (lock.rowCount === 0) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }
    if (expectedStatus && lock.rows[0].status !== expectedStatus) {
      // Allow idempotent re-entry when already at the target terminal status.
      if (lock.rows[0].status === refund.status &&
          (refund.status === 'succeeded' || refund.status === 'failed' || refund.status === 'cancelled')) {
        await client.query('COMMIT');
        return { notFound: false, conflict: false, alreadyApplied: true };
      }
      await client.query('ROLLBACK');
      return { notFound: false, conflict: true };
    }

    // Idempotency: if Postgres already finalized, skip money movement.
    const pgDebited = lock.rows[0].wallet_debited;
    const pgReleased = lock.rows[0].hold_released;

    for (const type of ledgerTypes) {
      if (type === 'deposit_refund_debit' && pgDebited) continue;
      if (type === 'deposit_refund_release' && pgReleased) continue;
      const entry = (stateDb.ledger || [])
        .filter((l) => l.refundRequestId === refund.id && l.type === type)
        .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0];
      if (!entry) continue;
      const delta = deltaForRefundLedgerType(type, refund.amount);
      if (delta.balanceDelta !== 0 || delta.holdDelta !== 0) {
        await applyWalletBalanceHoldDelta(client, refund.walletId, refund.currency, delta);
      }
      await insertRefundLedger(client, entry);
    }

    await upsertRefund(client, refund);

    // Persist the user-visible deposit_refund transaction if present.
    const tx = (stateDb.transactions || []).find(
      (t) => t.type === 'deposit_refund' && t.refundRequestId === refund.id
    );
    if (tx) {
      await client.query(
        `INSERT INTO transactions (
          id, from_wallet_id, to_wallet_id, amount, currency, type, status, memo,
          direction, stripe_intent_id, timestamp
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING`,
        [
          tx.id,
          tx.fromWalletId || null,
          tx.toWalletId || null,
          Number(tx.amount || 0),
          tx.currency,
          tx.type,
          tx.status,
          tx.memo || null,
          tx.direction || 'out',
          tx.stripeIntentId || null,
          msToDate(tx.timestamp || Date.now()),
        ]
      );
    }

    await client.query('COMMIT');
    return { notFound: false, conflict: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

async function reserveStripeWebhookEvent({ eventId, eventType }) {
  const result = await pool.query(
    `INSERT INTO stripe_webhook_events (event_id, event_type)
     VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, eventType]
  );
  return result.rowCount > 0;
}

async function markStripeWebhookEventProcessed(eventId) {
  await pool.query(
    'UPDATE stripe_webhook_events SET processed_at = NOW() WHERE event_id = $1',
    [eventId]
  );
}

async function getRefundById(id) {
  const result = await pool.query('SELECT * FROM refund_requests WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function getRefundByStripeRefundId(stripeRefundId) {
  const result = await pool.query(
    'SELECT * FROM refund_requests WHERE stripe_refund_id = $1 LIMIT 1',
    [stripeRefundId]
  );
  return result.rows[0] || null;
}

async function sumActiveRefundsForDeposit(depositTransactionId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS claimed
       FROM refund_requests
      WHERE deposit_transaction_id = $1
        AND status IN ('requested','pending','requires_action','succeeded')`,
    [depositTransactionId]
  );
  return Number(result.rows[0]?.claimed || 0);
}

async function listRefundsPostgres({ userId, status, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  params.push(Math.max(0, Number(offset) || 0));
  const result = await pool.query(
    `SELECT * FROM refund_requests ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

module.exports = {
  upsertRefund,
  applyWalletBalanceHoldDelta,
  deltaForRefundLedgerType,
  getDurableRefundIdempotency,
  commitCreateRefundPostgres,
  commitRefundTransitionPostgres,
  reserveStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  getRefundById,
  getRefundByStripeRefundId,
  sumActiveRefundsForDeposit,
  listRefundsPostgres,
};
