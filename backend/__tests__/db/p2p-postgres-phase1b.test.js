'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitP2PSendPostgres } = require('../../db/p2pSendPostgres');

function requireDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required');
  }
}

async function seedWallet(client, { userId, walletId, currency, amount }) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1, $2, 'x', 'US', 'individual', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@phase1b.test`]
  );
  await client.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd)
     VALUES ($1, $2, NOW(), 250000)
     ON CONFLICT (id) DO NOTHING`,
    [walletId, userId]
  );
  await client.query(
    `INSERT INTO wallet_balances (wallet_id, currency, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
    [walletId, currency, amount]
  );
}

async function cleanup(client, ids) {
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM ledger WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

test('phase1b p2p normal send', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    transactions: [uuidv4()],
  };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 10000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const result = await commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2500,
      receivedCurrency: 'USD',
      receivedAmount: 2500,
      tx: {
        id: ids.transactions[0],
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[1],
        amount: 2500,
        currency: 'USD',
        debitAmount: 2500,
        debitCurrency: 'USD',
        senderCrossCurrency: false,
        receivedAmount: 2500,
        receivedCurrency: 'USD',
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: 'phase1b-normal',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: `phase1b-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      recipientUserId: ids.users[1],
    });

    assert.equal(result.replay, false);
    assert.equal(result.insufficientFunds, false);

    const fromBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [ids.wallets[0], 'USD']
    );
    const toBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [ids.wallets[1], 'USD']
    );
    assert.equal(Number(fromBal.rows[0].amount), 7500);
    assert.equal(Number(toBal.rows[0].amount), 2500);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b p2p insufficient funds', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    transactions: [uuidv4()],
  };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 1000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const result = await commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2500,
      receivedCurrency: 'USD',
      receivedAmount: 2500,
      tx: {
        id: ids.transactions[0],
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[1],
        amount: 2500,
        currency: 'USD',
        debitAmount: 2500,
        debitCurrency: 'USD',
        senderCrossCurrency: false,
        receivedAmount: 2500,
        receivedCurrency: 'USD',
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: 'phase1b-insufficient',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: `phase1b-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      recipientUserId: ids.users[1],
    });

    assert.equal(result.insufficientFunds, true);
    const fromBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [ids.wallets[0], 'USD']
    );
    assert.equal(Number(fromBal.rows[0].amount), 1000);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b p2p idempotency replay', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    transactions: [uuidv4(), uuidv4()],
  };
  const idem = `phase1b-${uuidv4()}`;
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 9000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const first = await commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2000,
      receivedCurrency: 'USD',
      receivedAmount: 2000,
      tx: {
        id: ids.transactions[0],
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[1],
        amount: 2000,
        currency: 'USD',
        debitAmount: 2000,
        debitCurrency: 'USD',
        senderCrossCurrency: false,
        receivedAmount: 2000,
        receivedCurrency: 'USD',
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: 'phase1b-replay',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: idem,
      userId: ids.users[0],
      responseBody: { tx: ids.transactions[0] },
      senderLimitTracking: null,
      stateDb: null,
      recipientUserId: ids.users[1],
    });

    const second = await commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2000,
      receivedCurrency: 'USD',
      receivedAmount: 2000,
      tx: {
        id: ids.transactions[1],
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[1],
        amount: 2000,
        currency: 'USD',
        debitAmount: 2000,
        debitCurrency: 'USD',
        senderCrossCurrency: false,
        receivedAmount: 2000,
        receivedCurrency: 'USD',
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: 'phase1b-replay-2',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: idem,
      userId: ids.users[0],
      responseBody: { tx: ids.transactions[1] },
      senderLimitTracking: null,
      stateDb: null,
      recipientUserId: ids.users[1],
    });

    assert.equal(first.replay, false);
    assert.equal(second.replay, true);

    const txCount = await client.query(
      'SELECT COUNT(*)::int AS count FROM transactions WHERE from_wallet_id = $1 AND to_wallet_id = $2',
      [ids.wallets[0], ids.wallets[1]]
    );
    assert.equal(txCount.rows[0].count, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b p2p concurrent double-spend blocked', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4(), uuidv4()],
    transactions: [uuidv4(), uuidv4()],
  };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 10000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedWallet(client, { userId: ids.users[2], walletId: ids.wallets[2], currency: 'USD', amount: 0 });

    const payload = (txId, toWalletId, recipientUserId, key) => commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId,
      debitCurrency: 'USD',
      debitAmount: 7000,
      receivedCurrency: 'USD',
      receivedAmount: 7000,
      tx: {
        id: txId,
        fromWalletId: ids.wallets[0],
        toWalletId,
        amount: 7000,
        currency: 'USD',
        debitAmount: 7000,
        debitCurrency: 'USD',
        senderCrossCurrency: false,
        receivedAmount: 7000,
        receivedCurrency: 'USD',
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: 'phase1b-concurrent',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: key,
      userId: ids.users[0],
      responseBody: { tx: txId },
      senderLimitTracking: null,
      stateDb: null,
      recipientUserId,
    });

    const [a, b] = await Promise.all([
      payload(ids.transactions[0], ids.wallets[1], ids.users[1], `phase1b-${uuidv4()}`),
      payload(ids.transactions[1], ids.wallets[2], ids.users[2], `phase1b-${uuidv4()}`),
    ]);

    const results = [a, b];
    const successCount = results.filter((r) => !r.replay && !r.insufficientFunds).length;
    const insufficientCount = results.filter((r) => r.insufficientFunds).length;
    assert.equal(successCount, 1);
    assert.equal(insufficientCount, 1);

    const fromBal = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [ids.wallets[0], 'USD']
    );
    assert.equal(Number(fromBal.rows[0].amount), 3000);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b p2p runtime-state sync upserts missing relational users and wallets', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    transactions: [uuidv4()],
  };
  const stateDb = {
    _dbVersion: 0,
    users: [
      { id: ids.users[0], email: `${ids.users[0]}@runtime.test`, passwordHash: 'x', region: 'US', role: 'individual', createdAt: Date.now() },
      { id: ids.users[1], email: `${ids.users[1]}@runtime.test`, passwordHash: 'x', region: 'US', role: 'individual', createdAt: Date.now() },
    ],
    // Sender's true (JSON-only, pre-migration) balance is 9000. commitP2PSendPostgres's
    // `stateDb` contract is POST-mutation (the caller — index.js — always mutates the
    // JSON balances in-memory before calling), so this reflects sender at
    // 9000 - 1500 = 7500 and receiver at 0 + 1500 = 1500 *after* the send,
    // exactly like every real caller. The Postgres backfill-on-first-touch
    // path reconstructs the correct pre-operation amount (9000 / 0) from
    // this post-mutation snapshot plus the pending debit/credit.
    wallets: [
      { id: ids.wallets[0], userId: ids.users[0], balances: [{ currency: 'USD', amount: 7500 }], createdAt: Date.now(), maxLimitUSD: 250000 },
      { id: ids.wallets[1], userId: ids.users[1], balances: [{ currency: 'USD', amount: 1500 }], createdAt: Date.now(), maxLimitUSD: 250000 },
    ],
    transactions: [],
    paymentRequests: [],
    ledger: [],
  };
  try {
    const result = await commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 1500,
      receivedCurrency: 'USD',
      receivedAmount: 1500,
      tx: {
        id: ids.transactions[0],
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[1],
        amount: 1500,
        currency: 'USD',
        debitAmount: 1500,
        debitCurrency: 'USD',
        senderCrossCurrency: false,
        receivedAmount: 1500,
        receivedCurrency: 'USD',
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: 'runtime-sync',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: `phase1b-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb,
      recipientUserId: ids.users[1],
    });

    assert.equal(result.replay, false);
    assert.equal(result.insufficientFunds, false);
    const userRows = await client.query('SELECT COUNT(*)::int AS c FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
    const walletRows = await client.query('SELECT COUNT(*)::int AS c FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
    const senderBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const receiverBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[1], 'USD']);
    assert.equal(userRows.rows[0].c, 2);
    assert.equal(walletRows.rows[0].c, 2);
    assert.equal(Number(senderBal.rows[0].amount), 7500);
    assert.equal(Number(receiverBal.rows[0].amount), 1500);
  } finally {
    try { await client.query('DELETE FROM runtime_db_state WHERE id = 1'); } catch (_) {}
    await cleanup(client, ids);
    client.release();
  }
});
