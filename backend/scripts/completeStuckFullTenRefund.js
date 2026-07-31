'use strict';
/**
 * Complete the stuck full-$10 refund that placed a wallet hold but did not
 * finish stripe.refunds.create (API returned 502 upstream).
 *
 * Target refund id: fda1e0c9-03d5-439d-8b24-b86fd45a036a
 * PI: pi_3Twuw3HZf1hto9p701gBf7vp
 *
 * Requires:
 *   APPROVAL=APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp
 *   DATABASE_PUBLIC_URL + STRIPE_SECRET_KEY (sk_live_)
 */
const EXPECTED_APPROVAL =
  'APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp';
const REFUND_ID = 'fda1e0c9-03d5-439d-8b24-b86fd45a036a';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
const AMOUNT = 1000;

async function main() {
  if (process.env.APPROVAL !== EXPECTED_APPROVAL) {
    console.error(JSON.stringify({ ok: false, error: 'APPROVAL_MISMATCH' }));
    process.exit(2);
  }
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (!pub || pub.includes('railway.internal')) {
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
  const { loadAppState, saveAppState } = require('../db/appStateStore');
  const { markRefundSubmitted, markRefundFailed } = require('../refundEngine');
  const { commitRefundTransitionPostgres } = require('../db/refundsPostgres');

  const db = loadAppState();
  const refund = (db.refundRequests || []).find((r) => r.id === REFUND_ID);
  if (!refund) {
    console.error(JSON.stringify({ ok: false, error: 'refund_not_in_app_state', refundId: REFUND_ID }));
    process.exit(3);
  }
  if (refund.stripePaymentIntentId !== INTENT) {
    console.error(JSON.stringify({ ok: false, error: 'pi_mismatch', got: refund.stripePaymentIntentId }));
    process.exit(3);
  }
  if (Number(refund.amount) !== AMOUNT) {
    console.error(JSON.stringify({ ok: false, error: 'amount_mismatch', got: refund.amount }));
    process.exit(3);
  }

  // Pre-inspect Stripe
  const piBefore = await stripe.paymentIntents.retrieve(INTENT);
  const alreadyBefore = Number(piBefore.amount_refunded || 0);

  let stripeRefund;
  if (refund.stripeRefundId) {
    stripeRefund = await stripe.refunds.retrieve(refund.stripeRefundId);
  } else if (alreadyBefore >= AMOUNT) {
    // Stripe already fully refunded — find matching refund object
    const list = await stripe.refunds.list({ payment_intent: INTENT, limit: 10 });
    stripeRefund = list.data.find((r) => Number(r.amount) === AMOUNT) || list.data[0];
  } else if (refund.status === 'requested' || refund.status === 'pending' || refund.status === 'failed') {
    const stripeAmount = Number(refund.stripeRefundAmount || AMOUNT);
    const { resolveStripeRefundAfterCreateError, findStripeRefundForRequest } = require('../refundStripeSafety');
    // Always re-query before create/release.
    stripeRefund = await findStripeRefundForRequest(stripe, {
      refundId: REFUND_ID,
      paymentIntentId: INTENT,
      stripeAmount,
    });
    if (!stripeRefund && (refund.status === 'requested' || refund.status === 'pending')) {
      try {
        stripeRefund = await stripe.refunds.create(
          {
            payment_intent: INTENT,
            amount: stripeAmount,
            reason: 'requested_by_customer',
            metadata: {
              refundRequestId: REFUND_ID,
              egwalletRefundId: REFUND_ID,
              depositTransactionId: refund.depositTransactionId,
              userId: refund.userId,
              completion: 'stuck_502_recovery',
            },
          },
          { idempotencyKey: `egw-refund-${REFUND_ID}` }
        );
      } catch (stripeErr) {
        const resolution = await resolveStripeRefundAfterCreateError(stripe, {
          refundId: REFUND_ID,
          paymentIntentId: INTENT,
          stripeAmount,
          error: stripeErr,
        });
        if (resolution.stripeRefund) {
          stripeRefund = resolution.stripeRefund;
        } else if (resolution.safeToReleaseHold) {
          const expectedStatus = refund.status;
          markRefundFailed(db, REFUND_ID, stripeErr.message || 'Stripe refund create failed', {
            by: 'system',
            stripeStatus: 'failed',
          });
          const failed = (db.refundRequests || []).find((r) => r.id === REFUND_ID);
          await commitRefundTransitionPostgres({
            stateDb: db,
            refund: failed,
            expectedStatus,
            ledgerTypes: ['deposit_refund_release'],
          });
          saveAppState(db);
          console.log(JSON.stringify({
            ok: false,
            error: 'STRIPE_CREATE_FAILED_HOLD_RELEASED',
            message: stripeErr.message,
            code: stripeErr.code,
          }, null, 2));
          process.exit(4);
        } else {
          console.log(JSON.stringify({
            ok: false,
            error: 'REFUND_PENDING_STRIPE_VERIFY',
            reason: resolution.reason,
            holdRetained: true,
          }, null, 2));
          process.exit(6);
        }
      }
    }
    if (!stripeRefund) {
      console.log(JSON.stringify({ ok: false, error: 'NO_STRIPE_REFUND_TO_SETTLE', status: refund.status }, null, 2));
      process.exit(3);
    }
  } else {
    console.error(JSON.stringify({
      ok: false,
      error: 'unexpected_status',
      status: refund.status,
      stripeRefundId: refund.stripeRefundId,
    }, null, 2));
    process.exit(3);
  }

  const expectedStatus = refund.status;
  markRefundSubmitted(db, REFUND_ID, {
    stripeRefundId: stripeRefund.id,
    stripeStatus: stripeRefund.status,
    by: 'stripe',
  });
  const updated = (db.refundRequests || []).find((r) => r.id === REFUND_ID);
  const ledgerTypes = [];
  if (updated.status === 'succeeded') {
    const hasRedebit = (db.ledger || []).some(
      (l) => l.refundRequestId === REFUND_ID && l.type === 'deposit_refund_redebit'
    );
    ledgerTypes.push(hasRedebit ? 'deposit_refund_redebit' : 'deposit_refund_debit');
  }
  if (updated.status === 'failed') ledgerTypes.push('deposit_refund_release');
  await commitRefundTransitionPostgres({
    stateDb: db,
    refund: updated,
    expectedStatus,
    ledgerTypes,
  });
  saveAppState(db);

  // Wait briefly for webhooks / Stripe settle
  await new Promise((r) => setTimeout(r, 3000));
  const piAfter = await stripe.paymentIntents.retrieve(INTENT);
  const charged = Number(piAfter.amount_received || piAfter.amount || 0);
  const alreadyRefunded = Number(piAfter.amount_refunded || 0);

  // Re-load balances from postgres via pool
  const { pool } = require('../db/pool');
  const balRes = await pool.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = 'USD'`,
    [refund.walletId]
  );
  const holdRes = await pool.query(
    `SELECT COALESCE(amount,0)::bigint AS amount FROM wallet_holds
      WHERE wallet_id = $1 AND currency = 'USD'`,
    [refund.walletId]
  );
  const rr = await pool.query(
    `SELECT id, status, stripe_refund_id, amount, wallet_debited, hold_released
       FROM refund_requests WHERE id = $1`,
    [REFUND_ID]
  );
  const ledger = await pool.query(
    `SELECT type, amount, balance_before, balance_after, note, at
       FROM ledger WHERE wallet_id = $1 AND currency = 'USD'
         AND type LIKE 'deposit_refund%'
       ORDER BY at DESC LIMIT 10`,
    [refund.walletId]
  );

  const report = {
    completed: true,
    refundId: REFUND_ID,
    stripeRefund: {
      id: stripeRefund.id,
      status: stripeRefund.status,
      amount: stripeRefund.amount,
      payment_intent: stripeRefund.payment_intent,
      destination: 'original_payment_method_only',
    },
    appRefundStatus: updated.status,
    after: {
      usdBalanceMinor: Number(balRes.rows[0]?.amount || 0),
      usdHoldMinor: Number(holdRes.rows[0]?.amount || 0),
      stripe: {
        charged,
        alreadyRefunded,
        remaining: Math.max(0, charged - alreadyRefunded),
        fullyRefunded: alreadyRefunded === AMOUNT && charged === AMOUNT,
      },
      refundRow: rr.rows[0] || null,
      ledger: ledger.rows,
    },
  };
  report.pass =
    report.after.usdBalanceMinor === 0
    && report.after.usdHoldMinor === 0
    && report.after.stripe.fullyRefunded
    && (report.appRefundStatus === 'succeeded' || report.after.refundRow?.status === 'succeeded');

  console.log(JSON.stringify(report, null, 2));
  await pool.end().catch(() => {});
  process.exit(report.pass ? 0 : 5);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
