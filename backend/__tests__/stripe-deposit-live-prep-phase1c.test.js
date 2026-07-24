'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.PGSSLMODE = process.env.PGSSLMODE || 'disable';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Same local-Postgres auto-discovery convention already used by
// admin-dashboard.test.js / employer-payroll-e2e.test.js: prefer an
// explicit DATABASE_URL, otherwise probe the well-known local dev DB
// started via `backend/docs/postgres-phase0-runbook.md`. This lets these
// tests genuinely exercise real Postgres locally without requiring every
// developer/CI shell to export DATABASE_URL manually, while still failing
// (via t.skip, never a silent pass) when no database is reachable at all.
const FALLBACK_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/egwallet_phase0';
let dbReady = false;
let pool;
// NOTE: these two modules both import the shared `../db/pool` singleton,
// which reads process.env.DATABASE_URL exactly once, at require() time.
// They must therefore be required lazily — AFTER pickDatabaseUrl() has set
// process.env.DATABASE_URL below — never at module top-level, or the pool
// silently locks onto an empty connection string (and Postgres then
// authenticates as the OS user instead of the intended test database).
let settleStripePaymentIntentDeposit;
let commitDepositConfirmPostgres;

async function pickDatabaseUrl() {
  for (const url of [process.env.DATABASE_URL, FALLBACK_DATABASE_URL].filter(Boolean)) {
    const client = new Client({ connectionString: url, ssl: false });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return url;
    } catch (_error) {
      try { await client.end(); } catch (_) {}
    }
  }
  return null;
}

test.before(async () => {
  const dbUrl = await pickDatabaseUrl();
  if (!dbUrl) return;
  process.env.DATABASE_URL = dbUrl;
  ({ pool } = require('../db/pool'));
  ({ settleStripePaymentIntentDeposit } = require('../stripeDepositSettlement'));
  ({ commitDepositConfirmPostgres } = require('../db/depositConfirmPostgres'));
  dbReady = true;
});

test.after(async () => {
  if (dbReady && pool) await pool.end();
});

function buildRuntimeDb(userId, walletId, balance = 1000) {
  return {
    users: [{ id: userId, email: `${userId}@phase1c.test` }],
    wallets: [{
      id: walletId,
      userId,
      balances: [{ currency: 'USD', amount: balance }],
    }],
    transactions: [],
  };
}

function buildIntent({ intentId, userId, walletId, netCredited = 5000, amount = 5250 }) {
  return {
    id: intentId,
    amount,
    currency: 'usd',
    status: 'succeeded',
    metadata: {
      userId,
      walletId,
      netCredited: String(netCredited),
      feeAmount: String(amount - netCredited),
      feeRate: '0.05',
    },
  };
}

function buildDepositTx(id, walletId, amount, intentId) {
  return {
    id,
    type: 'deposit',
    fromWalletId: null,
    toWalletId: walletId,
    amount,
    currency: 'USD',
    receivedAmount: amount,
    receivedCurrency: 'USD',
    wasConverted: false,
    feeAmount: 250,
    feeRate: 0.05,
    grossAmount: amount + 250,
    status: 'completed',
    timestamp: Date.now(),
    memo: 'Deposit via Stripe',
    direction: 'in',
    stripeIntentId: intentId,
  };
}

async function seedUserWallet(client, { userId, walletId, balances }) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1, $2, 'x', 'US', 'individual', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@phase1c.test`]
  );
  await client.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd)
     VALUES ($1, $2, NOW(), 250000)
     ON CONFLICT (id) DO NOTHING`,
    [walletId, userId]
  );
  for (const bal of balances) {
    await client.query(
      `INSERT INTO wallet_balances(wallet_id, currency, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
      [walletId, bal.currency, bal.amount]
    );
  }
}

async function cleanup(client, ids) {
  await client.query("DELETE FROM ledger WHERE note LIKE 'deposit:%'");
  await client.query('DELETE FROM transactions WHERE stripe_intent_id = ANY($1::text[])', [ids.intents]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

test('phase1c source: Stripe env keys guarded in production startup', () => {
  assert.match(indexSource, /STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing/);
  assert.match(indexSource, /STRIPE_SECRET_KEY is set but STRIPE_PUBLISHABLE_KEY is missing/);
  assert.match(indexSource, /sk_test_/);
  assert.match(indexSource, /pk_test_/);
});

test('phase1c source: create-intent returns publishableKey in stripe mode', () => {
  const block = indexSource.match(/app\.post\('\/deposits\/create-intent'[\s\S]*?app\.post\('\/deposits\/confirm'/);
  assert.ok(block, 'create-intent route block found');
  assert.match(block[0], /publishableKey/);
  assert.match(block[0], /mode:\s*'stripe'/);
  assert.match(block[0], /STRIPE_PUBLISHABLE_KEY is missing/);
});

test('phase1c source: confirm rejects non-succeeded PaymentIntent', () => {
  const block = indexSource.match(/app\.post\('\/deposits\/confirm'[\s\S]*?app\.post\('/);
  assert.ok(block, 'confirm route block found');
  assert.match(block[0], /intent\.status !== 'succeeded'/);
  assert.match(block[0], /Payment not completed/);
});

test('phase1c source: webhook uses settleStripePaymentIntentDeposit', () => {
  assert.match(indexSource, /settleStripePaymentIntentDeposit/);
  assert.match(indexSource, /payment_intent\.succeeded/);
  assert.match(indexSource, /commitDepositConfirmPostgres/);
});

test('phase1c webhook settlement credits postgres and app_state', async (t) => {
  if (!dbReady) return t.skip('PostgreSQL unavailable');
  const client = await pool.connect();
  const userId = uuidv4();
  const walletId = uuidv4();
  const intentId = `pi_${uuidv4().replace(/-/g, '')}`;
  const ids = { users: [userId], wallets: [walletId], intents: [intentId] };
  try {
    await seedUserWallet(client, {
      userId,
      walletId,
      balances: [{ currency: 'USD', amount: 2000 }],
    });
    const db = buildRuntimeDb(userId, walletId, 2000);
    const result = await settleStripePaymentIntentDeposit(
      db,
      buildIntent({ intentId, userId, walletId, netCredited: 3000 }),
      {}
    );

    assert.equal(result.handled, true);
    assert.equal(result.reason, 'credited');
    assert.equal(result.newBalance, 5000);
    assert.equal(db.wallets[0].balances[0].amount, 5000);
    assert.equal(db.transactions.length, 1);
    assert.equal(db.transactions[0].stripeIntentId, intentId);

    const pgBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [walletId, 'USD']
    );
    assert.equal(Number(pgBal.rows[0].amount), 5000);
    const pgTx = await client.query(
      'SELECT COUNT(*)::int AS count FROM transactions WHERE stripe_intent_id = $1',
      [intentId]
    );
    assert.equal(pgTx.rows[0].count, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1c webhook settlement is idempotent after confirm postgres commit', async (t) => {
  if (!dbReady) return t.skip('PostgreSQL unavailable');
  const client = await pool.connect();
  const userId = uuidv4();
  const walletId = uuidv4();
  const intentId = `pi_${uuidv4().replace(/-/g, '')}`;
  const txId = uuidv4();
  const ids = { users: [userId], wallets: [walletId], intents: [intentId] };
  try {
    await seedUserWallet(client, {
      userId,
      walletId,
      balances: [{ currency: 'USD', amount: 1000 }],
    });

    await commitDepositConfirmPostgres({
      walletId,
      currency: 'USD',
      netCredited: 800,
      tx: buildDepositTx(txId, walletId, 800, intentId),
      userId,
      intentId,
      stateDb: null,
    });

    const db = buildRuntimeDb(userId, walletId, 1000);
    const result = await settleStripePaymentIntentDeposit(
      db,
      buildIntent({ intentId, userId, walletId, netCredited: 800 }),
      {}
    );

    assert.equal(result.handled, true);
    assert.equal(result.reason, 'already_credited_postgres');
    assert.equal(db.transactions.length, 0);
    assert.equal(db.wallets[0].balances[0].amount, 1000);

    const pgBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [walletId, 'USD']
    );
    assert.equal(Number(pgBal.rows[0].amount), 1800);
    const pgTx = await client.query(
      'SELECT COUNT(*)::int AS count FROM transactions WHERE stripe_intent_id = $1',
      [intentId]
    );
    assert.equal(pgTx.rows[0].count, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1c webhook settlement is idempotent on duplicate webhook delivery', async (t) => {
  if (!dbReady) return t.skip('PostgreSQL unavailable');
  const client = await pool.connect();
  const userId = uuidv4();
  const walletId = uuidv4();
  const intentId = `pi_${uuidv4().replace(/-/g, '')}`;
  const ids = { users: [userId], wallets: [walletId], intents: [intentId] };
  try {
    await seedUserWallet(client, {
      userId,
      walletId,
      balances: [{ currency: 'USD', amount: 0 }],
    });
    const db = buildRuntimeDb(userId, walletId, 0);
    const intent = buildIntent({ intentId, userId, walletId, netCredited: 1500 });

    const first = await settleStripePaymentIntentDeposit(db, intent, {});
    const second = await settleStripePaymentIntentDeposit(db, intent, {});

    assert.equal(first.reason, 'credited');
    assert.equal(second.reason, 'already_credited_app_state');
    assert.equal(db.transactions.length, 1);

    const pgBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [walletId, 'USD']
    );
    assert.equal(Number(pgBal.rows[0].amount), 1500);
    const pgTx = await client.query(
      'SELECT COUNT(*)::int AS count FROM transactions WHERE stripe_intent_id = $1',
      [intentId]
    );
    assert.equal(pgTx.rows[0].count, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});
