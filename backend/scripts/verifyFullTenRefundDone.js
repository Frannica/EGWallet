'use strict';
/** Read-only final proof for the buah $10 full refund. */
const REFUND_ID = 'fda1e0c9-03d5-439d-8b24-b86fd45a036a';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
const STRIPE_REFUND_ID = 're_3Twuw3HZf1hto9p70t00xc7l';
const WALLET = '94435fe0-968b-4358-b926-5a7b7c6c91c0';

async function main() {
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (!pub) throw new Error('DATABASE_PUBLIC_URL required');
  process.env.DATABASE_URL = pub;
  const { Client } = require('pg');
  const client = new Client({ connectionString: pub, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const bal = await client.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency='USD'`,
    [WALLET]
  );
  const hold = await client.query(
    `SELECT COALESCE(amount,0)::bigint AS amount FROM wallet_holds WHERE wallet_id=$1 AND currency='USD'`,
    [WALLET]
  );
  const rr = await client.query(
    `SELECT id, status, stripe_refund_id, amount, wallet_debited, hold_released FROM refund_requests WHERE id=$1`,
    [REFUND_ID]
  );
  const tx = await client.query(
    `SELECT id, type, amount, status, memo FROM transactions WHERE type='deposit_refund' AND from_wallet_id=$1 ORDER BY timestamp DESC LIMIT 3`,
    [WALLET]
  );
  const ledger = await client.query(
    `SELECT type, amount, balance_before, balance_after, at FROM ledger
      WHERE wallet_id=$1 AND currency='USD' AND type LIKE 'deposit_refund%' ORDER BY at DESC LIMIT 5`,
    [WALLET]
  );
  await client.end();

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const pi = await stripe.paymentIntents.retrieve(INTENT, { expand: ['latest_charge'] });
  const refund = await stripe.refunds.retrieve(STRIPE_REFUND_ID);

  const report = {
    readOnly: true,
    walletUsd: Number(bal.rows[0]?.amount || 0),
    walletHold: Number(hold.rows[0]?.amount || 0),
    refundRow: rr.rows[0] || null,
    depositRefundTx: tx.rows,
    ledger: ledger.rows,
    stripe: {
      piCharged: Number(pi.amount_received || pi.amount || 0),
      piAmountRefunded: Number(pi.amount_refunded ?? pi.latest_charge?.amount_refunded ?? 0),
      refundId: refund.id,
      refundStatus: refund.status,
      refundAmount: refund.amount,
    },
  };
  report.pass =
    report.walletUsd === 0
    && report.walletHold === 0
    && report.refundRow?.status === 'succeeded'
    && report.refundRow?.wallet_debited === true
    && report.stripe.refundStatus === 'succeeded'
    && report.stripe.refundAmount === 1000
    && report.depositRefundTx.length >= 1;

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
