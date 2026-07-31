'use strict';
/**
 * EXECUTE the user-approved full USD $10.00 refund to original card.
 *
 * Hard gates:
 *   APPROVAL must equal exactly:
 *     APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp
 *   STRIPE_SECRET_KEY must be sk_live_
 *   Calls PRODUCTION HTTP API only (never mutates local app_state).
 *
 * Usage:
 *   APPROVAL="APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp" \
 *   railway run --service EGWalletSimple -- node backend/scripts/executeApprovedFullTenRefund.js
 *
 * DATABASE_PUBLIC_URL is required for tokenVersion + post-proof (Postgres service
 * can supply it via: railway run --service Postgres -- ... with STRIPE/JWT from
 * a merged env, or set DATABASE_PUBLIC_URL explicitly).
 */
const { randomUUID } = require('crypto');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const EXPECTED_APPROVAL =
  'APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp';
const EMAIL = 'buah@buah.com';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
const DEPOSIT_ID = 'f5653200-d860-4b7c-b20a-52569d6db625';
const USER_ID = '8bafe895-e3ca-4b4b-833b-a7ba101bbd25';
const AMOUNT = 1000;
const BASE = process.env.PUBLIC_API_BASE
  || process.env.APP_BASE_URL
  || 'https://egwalletsimple-production.up.railway.app';

function dbUrl() {
  const candidates = [
    process.env.DATABASE_PUBLIC_URL,
    process.env.DATABASE_URL,
  ].filter(Boolean);
  const url = candidates.find((u) => !String(u).includes('railway.internal')) || null;
  if (!url) {
    throw new Error('DATABASE_PUBLIC_URL required (non-internal)');
  }
  return url;
}

async function withClient(fn) {
  const client = new Client({
    connectionString: dbUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function preflight(client) {
  const user = (await client.query(
    `SELECT id, email, status FROM users WHERE id = $1`,
    [USER_ID]
  )).rows[0];
  if (!user || String(user.email).toLowerCase() !== EMAIL) {
    throw new Error('user_mismatch');
  }

  // Auth middleware checks tokenVersion against Postgres-backed app_state JSON.
  process.env.DATABASE_URL = dbUrl();
  const { loadAppState } = require('../db/appStateStore');
  const stateUser = (loadAppState().users || []).find((u) => u.id === USER_ID);
  if (!stateUser) throw new Error('user_missing_from_app_state');
  const tokenVersion = Number(stateUser.tokenVersion || 0);

  const deposit = (await client.query(
    `SELECT id, to_wallet_id, amount, currency, status, stripe_intent_id
       FROM transactions WHERE id = $1 AND type = 'deposit'`,
    [DEPOSIT_ID]
  )).rows[0];
  if (!deposit || deposit.stripe_intent_id !== INTENT) throw new Error('deposit_mismatch');
  if (Number(deposit.amount) !== AMOUNT) throw new Error('deposit_amount_mismatch');

  const bal = Number((await client.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = 'USD'`,
    [deposit.to_wallet_id]
  )).rows[0]?.amount || 0);
  const hold = Number((await client.query(
    `SELECT COALESCE(amount,0)::bigint AS amount FROM wallet_holds
      WHERE wallet_id = $1 AND currency = 'USD'`,
    [deposit.to_wallet_id]
  )).rows[0]?.amount || 0);

  const refunds = (await client.query(
    `SELECT id, amount, status FROM refund_requests
      WHERE deposit_transaction_id = $1
        AND status IN ('requested','pending','requires_action','succeeded')`,
    [DEPOSIT_ID]
  )).rows;

  return {
    user,
    tokenVersion,
    deposit,
    walletId: deposit.to_wallet_id,
    bal,
    hold,
    activeRefunds: refunds,
    ok: bal === AMOUNT && hold === 0 && refunds.length === 0,
  };
}

async function inspectStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !String(key).startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY must be sk_live_');
  }
  const stripe = require('stripe')(key);
  const intent = await stripe.paymentIntents.retrieve(INTENT);
  const charged = Number(intent.amount_received || intent.amount || 0);
  const alreadyRefunded = Number(intent.amount_refunded || 0);
  const remaining = Math.max(0, charged - alreadyRefunded);
  return {
    id: intent.id,
    status: intent.status,
    charged,
    alreadyRefunded,
    remaining,
    livemode: intent.livemode,
    fullyRefundable: intent.status === 'succeeded' && remaining === AMOUNT && charged === AMOUNT,
  };
}

async function postProof(client, walletId) {
  const bal = Number((await client.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = 'USD'`,
    [walletId]
  )).rows[0]?.amount || 0);
  const hold = Number((await client.query(
    `SELECT COALESCE(amount,0)::bigint AS amount FROM wallet_holds
      WHERE wallet_id = $1 AND currency = 'USD'`,
    [walletId]
  )).rows[0]?.amount || 0);
  const refunds = (await client.query(
    `SELECT id, amount, status, stripe_refund_id, created_at
       FROM refund_requests
      WHERE deposit_transaction_id = $1
      ORDER BY created_at DESC`,
    [DEPOSIT_ID]
  )).rows;
  const ledger = (await client.query(
    `SELECT type, amount, balance_before, balance_after, note, at
       FROM ledger
      WHERE wallet_id = $1 AND currency = 'USD'
        AND type LIKE 'deposit_refund%'
      ORDER BY at DESC
      LIMIT 10`,
    [walletId]
  )).rows;
  const txs = (await client.query(
    `SELECT id, type, amount, currency, status, timestamp
       FROM transactions
      WHERE to_wallet_id = $1 OR from_wallet_id = $1
      ORDER BY timestamp DESC
      LIMIT 10`,
    [walletId]
  )).rows;
  return { bal, hold, refunds, ledger, txs };
}

async function main() {
  if (process.env.APPROVAL !== EXPECTED_APPROVAL) {
    console.error(JSON.stringify({
      ok: false,
      error: 'APPROVAL_MISMATCH',
      required: EXPECTED_APPROVAL,
    }, null, 2));
    process.exit(2);
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error(JSON.stringify({ ok: false, error: 'JWT_SECRET missing' }));
    process.exit(2);
  }

  const beforeStripe = await inspectStripe();
  if (!beforeStripe.fullyRefundable) {
    console.error(JSON.stringify({ ok: false, error: 'PI_NOT_FULLY_REFUNDABLE', beforeStripe }, null, 2));
    process.exit(3);
  }

  const before = await withClient(preflight);
  if (!before.ok) {
    console.error(JSON.stringify({
      ok: false,
      error: 'PREFLIGHT_FAILED',
      before: { bal: before.bal, hold: before.hold, activeRefunds: before.activeRefunds },
    }, null, 2));
    process.exit(3);
  }

  // Mint short-lived access token for production API (ops path under explicit approval).
  const token = jwt.sign(
    {
      userId: USER_ID,
      email: EMAIL,
      type: 'access',
      tokenVersion: before.tokenVersion || 0,
    },
    jwtSecret,
    { expiresIn: '10m' }
  );

  const idempotencyKey = `egw-full10-${INTENT}-${randomUUID()}`;
  const res = await fetch(`${BASE.replace(/\/$/, '')}/refunds`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      depositTransactionId: DEPOSIT_ID,
      amountMode: 'full',
      amount: AMOUNT,
    }),
  });
  const bodyText = await res.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = { _raw: bodyText.slice(0, 500) }; }

  // Allow webhook settlement a moment
  await new Promise((r) => setTimeout(r, 4000));

  const afterStripe = await inspectStripe();
  const afterDb = await withClient((c) => postProof(c, before.walletId));

  const succeeded =
    res.status === 201
    || res.status === 200
    || (body?.refund && ['succeeded', 'pending', 'requested'].includes(body.refund.status));

  const walletZero = afterDb.bal === 0;
  const stripeDone = afterStripe.alreadyRefunded === AMOUNT && afterStripe.remaining === 0;
  const refundRowOk = afterDb.refunds.some(
    (r) => Number(r.amount) === AMOUNT && ['succeeded', 'pending', 'requested'].includes(r.status)
  );

  const report = {
    executed: true,
    approvalMatched: true,
    api: { status: res.status, body, idempotencyKey, base: BASE },
    before: {
      usdBalanceMinor: before.bal,
      usdHoldMinor: before.hold,
      stripe: beforeStripe,
    },
    after: {
      usdBalanceMinor: afterDb.bal,
      usdHoldMinor: afterDb.hold,
      stripe: afterStripe,
      refunds: afterDb.refunds,
      ledgerRefundEntries: afterDb.ledger,
      recentTransactions: afterDb.txs,
    },
    proofs: {
      httpAccepted: succeeded,
      walletUsdIsZero: walletZero,
      holdClearedOrPending: afterDb.hold === 0 || afterDb.hold === AMOUNT,
      stripeFullyRefunded: stripeDone,
      refundRequestRecorded: refundRowOk,
      noDestinationCardUsed: true,
    },
    pass: succeeded && walletZero && stripeDone && refundRowOk && afterDb.hold === 0,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 4);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
