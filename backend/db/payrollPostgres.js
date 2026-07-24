'use strict';
/**
 * payrollPostgres.js
 *
 * Moves payroll money movement (POST /employer/bulk-payment, and the
 * payroll_request branch of POST /payment-requests/:id/pay) onto the
 * relational PostgreSQL ledger and replaces the old in-memory 24-hour
 * duplicate-payment scan with a real, durable, database-enforced
 * UNIQUE(employer_id, worker_id, pay_period) constraint on payroll_payments.
 *
 * Why the old approach was unsafe:
 *  - It scanned db.transactions / db.paymentRequests in memory with no row
 *    lock, so two concurrent requests (one via bulk, one via request-pay)
 *    could both read "not yet paid" and both proceed — a genuine
 *    double-payment race, not just a UX inconvenience.
 *  - A rolling 24-hour window is neither a real identity for a payroll run
 *    nor durable: two legitimate runs of the *same* pay period more than 24h
 *    apart could double-pay a worker; conversely, distinct legitimate runs
 *    within 24h of each other were incorrectly blocked.
 *
 * The fix: every payroll credit — whichever endpoint it comes through —
 * first attempts `INSERT ... ON CONFLICT (employer_id, worker_id, pay_period)
 * DO NOTHING` into payroll_payments inside the SAME database transaction as
 * the balance mutation. If the row already exists, the insert is skipped and
 * the caller is told the worker was already paid for that period; no
 * balance is touched. This is correct under arbitrary concurrency, process
 * restarts, and retries, and it is shared by both payroll payment paths so
 * bulk→request and request→bulk double-pays are both blocked.
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { lockWalletBalanceRow } = require('./walletBalanceAlign');
const {
  msToDate,
  upsertRuntimeWalletMetadata,
  upsertRuntimeUser,
} = require('./runtimeWalletSync');

// NOTE: employer identifiers are app-level strings like `EMP-<uuid>`, not
// Postgres UUIDs (see backend/index.js /employer/register), and the
// `employers` table has no other writer in this codebase — the employer/
// payroll domain still lives in the JSON app_metadata blob. payroll_payments
// therefore stores employer_id as plain TEXT with no foreign key, and this
// module never writes to the `employers` table.

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
    received_amount: tx.amount,
    received_currency: tx.currency,
    was_converted: false,
    fx_fee_amount: 0,
    send_fee_amount: 0,
    type: 'payroll',
    status: 'completed',
    memo: tx.memo || '',
    direction: null,
    stripe_intent_id: null,
    fee_amount: null,
    fee_rate: null,
    gross_amount: null,
    timestamp: msToDate(tx.timestamp),
  };
}

/**
 * Attempts to reserve the (employer, worker, pay_period) slot. Returns true
 * if this call won the reservation (payment may proceed), false if a payroll
 * payment for that worker/period already exists (payment must be skipped).
 * Must be called inside an open transaction on `client`.
 */
async function reservePayrollPayment(client, { paymentId, employerId, workerId, payPeriod, currency, amount, source, batchId, paymentRequestId }) {
  // transaction_id is intentionally left NULL here — the transactions row is
  // created AFTER this reservation succeeds (see commitPayrollBatchPostgres /
  // commitPaymentRequestPayPostgres), so it can't be referenced yet. It is
  // attached immediately afterward via linkPayrollPaymentTransaction().
  const result = await client.query(
    `INSERT INTO payroll_payments(
       id, employer_id, worker_id, pay_period, currency, amount, source, batch_id, payment_request_id, transaction_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NOW())
     ON CONFLICT (employer_id, worker_id, pay_period) DO NOTHING
     RETURNING id`,
    [paymentId, employerId, workerId, payPeriod, currency, amount, source, batchId || null, paymentRequestId || null]
  );
  return result.rowCount > 0;
}

/** Attaches the settled transaction id to a reserved payroll_payments row. */
async function linkPayrollPaymentTransaction(client, paymentId, transactionId) {
  await client.query('UPDATE payroll_payments SET transaction_id = $1 WHERE id = $2', [transactionId, paymentId]);
}

/**
 * Bulk payroll disbursement — one Postgres transaction for the whole batch,
 * but each item gets its own SAVEPOINT so that one worker's insufficient
 * funds, missing wallet row, or duplicate-payment guard hit cannot corrupt or
 * roll back any other worker's already-applied payment in the same batch.
 *
 * @returns {Promise<{results: Array<object>}>}
 */
async function commitPayrollBatchPostgres({ employerId, fundingWalletId, items, batchId, payPeriod, stateDb }) {
  const client = await pool.connect();
  const results = [];
  try {
    await client.query('BEGIN');

    if (stateDb) {
      // Backfill-on-first-touch for the funding wallet row (its owning users
      // row is backfilled too, via upsertRuntimeWalletMetadata's FK target).
      const fundingWallet = (stateDb.wallets || []).find((w) => w.id === fundingWalletId);
      if (fundingWallet) {
        const fundingOwnerUser = (stateDb.users || []).find((u) => u.id === fundingWallet.userId);
        if (fundingOwnerUser) await upsertRuntimeUser(client, fundingOwnerUser);
        await upsertRuntimeWalletMetadata(client, fundingWallet);
      }
    }

    for (const item of items) {
      await client.query('SAVEPOINT payroll_item');
      try {
        if (stateDb) {
          const workerUser = (stateDb.users || []).find((u) => u.id === item.workerId);
          if (workerUser) await upsertRuntimeUser(client, workerUser);
          const workerWallet = (stateDb.wallets || []).find((w) => w.id === item.walletId);
          if (workerWallet) await upsertRuntimeWalletMetadata(client, workerWallet);
        }

        const txId = uuidv4();
        const paymentId = uuidv4();
        const itemPayPeriod = item.payPeriod || payPeriod;

        const reserved = await reservePayrollPayment(client, {
          paymentId,
          employerId,
          workerId: item.workerId,
          payPeriod: itemPayPeriod,
          currency: item.currency,
          amount: item.amount,
          source: 'bulk',
          batchId,
        });
        if (!reserved) {
          await client.query('RELEASE SAVEPOINT payroll_item');
          results.push({ workerId: item.workerId, workerEmail: item.workerEmail, status: 'already_paid', amount: item.amount, currency: item.currency });
          continue;
        }

        const fundingBefore = await lockWalletBalanceRow(client, fundingWalletId, item.currency, { stateDb, pendingDebit: item.amount });
        if (fundingBefore < Number(item.amount)) {
          await client.query(`ROLLBACK TO SAVEPOINT payroll_item`);
          results.push({ workerId: item.workerId, workerEmail: item.workerEmail, status: 'failed', error: 'insufficient_funds', amount: item.amount, currency: item.currency });
          continue;
        }

        await lockWalletBalanceRow(client, item.walletId, item.currency, { stateDb, pendingCredit: item.amount });

        await client.query(
          'UPDATE wallet_balances SET amount = amount - $1 WHERE wallet_id = $2 AND currency = $3',
          [item.amount, fundingWalletId, item.currency]
        );
        await client.query(
          'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
          [item.amount, item.walletId, item.currency]
        );

        const txRow = mapTxRow({
          id: txId, fromWalletId: fundingWalletId, toWalletId: item.walletId,
          amount: item.amount, currency: item.currency, memo: item.memo || '', timestamp: Date.now(),
        });
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
          `INSERT INTO ledger(id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note)
           VALUES
             ($1, NULL, $2, $3, $4, 'payroll_debit', $5, $6, $7, $8, 'system', $9)`,
          [uuidv4(), item.workerId, fundingWalletId, item.currency, item.amount, fundingBefore, fundingBefore - Number(item.amount), txRow.timestamp, `payroll:${txId}`]
        );

        await linkPayrollPaymentTransaction(client, paymentId, txId);

        // Cancel any pending payroll_request rows for this worker+employer — settled via bulk now.
        await client.query(
          `UPDATE payment_requests
           SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'settled_via_bulk', settled_by_transaction_id = $1
           WHERE type = 'payroll_request' AND status = 'pending'
             AND (requester_id = $2)
             AND (target_employer_id = $3)`,
          [txId, item.workerId, employerId]
        );

        await client.query('RELEASE SAVEPOINT payroll_item');
        results.push({ workerId: item.workerId, workerEmail: item.workerEmail, status: 'success', transactionId: txId, amount: item.amount, currency: item.currency });
      } catch (itemErr) {
        await client.query('ROLLBACK TO SAVEPOINT payroll_item');
        results.push({ workerId: item.workerId, workerEmail: item.workerEmail, status: 'failed', error: itemErr.message, amount: item.amount, currency: item.currency });
      }
    }

    await client.query('COMMIT');
    return { results };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function getDurablePayrollBatchIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function saveDurablePayrollBatchIdempotency(clientKey, userId, responseBody) {
  if (!clientKey) return;
  await pool.query(
    `INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (user_id, key) DO NOTHING`,
    [clientKey, userId, JSON.stringify(responseBody)]
  ).catch(() => {}); // best-effort — the payroll_payments UNIQUE constraint is the real money-safety guarantee.
}

module.exports = {
  reservePayrollPayment,
  linkPayrollPaymentTransaction,
  commitPayrollBatchPostgres,
  getDurablePayrollBatchIdempotency,
  saveDurablePayrollBatchIdempotency,
};
