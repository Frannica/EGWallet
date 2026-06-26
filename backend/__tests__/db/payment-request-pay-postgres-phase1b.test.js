'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitPaymentRequestPayPostgres } = require('../../db/paymentRequestPayPostgres');

function requireDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
}

async function seedUserWallet(client, { userId, walletId, currency, amount }) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1, $2, 'x', 'US', 'individual', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@phase1b-pr.test`]
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

async function seedPaymentRequest(client, payload) {
  await client.query(
    `INSERT INTO payment_requests (
      id, requester_id, wallet_id, target_wallet_id, target_employer_id,
      amount, currency, memo, status, type, payroll_metadata, compliance_flags, created_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,NOW()
    )`,
    [
      payload.id,
      payload.requesterId,
      payload.walletId,
      payload.targetWalletId || null,
      payload.targetEmployerId || null,
      payload.amount,
      payload.currency,
      payload.memo || '',
      payload.status || 'pending',
      payload.type || 'personal_request',
      JSON.stringify(payload.payrollMetadata || null),
      JSON.stringify(payload.complianceFlags || null),
    ]
  );
}

async function cleanup(client, ids) {
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM payment_requests WHERE id = ANY($1::uuid[])', [ids.requests]);
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

function buildTx({ id, fromWalletId, toWalletId, amount, currency, memo }) {
  return {
    id,
    fromWalletId,
    toWalletId,
    amount,
    currency,
    debitAmount: amount,
    debitCurrency: currency,
    receivedAmount: amount,
    receivedCurrency: currency,
    wasConverted: false,
    fxFeeAmount: 0,
    sendFeeAmount: 0,
    memo,
    status: 'completed',
    timestamp: Date.now(),
    type: 'personal_request',
  };
}

test('phase1b-b payment request pay normal', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [uuidv4()],
    transactions: [uuidv4()],
  };
  try {
    await seedUserWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 10000 });
    await seedUserWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedPaymentRequest(client, {
      id: ids.requests[0],
      requesterId: ids.users[1],
      walletId: ids.wallets[1],
      amount: 2500,
      currency: 'USD',
      status: 'pending',
      type: 'personal_request',
    });

    const res = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2500,
      requestCurrency: 'USD',
      requestAmount: 2500,
      tx: buildTx({
        id: ids.transactions[0],
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[1],
        amount: 2500,
        currency: 'USD',
        memo: 'pay normal',
      }),
      clientKey: `phase1b-pr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb: null,
    });

    assert.equal(res.replay, false);
    const payer = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const payee = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[1], 'USD']);
    const req = await client.query('SELECT status, transaction_id FROM payment_requests WHERE id = $1', [ids.requests[0]]);
    assert.equal(Number(payer.rows[0].amount), 7500);
    assert.equal(Number(payee.rows[0].amount), 2500);
    assert.equal(req.rows[0].status, 'paid');
    assert.equal(req.rows[0].transaction_id, ids.transactions[0]);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-b payment request already processed replay', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [uuidv4()],
    transactions: [uuidv4(), uuidv4()],
  };
  const key = `phase1b-pr-${uuidv4()}`;
  try {
    await seedUserWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 10000 });
    await seedUserWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedPaymentRequest(client, {
      id: ids.requests[0],
      requesterId: ids.users[1],
      walletId: ids.wallets[1],
      amount: 2000,
      currency: 'USD',
      status: 'pending',
      type: 'personal_request',
    });

    await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2000,
      requestCurrency: 'USD',
      requestAmount: 2000,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2000, currency: 'USD', memo: 'replay first' }),
      clientKey: key,
      userId: ids.users[0],
      responseBody: { ok: true, tx: ids.transactions[0] },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb: null,
    });

    const replay = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2000,
      requestCurrency: 'USD',
      requestAmount: 2000,
      tx: buildTx({ id: ids.transactions[1], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2000, currency: 'USD', memo: 'replay second' }),
      clientKey: key,
      userId: ids.users[0],
      responseBody: { ok: true, tx: ids.transactions[1] },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb: null,
    });

    assert.equal(replay.replay, true);
    const txCount = await client.query('SELECT COUNT(*)::int AS c FROM transactions WHERE from_wallet_id = $1 AND to_wallet_id = $2', [ids.wallets[0], ids.wallets[1]]);
    assert.equal(txCount.rows[0].c, 1);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-b payment request insufficient funds', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [uuidv4()],
    transactions: [uuidv4()],
  };
  try {
    await seedUserWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 500 });
    await seedUserWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedPaymentRequest(client, {
      id: ids.requests[0],
      requesterId: ids.users[1],
      walletId: ids.wallets[1],
      amount: 2000,
      currency: 'USD',
      status: 'pending',
    });

    const res = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2000,
      requestCurrency: 'USD',
      requestAmount: 2000,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2000, currency: 'USD', memo: 'insufficient' }),
      clientKey: `phase1b-pr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb: null,
    });

    assert.equal(res.insufficientFunds, true);
    const req = await client.query('SELECT status FROM payment_requests WHERE id = $1', [ids.requests[0]]);
    assert.equal(req.rows[0].status, 'pending');
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-b payment request concurrent double-pay prevention', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [uuidv4()],
    transactions: [uuidv4(), uuidv4()],
  };
  try {
    await seedUserWallet(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 8000 });
    await seedUserWallet(client, { userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });
    await seedPaymentRequest(client, {
      id: ids.requests[0],
      requesterId: ids.users[1],
      walletId: ids.wallets[1],
      amount: 5000,
      currency: 'USD',
      status: 'pending',
    });

    const send1 = commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 5000,
      requestCurrency: 'USD',
      requestAmount: 5000,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 5000, currency: 'USD', memo: 'concurrent-1' }),
      clientKey: `phase1b-pr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true, tx: ids.transactions[0] },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb: null,
    });
    const send2 = commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 5000,
      requestCurrency: 'USD',
      requestAmount: 5000,
      tx: buildTx({ id: ids.transactions[1], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 5000, currency: 'USD', memo: 'concurrent-2' }),
      clientKey: `phase1b-pr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true, tx: ids.transactions[1] },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb: null,
    });

    const results = await Promise.all([send1, send2]);
    const successCount = results.filter((r) => !r.replay && !r.alreadyProcessed && !r.insufficientFunds && !r.requestNotFound).length;
    const processedCount = results.filter((r) => r.replay || r.alreadyProcessed).length;
    assert.equal(successCount, 1);
    assert.equal(processedCount, 1);

    const txCount = await client.query('SELECT COUNT(*)::int AS c FROM transactions WHERE from_wallet_id = $1 AND to_wallet_id = $2', [ids.wallets[0], ids.wallets[1]]);
    const req = await client.query('SELECT status, paid_by FROM payment_requests WHERE id = $1', [ids.requests[0]]);
    assert.equal(txCount.rows[0].c, 1);
    assert.equal(req.rows[0].status, 'paid');
    assert.equal(req.rows[0].paid_by, ids.users[0]);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-b payment request runtime-state sync upserts missing relational graph', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [uuidv4()],
    transactions: [uuidv4()],
  };
  const stateDb = {
    _dbVersion: 0,
    users: [
      { id: ids.users[0], email: `${ids.users[0]}@runtime.test`, passwordHash: 'x', region: 'US', role: 'individual', createdAt: Date.now() },
      { id: ids.users[1], email: `${ids.users[1]}@runtime.test`, passwordHash: 'x', region: 'US', role: 'individual', createdAt: Date.now() },
    ],
    wallets: [
      { id: ids.wallets[0], userId: ids.users[0], balances: [{ currency: 'USD', amount: 8000 }], createdAt: Date.now(), maxLimitUSD: 250000 },
      { id: ids.wallets[1], userId: ids.users[1], balances: [{ currency: 'USD', amount: 0 }], createdAt: Date.now(), maxLimitUSD: 250000 },
    ],
    paymentRequests: [
      {
        id: ids.requests[0],
        requesterId: ids.users[1],
        walletId: ids.wallets[1],
        amount: 2200,
        currency: 'USD',
        memo: 'runtime request',
        status: 'pending',
        type: 'personal_request',
        createdAt: Date.now(),
      },
    ],
    transactions: [],
    ledger: [],
  };
  try {
    const result = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 2200,
      requestCurrency: 'USD',
      requestAmount: 2200,
      tx: buildTx({ id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1], amount: 2200, currency: 'USD', memo: 'runtime pay' }),
      clientKey: `phase1b-pr-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb,
      skipRuntimeStateSync: true,
    });

    assert.equal(result.replay, false);
    const reqRow = await client.query('SELECT status, paid_by, transaction_id FROM payment_requests WHERE id = $1', [ids.requests[0]]);
    const payer = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const payee = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[1], 'USD']);
    assert.equal(reqRow.rowCount, 1);
    assert.equal(reqRow.rows[0].status, 'paid');
    assert.equal(reqRow.rows[0].paid_by, ids.users[0]);
    assert.equal(reqRow.rows[0].transaction_id, ids.transactions[0]);
    assert.equal(Number(payer.rows[0].amount), 5800);
    assert.equal(Number(payee.rows[0].amount), 2200);
  } finally {
    try { await client.query('DELETE FROM runtime_db_state WHERE id = 1'); } catch (_) {}
    await cleanup(client, ids);
    client.release();
  }
});
