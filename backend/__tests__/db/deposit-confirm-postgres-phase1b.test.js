'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitDepositConfirmPostgres } = require('../../db/depositConfirmPostgres');

function requireDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
}

async function seedUserWallet(client, { userId, walletId, balances }) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1, $2, 'x', 'US', 'individual', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@phase1b-deposit.test`]
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
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

function buildDepositTx(id, walletId, amount, currency, intentId, memoLabel = 'Stripe') {
  return {
    id,
    type: 'deposit',
    fromWalletId: null,
    toWalletId: walletId,
    amount,
    currency,
    receivedAmount: amount,
    receivedCurrency: currency,
    wasConverted: false,
    feeAmount: 0,
    feeRate: 0,
    grossAmount: amount,
    status: 'completed',
    timestamp: Date.now(),
    memo: `Deposit via ${memoLabel}`,
    direction: 'in',
    stripeIntentId: intentId,
  };
}

test('phase1b-d deposit normal confirm', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4()] };
  const intentId = `pi_${uuidv4().replace(/-/g, '')}`;
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [{ currency: 'USD', amount: 1000 }],
    });

    const result = await commitDepositConfirmPostgres({
      walletId: ids.wallets[0],
      currency: 'USD',
      netCredited: 500,
      tx: buildDepositTx(ids.transactions[0], ids.wallets[0], 500, 'USD', intentId),
      userId: ids.users[0],
      intentId,
      stateDb: null,
    });

    assert.equal(result.replay, false);
    assert.equal(result.newBalance, 1500);
    const balance = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [ids.wallets[0], 'USD']
    );
    assert.equal(Number(balance.rows[0].amount), 1500);
    const ledger = await client.query("SELECT COUNT(*)::int AS count FROM ledger WHERE note = $1", [`deposit:${ids.transactions[0]}`]);
    assert.equal(ledger.rows[0].count, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-d deposit duplicate confirm replay', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4(), uuidv4()] };
  const intentId = `pi_${uuidv4().replace(/-/g, '')}`;
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [{ currency: 'USD', amount: 2500 }],
    });

    const first = await commitDepositConfirmPostgres({
      walletId: ids.wallets[0],
      currency: 'USD',
      netCredited: 700,
      tx: buildDepositTx(ids.transactions[0], ids.wallets[0], 700, 'USD', intentId),
      userId: ids.users[0],
      intentId,
      stateDb: null,
    });
    assert.equal(first.replay, false);

    const replay = await commitDepositConfirmPostgres({
      walletId: ids.wallets[0],
      currency: 'USD',
      netCredited: 700,
      tx: buildDepositTx(ids.transactions[1], ids.wallets[0], 700, 'USD', intentId),
      userId: ids.users[0],
      intentId,
      stateDb: null,
    });

    assert.equal(replay.replay, true);
    assert.equal(replay.response.alreadyProcessed, true);
    assert.equal(replay.response.transaction.id, ids.transactions[0]);
    const txCount = await client.query(
      'SELECT COUNT(*)::int AS count FROM transactions WHERE stripe_intent_id = $1',
      [intentId]
    );
    assert.equal(txCount.rows[0].count, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-d deposit provider unavailable demo confirm path', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4()] };
  const intentId = `demo_intent_${uuidv4()}`;
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [{ currency: 'USD', amount: 0 }],
    });

    const result = await commitDepositConfirmPostgres({
      walletId: ids.wallets[0],
      currency: 'USD',
      netCredited: 1200,
      tx: buildDepositTx(ids.transactions[0], ids.wallets[0], 1200, 'USD', intentId, 'Demo Mode'),
      userId: ids.users[0],
      intentId,
      stateDb: null,
    });

    assert.equal(result.replay, false);
    assert.equal(result.newBalance, 1200);
    const txRow = await client.query('SELECT memo, stripe_intent_id FROM transactions WHERE id = $1', [ids.transactions[0]]);
    assert.equal(txRow.rows[0].memo, 'Deposit via Demo Mode');
    assert.equal(txRow.rows[0].stripe_intent_id, intentId);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-d deposit rollback on transaction insert failure', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4(), uuidv4()] };
  const conflictTxId = ids.transactions[0];
  const intentId = `pi_${uuidv4().replace(/-/g, '')}`;
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [{ currency: 'USD', amount: 900 }],
    });

    await client.query(
      `INSERT INTO transactions (
        id, from_wallet_id, to_wallet_id, amount, currency, type, status, memo, direction, stripe_intent_id, timestamp
      ) VALUES ($1, NULL, $2, 1, 'USD', 'deposit', 'completed', 'seed', 'in', $3, NOW())`,
      [conflictTxId, ids.wallets[0], `pi_seed_${uuidv4().replace(/-/g, '')}`]
    );

    await assert.rejects(
      () => commitDepositConfirmPostgres({
        walletId: ids.wallets[0],
        currency: 'USD',
        netCredited: 400,
        tx: buildDepositTx(conflictTxId, ids.wallets[0], 400, 'USD', intentId),
        userId: ids.users[0],
        intentId,
        stateDb: null,
      }),
      /duplicate key|violates unique constraint/i
    );

    const balance = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [ids.wallets[0], 'USD']
    );
    assert.equal(Number(balance.rows[0].amount), 900);
    const inserted = await client.query(
      'SELECT COUNT(*)::int AS count FROM transactions WHERE stripe_intent_id = $1',
      [intentId]
    );
    assert.equal(inserted.rows[0].count, 0);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-d deposit confirm upserts missing relational user wallet rows from runtime state', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4()] };
  const intentId = `demo_intent_${uuidv4()}`;
  try {
    // Intentionally seed only user row in runtime state, not relational tables.
    const stateDb = {
      _dbVersion: 0,
      users: [{
        id: ids.users[0],
        email: `${ids.users[0]}@runtime-only.test`,
        passwordHash: 'x',
        region: 'US',
        role: 'individual',
        createdAt: Date.now(),
      }],
      wallets: [{
        id: ids.wallets[0],
        userId: ids.users[0],
        balances: [{ currency: 'USD', amount: 0 }],
        createdAt: Date.now(),
      }],
      transactions: [],
      ledger: [],
    };

    const result = await commitDepositConfirmPostgres({
      walletId: ids.wallets[0],
      currency: 'USD',
      netCredited: 1500,
      tx: buildDepositTx(ids.transactions[0], ids.wallets[0], 1500, 'USD', intentId, 'Demo Mode'),
      userId: ids.users[0],
      intentId,
      stateDb,
      skipRuntimeStateSync: true,
    });

    assert.equal(result.replay, false);
    assert.equal(result.newBalance, 1500);
    const user = await client.query('SELECT id FROM users WHERE id = $1', [ids.users[0]]);
    const wallet = await client.query('SELECT id FROM wallets WHERE id = $1 AND user_id = $2', [ids.wallets[0], ids.users[0]]);
    const bal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(user.rowCount, 1);
    assert.equal(wallet.rowCount, 1);
    assert.equal(Number(bal.rows[0].amount), 1500);
  } finally {
    try { await client.query('DELETE FROM runtime_db_state WHERE id = 1'); } catch (_) {}
    await cleanup(client, ids);
    client.release();
  }
});
