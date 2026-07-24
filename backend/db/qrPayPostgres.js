'use strict';
/**
 * qrPayPostgres.js
 *
 * Moves QR Payments (POST /qr/pay) onto the relational PostgreSQL ledger,
 * the same way P2P sends, exchanges, deposits, and payment-request payments
 * already are. Before this module existed, /qr/pay only ever mutated the
 * JSON app_metadata blob — a real money-moving endpoint with zero relational
 * ledger backing, no row-level locking, and no durable idempotency. That is
 * the exact "money-data desynchronization" risk this migration eliminates.
 *
 * Guarantees:
 *  - Atomic sender debit + recipient credit (single Postgres transaction).
 *  - Postgres is the sole source of truth for balances (see walletBalanceAlign.js).
 *  - Durable idempotency via idempotency_records (survives process restart).
 *  - For dynamic (request-linked) QR payments: the payment_requests row is
 *    locked with SELECT ... FOR UPDATE and its status is checked, so the
 *    same single-use QR/payment request can never be paid twice, even under
 *    concurrent requests from multiple app instances (duplicate-scan
 *    protection).
 *  - Any failure rolls back the whole transaction — no partial debit/credit.
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { lockWalletBalanceRow } = require('./walletBalanceAlign');
const { msToDate, upsertRuntimeWalletMetadata } = require('./runtimeWalletSync');

function mapTxRow(tx) {
  return {
    id: tx.id,
    from_wallet_id: tx.fromWalletId,
    to_wallet_id: tx.toWalletId,
    amount: tx.amount,
    currency: tx.currency,
    debit_amount: tx.amount,
    debit_currency: tx.currency,
    sender_cross_currency: false,
    received_amount: tx.receivedAmount === undefined ? tx.amount : tx.receivedAmount,
    received_currency: tx.receivedCurrency || tx.currency,
    was_converted: !!tx.wasConverted,
    fx_fee_amount: 0,
    send_fee_amount: 0,
    type: tx.type || 'qr_payment',
    status: tx.status || 'completed',
    memo: tx.memo || '',
    direction: tx.direction || null,
    stripe_intent_id: null,
    fee_amount: null,
    fee_rate: null,
    gross_amount: null,
    timestamp: msToDate(tx.timestamp),
  };
}

async function getDurableQrPayIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function syncRuntimeQrGraph(client, { stateDb, userId, fromWalletId, toWalletId }) {
  if (!stateDb) return;
  const wallets = stateDb.wallets || [];
  const fromWallet = wallets.find((w) => w.id === fromWalletId);
  const toWallet = wallets.find((w) => w.id === toWalletId);
  if (fromWallet) await upsertRuntimeWalletMetadata(client, fromWallet);
  if (toWallet) await upsertRuntimeWalletMetadata(client, toWallet);
}

/**
 * @param {object} opts
 * @param {string} opts.fromWalletId
 * @param {string} opts.toWalletId
 * @param {string} opts.currency
 * @param {number} opts.amount          - minor units
 * @param {object} opts.tx              - transaction record to persist (id, timestamp, memo, ...)
 * @param {string} opts.clientKey       - idempotency key
 * @param {string} opts.userId          - payer's user id
 * @param {object} opts.responseBody    - response to store for idempotent replay
 * @param {object} [opts.senderLimitTracking]
 * @param {object} [opts.stateDb]       - in-memory JSON state (post-mutation), for graph backfill only
 * @param {string} [opts.requestId]     - payment_requests.id for dynamic (single-use) QR payments
 */
async function commitQrPayPostgres({
  fromWalletId,
  toWalletId,
  currency,
  amount,
  tx,
  clientKey,
  userId,
  responseBody,
  senderLimitTracking,
  stateDb,
  requestId,
  recipientUserId,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await syncRuntimeQrGraph(client, { stateDb, userId, fromWalletId, toWalletId });

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

    // Dynamic QR — lock the linked payment_request/qr_codes row FIRST so a
    // concurrent duplicate scan of the same single-use QR is rejected before
    // any money moves, not after.
    if (requestId) {
      const reqRow = await client.query(
        'SELECT id, status FROM payment_requests WHERE id = $1 FOR UPDATE',
        [requestId]
      );
      if (reqRow.rowCount === 0) {
        await client.query('ROLLBACK');
        return { requestNotFound: true };
      }
      if (reqRow.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        return { alreadyProcessed: true };
      }
    }

    await client.query(
      'SELECT id FROM wallets WHERE id IN ($1, $2) ORDER BY id FOR UPDATE',
      [fromWalletId, toWalletId]
    );

    // Postgres is the sole source of truth for the pre-operation balance.
    const debitBefore = await lockWalletBalanceRow(client, fromWalletId, currency, {
      stateDb, pendingDebit: amount,
    });
    if (debitBefore < Number(amount)) {
      await client.query('ROLLBACK');
      return { insufficientFunds: true };
    }

    const creditBefore = await lockWalletBalanceRow(client, toWalletId, currency, {
      stateDb, pendingCredit: amount,
    });

    await client.query(
      'UPDATE wallet_balances SET amount = amount - $1 WHERE wallet_id = $2 AND currency = $3',
      [amount, fromWalletId, currency]
    );
    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [amount, toWalletId, currency]
    );

    const txRow = mapTxRow(tx);
    await client.query(
      `INSERT INTO transactions (
        id, from_wallet_id, to_wallet_id, amount, currency, debit_amount, debit_currency,
        sender_cross_currency, received_amount, received_currency, was_converted, fx_fee_amount,
        send_fee_amount, type, status, memo, direction, stripe_intent_id, fee_amount, fee_rate,
        gross_amount, timestamp
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
      )`,
      [
        txRow.id, txRow.from_wallet_id, txRow.to_wallet_id, txRow.amount, txRow.currency,
        txRow.debit_amount, txRow.debit_currency, txRow.sender_cross_currency,
        txRow.received_amount, txRow.received_currency, txRow.was_converted, txRow.fx_fee_amount,
        txRow.send_fee_amount, txRow.type, txRow.status, txRow.memo, txRow.direction,
        txRow.stripe_intent_id, txRow.fee_amount, txRow.fee_rate, txRow.gross_amount, txRow.timestamp,
      ]
    );

    await client.query(
      `INSERT INTO ledger(
        id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
      ) VALUES
        ($1, NULL, $2, $3, $4, 'qr_payment_debit',  $5, $6, $7, $8, 'system', $9),
        ($10, NULL, $11, $12, $13, 'qr_payment_credit', $14, $15, $16, $17, 'system', $18)`,
      [
        uuidv4(), userId, fromWalletId, currency, amount, debitBefore, debitBefore - Number(amount),
        txRow.timestamp, `qr:${txRow.id}`,
        uuidv4(), recipientUserId || userId, toWalletId, currency, amount, creditBefore, creditBefore + Number(amount),
        txRow.timestamp, `qr:${txRow.id}`,
      ]
    );

    if (requestId) {
      await client.query(
        `UPDATE payment_requests
         SET status = 'paid', paid_at = NOW(), paid_by = $1, transaction_id = $2
         WHERE id = $3`,
        [userId, txRow.id, requestId]
      );
      // Mark the qr_codes row used (if the caller registered one for this dynamic QR).
      await client.query(
        `UPDATE qr_codes SET payload = payload || '{"used": true}'::jsonb WHERE id = $1`,
        [requestId]
      ).catch(() => {}); // qr_codes row is best-effort/legacy — payment_requests.status is authoritative.
    }

    if (clientKey) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(responseBody)]
      );
    }

    if (senderLimitTracking) {
      await client.query(
        'UPDATE users SET limit_tracking = $1::jsonb WHERE id = $2',
        [JSON.stringify(senderLimitTracking), userId]
      );
    }

    await client.query('COMMIT');
    return {
      replay: false,
      insufficientFunds: false,
      debitWalletBalanceAfter: debitBefore - Number(amount),
      creditWalletBalanceAfter: creditBefore + Number(amount),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && clientKey) {
      const replay = await getDurableQrPayIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getDurableQrPayIdempotency,
  commitQrPayPostgres,
};
