'use strict';
/**
 * MONEY-SAFETY RECONCILE for approved full $10 refund.
 *
 * Fact: Stripe refund re_3Twuw3HZf1hto9p70t00xc7l already succeeded ($10 to original card).
 * Bug: ops completion path marked local refund failed and restored wallet USD $10.
 * Result: card refunded AND wallet still shows $10 (double credit).
 *
 * Fix (no new Stripe refund):
 *   - Debit wallet USD available 1000 → 0
 *   - Mark refund_requests succeeded + stripe_refund_id
 *   - Ledger deposit_refund_debit (reconcile)
 *   - Insert deposit_refund transaction for history/receipt
 *
 * APPROVAL must match the original user authorization string.
 */
const { randomUUID } = require('crypto');

const EXPECTED_APPROVAL =
  'APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp';
const REFUND_ID = 'fda1e0c9-03d5-439d-8b24-b86fd45a036a';
const STRIPE_REFUND_ID = 're_3Twuw3HZf1hto9p70t00xc7l';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
const WALLET = '94435fe0-968b-4358-b926-5a7b7c6c91c0';
const USER_ID = '8bafe895-e3ca-4b4b-833b-a7ba101bbd25';
const DEPOSIT_ID = 'f5653200-d860-4b7c-b20a-52569d6db625';
const AMOUNT = 1000;

async function main() {
  if (process.env.APPROVAL !== EXPECTED_APPROVAL) {
    console.error(JSON.stringify({ ok: false, error: 'APPROVAL_MISMATCH' }));
    process.exit(2);
  }
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (!pub) {
    console.error(JSON.stringify({ ok: false, error: 'DATABASE_PUBLIC_URL required' }));
    process.exit(2);
  }
  process.env.DATABASE_URL = pub;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !String(key).startsWith('sk_live_')) {
    console.error(JSON.stringify({ ok: false, error: 'sk_live_ required' }));
    process.exit(2);
  }
  const stripe = require('stripe')(key);
  const stripeRefund = await stripe.refunds.retrieve(STRIPE_REFUND_ID);
  if (stripeRefund.status !== 'succeeded' || Number(stripeRefund.amount) !== AMOUNT) {
    console.error(JSON.stringify({
      ok: false,
      error: 'STRIPE_REFUND_NOT_SUCCEEDED',
      stripeRefund: { id: stripeRefund.id, status: stripeRefund.status, amount: stripeRefund.amount },
    }, null, 2));
    process.exit(3);
  }
  if (stripeRefund.payment_intent !== INTENT) {
    console.error(JSON.stringify({ ok: false, error: 'PI_MISMATCH' }));
    process.exit(3);
  }

  const pi = await stripe.paymentIntents.retrieve(INTENT, { expand: ['latest_charge'] });
  const piRefunded = Number(
    pi.amount_refunded
    ?? pi.latest_charge?.amount_refunded
    ?? stripeRefund.amount
    ?? 0
  );
  if (piRefunded !== AMOUNT && Number(stripeRefund.amount) !== AMOUNT) {
    console.error(JSON.stringify({
      ok: false,
      error: 'PI_AMOUNT_REFUNDED_UNEXPECTED',
      amount_refunded: pi.amount_refunded,
      charge_amount_refunded: pi.latest_charge?.amount_refunded,
      stripeRefundAmount: stripeRefund.amount,
    }, null, 2));
    process.exit(3);
  }

  const { loadAppState, saveAppState } = require('../db/appStateStore');
  const { pool } = require('../db/pool');
  const { lockWalletBalanceRow } = require('../db/walletBalanceAlign');
  const { applyWalletBalanceHoldDelta } = require('../db/refundsPostgres');

  const db = loadAppState();
  const refund = (db.refundRequests || []).find((r) => r.id === REFUND_ID);
  if (!refund) {
    console.error(JSON.stringify({ ok: false, error: 'refund_missing_app_state' }));
    process.exit(3);
  }

  // If already correctly finalized, exit success.
  if (refund.status === 'succeeded' && refund.walletDebited) {
    const bal = await pool.query(
      `SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency='USD'`,
      [WALLET]
    );
    const report = {
      alreadyReconciled: true,
      usdBalanceMinor: Number(bal.rows[0]?.amount || 0),
      pass: Number(bal.rows[0]?.amount || 0) === 0,
    };
    console.log(JSON.stringify(report, null, 2));
    await pool.end().catch(() => {});
    process.exit(report.pass ? 0 : 5);
  }

  const client = await pool.connect();
  const ledgerId = randomUUID();
  const txId = randomUUID();
  const now = Date.now();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      `SELECT id, status, wallet_debited, hold_released, amount
         FROM refund_requests WHERE id = $1 FOR UPDATE`,
      [REFUND_ID]
    );
    if (!lock.rowCount) {
      await client.query('ROLLBACK');
      throw new Error('refund_row_missing');
    }
    if (lock.rows[0].wallet_debited) {
      await client.query('ROLLBACK');
      throw new Error('already_wallet_debited_in_postgres');
    }

    const balBefore = await lockWalletBalanceRow(client, WALLET, 'USD', {
      stateDb: db,
      pendingDebit: AMOUNT,
    });
    if (balBefore < AMOUNT) {
      await client.query('ROLLBACK');
      throw new Error(`insufficient_balance_for_reconcile:${balBefore}`);
    }

    // Permanent debit of the wrongly restored funds (no hold — Stripe already paid out).
    await applyWalletBalanceHoldDelta(client, WALLET, 'USD', {
      balanceDelta: -AMOUNT,
      holdDelta: 0,
    });

    // Update app-state refund object
    refund.status = 'succeeded';
    refund.stripeRefundId = STRIPE_REFUND_ID;
    refund.stripeStatus = 'succeeded';
    refund.walletDebited = true;
    refund.holdReleased = true; // hold path already closed; funds permanently gone
    refund.holdPlaced = true;
    refund.failureReason = null;
    refund.completedAt = now;
    refund.updatedAt = now;
    refund.statusHistory = Array.isArray(refund.statusHistory) ? refund.statusHistory : [];
    refund.statusHistory.push({
      at: now,
      by: 'ops_reconcile',
      status: 'succeeded',
      reason: 'stripe_succeeded_after_false_local_failure; wallet re-debited',
    });
    refund.reconciliationResult = {
      at: now,
      outcome: 'succeeded_after_false_failure_wallet_redebit',
      stripeRefundId: STRIPE_REFUND_ID,
      note: 'Card already refunded by Stripe; local double-credit corrected',
    };

    await client.query(
      `UPDATE refund_requests SET
         status = 'succeeded',
         stripe_refund_id = $2,
         stripe_status = 'succeeded',
         wallet_debited = true,
         hold_released = true,
         failure_reason = NULL,
         status_history = $3::jsonb,
         reconciliation_result = $4::jsonb,
         updated_at = NOW(),
         completed_at = NOW()
       WHERE id = $1`,
      [
        REFUND_ID,
        STRIPE_REFUND_ID,
        JSON.stringify(refund.statusHistory),
        JSON.stringify(refund.reconciliationResult),
      ]
    );

    await client.query(
      `INSERT INTO ledger(
         id, refund_request_id, user_id, wallet_id, currency, type, amount,
         balance_before, balance_after, at, by_actor, note
       ) VALUES ($1,$2,$3,$4,'USD','deposit_refund_debit',$5,$6,$7,NOW(),$8,$9)`,
      [
        ledgerId,
        REFUND_ID,
        USER_ID,
        WALLET,
        AMOUNT,
        balBefore,
        balBefore - AMOUNT,
        'ops_reconcile',
        `refund_debit_reconcile:${REFUND_ID}:stripe:${STRIPE_REFUND_ID}`,
      ]
    );

    // stripe_intent_id is UNIQUE when non-null and already used by the deposit row.
    // Store the PaymentIntent reference in memo; Stripe refund id is on refund_requests.
    await client.query(
      `INSERT INTO transactions (
         id, from_wallet_id, to_wallet_id, amount, currency, type, status, memo,
         direction, stripe_intent_id, timestamp
       ) VALUES ($1,$2,NULL,$3,'USD','deposit_refund','completed',$4,'out',NULL,NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        txId,
        WALLET,
        AMOUNT,
        `Refund to original payment method; pi=${INTENT}; re=${STRIPE_REFUND_ID}; refund=${REFUND_ID}`,
      ]
    );

    // Mirror into app state JSON
    if (!Array.isArray(db.ledger)) db.ledger = [];
    db.ledger.push({
      id: ledgerId,
      type: 'deposit_refund_debit',
      refundRequestId: REFUND_ID,
      userId: USER_ID,
      walletId: WALLET,
      currency: 'USD',
      amount: AMOUNT,
      balanceBefore: balBefore,
      balanceAfter: balBefore - AMOUNT,
      at: now,
      by: 'ops_reconcile',
      note: `refund_debit_reconcile:${REFUND_ID}:stripe:${STRIPE_REFUND_ID}`,
    });
    if (!Array.isArray(db.transactions)) db.transactions = [];
    db.transactions.push({
      id: txId,
      type: 'deposit_refund',
      fromWalletId: WALLET,
      toWalletId: null,
      amount: AMOUNT,
      currency: 'USD',
      status: 'completed',
      direction: 'out',
      memo: 'Refund to original payment method',
      stripeIntentId: INTENT,
      stripeRefundId: STRIPE_REFUND_ID,
      refundRequestId: REFUND_ID,
      depositTransactionId: DEPOSIT_ID,
      timestamp: now,
    });
    const w = (db.wallets || []).find((x) => x.id === WALLET);
    if (w) {
      const row = (w.balances || []).find((b) => b.currency === 'USD');
      if (row) row.amount = Math.max(0, Number(row.amount || 0) - AMOUNT);
      if (w.holdBalance) w.holdBalance.USD = 0;
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    client.release();
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(4);
  }
  client.release();

  saveAppState(db);

  const bal = await pool.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency='USD'`,
    [WALLET]
  );
  const hold = await pool.query(
    `SELECT COALESCE(amount,0)::bigint AS amount FROM wallet_holds WHERE wallet_id=$1 AND currency='USD'`,
    [WALLET]
  );
  const rr = await pool.query(`SELECT id, status, stripe_refund_id, wallet_debited, hold_released FROM refund_requests WHERE id=$1`, [REFUND_ID]);
  const ledger = await pool.query(
    `SELECT type, amount, balance_before, balance_after, note, at FROM ledger
      WHERE wallet_id=$1 AND currency='USD' AND type LIKE 'deposit_refund%'
      ORDER BY at DESC LIMIT 10`,
    [WALLET]
  );
  const tx = await pool.query(
    `SELECT id, type, amount, status, stripe_intent_id FROM transactions
      WHERE type='deposit_refund' AND from_wallet_id=$1 ORDER BY timestamp DESC LIMIT 3`,
    [WALLET]
  );

  const report = {
    reconciled: true,
    noNewStripeRefund: true,
    stripeRefund: {
      id: stripeRefund.id,
      status: stripeRefund.status,
      amount: stripeRefund.amount,
      destination: 'original_payment_method_only',
    },
    after: {
      usdBalanceMinor: Number(bal.rows[0]?.amount || 0),
      usdHoldMinor: Number(hold.rows[0]?.amount || 0),
      refundRow: rr.rows[0],
      ledger: ledger.rows,
      depositRefundTx: tx.rows,
      piAmountRefunded: piRefunded,
      stripeRefundStatus: stripeRefund.status,
    },
  };
  report.pass =
    report.after.usdBalanceMinor === 0
    && report.after.usdHoldMinor === 0
    && report.after.refundRow?.status === 'succeeded'
    && report.after.refundRow?.wallet_debited === true
    && report.after.stripeRefundStatus === 'succeeded'
    && Number(stripeRefund.amount) === AMOUNT
    && report.after.depositRefundTx.length >= 1;

  console.log(JSON.stringify(report, null, 2));
  await pool.end().catch(() => {});
  process.exit(report.pass ? 0 : 5);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
