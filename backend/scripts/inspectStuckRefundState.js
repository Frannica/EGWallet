'use strict';
/** READ-ONLY inspect after stuck refund + failed completion. */
const REFUND_ID = 'fda1e0c9-03d5-439d-8b24-b86fd45a036a';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
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
  const rr = await client.query(`SELECT * FROM refund_requests WHERE id=$1`, [REFUND_ID]);
  const ledger = await client.query(
    `SELECT type, amount, balance_before, balance_after, note, at FROM ledger
      WHERE wallet_id=$1 AND currency='USD' AND type LIKE 'deposit_refund%'
      ORDER BY at DESC LIMIT 15`,
    [WALLET]
  );
  await client.end();

  const key = process.env.STRIPE_SECRET_KEY;
  const stripe = require('stripe')(key);
  const pi = await stripe.paymentIntents.retrieve(INTENT);
  const refunds = await stripe.refunds.list({ payment_intent: INTENT, limit: 20 });

  // Try to replay idempotency to see original params (Stripe returns error with details)
  let idempotencyProbe = null;
  try {
    await stripe.refunds.create(
      { payment_intent: INTENT, amount: 1000 },
      { idempotencyKey: `egw-refund-${REFUND_ID}` }
    );
  } catch (e) {
    idempotencyProbe = {
      message: e.message,
      code: e.code,
      statusCode: e.statusCode,
      // stripe sometimes attaches raw
      rawType: e.rawType,
      requestId: e.requestId,
      doc_url: e.doc_url,
      headers: e.headers ? {
        'idempotent-replayed': e.headers['idempotent-replayed'],
        'original-request': e.headers['original-request'],
      } : null,
    };
  }

  console.log(JSON.stringify({
    readOnly: true,
    wallet: {
      usd: Number(bal.rows[0]?.amount || 0),
      hold: Number(hold.rows[0]?.amount || 0),
    },
    refundRow: rr.rows[0] || null,
    ledger: ledger.rows,
    stripePi: {
      status: pi.status,
      charged: pi.amount_received || pi.amount,
      amount_refunded: pi.amount_refunded,
      charges: pi.charges?.data?.map((c) => ({
        id: c.id,
        amount: c.amount,
        amount_refunded: c.amount_refunded,
        refunded: c.refunded,
      })),
    },
    stripeRefunds: refunds.data.map((r) => ({
      id: r.id,
      amount: r.amount,
      status: r.status,
      reason: r.reason,
      metadata: r.metadata,
      created: r.created,
    })),
    idempotencyProbe,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
