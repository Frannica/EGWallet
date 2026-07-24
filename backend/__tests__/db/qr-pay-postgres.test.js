'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitQrPayPostgres } = require('../../db/qrPayPostgres');

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
    [userId, `${userId}@qrpay.test`]
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

async function seedPendingPaymentRequest(client, { requestId, requesterId, walletId, amount, currency }) {
  await client.query(
    `INSERT INTO payment_requests (id, requester_id, wallet_id, amount, currency, status, type, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', 'personal_request', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [requestId, requesterId, walletId, amount, currency]
  );
}

function buildTx({ id, fromWalletId, toWalletId, amount, currency, memo }) {
  return {
    id,
    fromWalletId,
    toWalletId,
    amount,
    currency,
    receivedAmount: amount,
    receivedCurrency: currency,
    wasConverted: false,
    memo,
    type: 'qr_payment',
    status: 'completed',
    timestamp: Date.now(),
  };
}

async function cleanup(client, ids) {
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM ledger WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  if (ids.requests?.length) {
    await client.query('DELETE FROM payment_requests WHERE id = ANY($1::uuid[])', [ids.requests]);
  }
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

test('qr-pay: static QR payment atomically debits sender and credits recipient via Postgres ledger', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [uuidv4()], requests: [] };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 10000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const result = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 2500,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2500, currency: 'USD', memo: 'QR Payment' }),
      clientKey: `qr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      requestId: null,
      recipientUserId: ids.users[1],
    });

    assert.equal(result.replay, false);
    assert.equal(result.insufficientFunds, false);

    const fromBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const toBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[1], 'USD']);
    assert.equal(Number(fromBal.rows[0].amount), 7500);
    assert.equal(Number(toBal.rows[0].amount), 2500);

    const ledgerRows = await client.query('SELECT type, amount FROM ledger WHERE wallet_id = ANY($1::text[]) ORDER BY type', [ids.wallets]);
    assert.equal(ledgerRows.rowCount, 2);
    const types = ledgerRows.rows.map((r) => r.type).sort();
    assert.deepEqual(types, ['qr_payment_credit', 'qr_payment_debit']);

    const txRow = await client.query('SELECT status, type FROM transactions WHERE id = $1', [ids.transactions[0]]);
    assert.equal(txRow.rows[0].status, 'completed');
    assert.equal(txRow.rows[0].type, 'qr_payment');
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('qr-pay: insufficient funds is rejected and rolled back, balance untouched', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [uuidv4()], requests: [] };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 500 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const result = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 2500,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2500, currency: 'USD', memo: 'QR Payment' }),
      clientKey: `qr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      requestId: null,
      recipientUserId: ids.users[1],
    });

    assert.equal(result.insufficientFunds, true);
    const fromBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(Number(fromBal.rows[0].amount), 500);
    const txCount = await client.query('SELECT COUNT(*)::int AS c FROM transactions WHERE id = $1', [ids.transactions[0]]);
    assert.equal(txCount.rows[0].c, 0);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('qr-pay: idempotency replay returns the original response and never double-charges', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [uuidv4(), uuidv4()], requests: [] };
  const idem = `qr-${uuidv4()}`;
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 9000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const first = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 2000,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2000, currency: 'USD', memo: 'QR Payment' }),
      clientKey: idem,
      userId: ids.users[0],
      responseBody: { tx: ids.transactions[0] },
      senderLimitTracking: null,
      stateDb: null,
      requestId: null,
      recipientUserId: ids.users[1],
    });

    const second = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 2000,
      tx: buildTx({ id: ids.transactions[1], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2000, currency: 'USD', memo: 'QR Payment' }),
      clientKey: idem,
      userId: ids.users[0],
      responseBody: { tx: ids.transactions[1] },
      senderLimitTracking: null,
      stateDb: null,
      requestId: null,
      recipientUserId: ids.users[1],
    });

    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(second.response.tx, ids.transactions[0]);

    const txCount = await client.query('SELECT COUNT(*)::int AS c FROM transactions WHERE from_wallet_id = $1', [ids.wallets[0]]);
    assert.equal(txCount.rows[0].c, 1);
    const fromBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(Number(fromBal.rows[0].amount), 7000);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('qr-pay: dynamic QR (payment-request-linked) marks the request paid and blocks re-payment', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [uuidv4(), uuidv4()], requests: [uuidv4()] };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 5000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedPendingPaymentRequest(client, {
      requestId: ids.requests[0], requesterId: ids.users[1], walletId: ids.wallets[1], amount: 1000, currency: 'USD',
    });

    const first = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 1000,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 1000, currency: 'USD', memo: 'QR Payment' }),
      clientKey: `qr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      requestId: ids.requests[0],
      recipientUserId: ids.users[1],
    });
    assert.equal(first.replay, false);
    assert.equal(first.insufficientFunds, false);

    const reqRow = await client.query('SELECT status, transaction_id FROM payment_requests WHERE id = $1', [ids.requests[0]]);
    assert.equal(reqRow.rows[0].status, 'paid');
    assert.equal(reqRow.rows[0].transaction_id, ids.transactions[0]);

    // Duplicate-scan protection: paying the SAME single-use dynamic QR again must be rejected,
    // and must NOT move any money the second time.
    const second = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 1000,
      tx: buildTx({ id: ids.transactions[1], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 1000, currency: 'USD', memo: 'QR Payment' }),
      clientKey: `qr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      requestId: ids.requests[0],
      recipientUserId: ids.users[1],
    });
    assert.equal(second.alreadyProcessed, true);

    const fromBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    assert.equal(Number(fromBal.rows[0].amount), 4000); // only the first 1000 debit applied
    const txCount = await client.query('SELECT COUNT(*)::int AS c FROM transactions WHERE id = $1', [ids.transactions[1]]);
    assert.equal(txCount.rows[0].c, 0);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('qr-pay: concurrent duplicate scans of the same dynamic QR — exactly one succeeds', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4(), uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4(), uuidv4()], transactions: [uuidv4(), uuidv4()], requests: [uuidv4()] };
  try {
    await seedWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 10000 });
    await seedWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedWallet(client, { userId: ids.users[2], walletId: ids.wallets[2], currency: 'USD', amount: 10000 });
    await seedPendingPaymentRequest(client, {
      requestId: ids.requests[0], requesterId: ids.users[1], walletId: ids.wallets[1], amount: 1500, currency: 'USD',
    });

    const attempt = (fromWalletId, payerId, txId) => commitQrPayPostgres({
      fromWalletId,
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 1500,
      tx: buildTx({ id: txId, fromWalletId, toWalletId: ids.wallets[1], amount: 1500, currency: 'USD', memo: 'QR Payment' }),
      clientKey: `qr-${uuidv4()}`,
      userId: payerId,
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb: null,
      requestId: ids.requests[0],
      recipientUserId: ids.users[1],
    });

    const [a, b] = await Promise.all([
      attempt(ids.wallets[0], ids.users[0], ids.transactions[0]),
      attempt(ids.wallets[2], ids.users[2], ids.transactions[1]),
    ]);

    const results = [a, b];
    const successCount = results.filter((r) => !r.alreadyProcessed && !r.requestNotFound).length;
    const blockedCount = results.filter((r) => r.alreadyProcessed).length;
    assert.equal(successCount, 1);
    assert.equal(blockedCount, 1);

    const toBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[1], 'USD']);
    assert.equal(Number(toBal.rows[0].amount), 1500); // credited exactly once, never twice
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});
