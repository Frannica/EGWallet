'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitExchangePostgres } = require('../../db/exchangePostgres');

function requireDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
}

async function seedUserWallet(client, { userId, walletId, balances }) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1, $2, 'x', 'US', 'individual', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@phase1b-ex.test`]
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
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query("DELETE FROM ledger WHERE note LIKE 'exchange:%'");
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

function txPayload(id, walletId, amount, fromCurrency, netReceived, toCurrency, fxFeeAmount) {
  return {
    id,
    type: 'exchange',
    fromWalletId: walletId,
    toWalletId: walletId,
    amount,
    currency: fromCurrency,
    receivedAmount: netReceived,
    receivedCurrency: toCurrency,
    wasConverted: true,
    fxFeeAmount,
    sendFeeAmount: 0,
    memo: '',
    status: 'completed',
    timestamp: Date.now(),
  };
}

test('phase1b-c exchange normal', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4()] };
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [
        { currency: 'USD', amount: 10000 },
        { currency: 'EUR', amount: 0 },
      ],
    });

    const result = await commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amount: 1000,
      netReceived: 915,
      tx: txPayload(ids.transactions[0], ids.wallets[0], 1000, 'USD', 915, 'EUR', 10),
      clientKey: `phase1b-ex-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
    });

    assert.equal(result.insufficientFunds, false);
    const usd = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const eur = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'EUR']);
    assert.equal(Number(usd.rows[0].amount), 9000);
    assert.equal(Number(eur.rows[0].amount), 915);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-c exchange insufficient funds', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4()] };
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [{ currency: 'USD', amount: 300 }],
    });

    const result = await commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amount: 1000,
      netReceived: 915,
      tx: txPayload(ids.transactions[0], ids.wallets[0], 1000, 'USD', 915, 'EUR', 10),
      clientKey: `phase1b-ex-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
    });

    assert.equal(result.insufficientFunds, true);
    const usd = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(Number(usd.rows[0].amount), 300);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-c exchange rounding parity', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4()] };
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [{ currency: 'KWD', amount: 1234 }, { currency: 'USD', amount: 0 }],
    });

    // Simulate existing rounding output from route math for this test case.
    const rawConverted = 4016;
    const fxFeeAmount = Math.round(rawConverted * 0.0115); // 46
    const netReceived = rawConverted - fxFeeAmount; // 3970

    const result = await commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'KWD',
      toCurrency: 'USD',
      amount: 1234,
      netReceived,
      tx: txPayload(ids.transactions[0], ids.wallets[0], 1234, 'KWD', netReceived, 'USD', fxFeeAmount),
      clientKey: `phase1b-ex-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { netReceived, fxFeeAmount },
      senderLimitTracking: null,
      stateDb: null,
    });

    assert.equal(result.insufficientFunds, false);
    const usd = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(Number(usd.rows[0].amount), 3970);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-c exchange concurrent double-spend prevention', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], transactions: [uuidv4(), uuidv4()] };
  try {
    await seedUserWallet(client, {
      userId: ids.users[0],
      walletId: ids.wallets[0],
      balances: [
        { currency: 'USD', amount: 5000 },
        { currency: 'EUR', amount: 0 },
        { currency: 'GBP', amount: 0 },
      ],
    });

    const p1 = commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amount: 4000,
      netReceived: 3600,
      tx: txPayload(ids.transactions[0], ids.wallets[0], 4000, 'USD', 3600, 'EUR', 41),
      clientKey: `phase1b-ex-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: 1 },
      senderLimitTracking: null,
      stateDb: null,
    });
    const p2 = commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'USD',
      toCurrency: 'GBP',
      amount: 4000,
      netReceived: 3000,
      tx: txPayload(ids.transactions[1], ids.wallets[0], 4000, 'USD', 3000, 'GBP', 34),
      clientKey: `phase1b-ex-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: 2 },
      senderLimitTracking: null,
      stateDb: null,
    });

    const [a, b] = await Promise.all([p1, p2]);
    const successCount = [a, b].filter((r) => !r.insufficientFunds && !r.replay).length;
    const failCount = [a, b].filter((r) => r.insufficientFunds).length;
    assert.equal(successCount, 1);
    assert.equal(failCount, 1);

    const usd = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(Number(usd.rows[0].amount), 1000);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});
