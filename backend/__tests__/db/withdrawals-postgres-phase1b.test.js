'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { createWithdrawal, adminTransition } = require('../../withdrawalEngine');
const {
  commitCreateWithdrawalPostgres,
  commitWithdrawalTransitionPostgres,
} = require('../../db/withdrawalsPostgres');

function requireDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
}

function makeRuntimeDb({ userId, walletId, balanceAmount, currency = 'USD' }) {
  return {
    _dbVersion: 0,
    users: [{ id: userId, limitTracking: {} }],
    wallets: [{ id: walletId, userId, balances: [{ currency, amount: balanceAmount }], holdBalance: {} }],
    transactions: [],
    paymentRequests: [],
    virtualCards: [],
    budgets: [],
    devices: [],
    supportTickets: [],
    fraudAlerts: [],
    savedContacts: [],
    qrCodes: [],
    refreshTokens: [],
    auditLog: [],
    employers: [],
    employerEmployees: [],
    payrollBatches: [],
    demoIntents: [],
    notifications: [],
    passwordResetTokens: [],
    idempotencyRecords: [],
    withdrawals: [],
    ledger: [],
    kycIdentityClaims: {},
    payoutLocks: [],
    rates: { base: 'USD', values: { USD: 1 }, updatedAt: Date.now() },
  };
}

function cloneDb(db) {
  return JSON.parse(JSON.stringify(db));
}

async function seedBaseRows(client, { userId, walletId, currency, amount }) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS runtime_db_state (
      id INT PRIMARY KEY,
      version BIGINT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at, limit_tracking)
     VALUES ($1, $2, 'x', 'US', 'individual', NOW(), '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@withdrawals-phase1b.test`]
  );
  await client.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd)
     VALUES ($1, $2, NOW(), 250000)
     ON CONFLICT (id) DO NOTHING`,
    [walletId, userId]
  );
  await client.query(
    `INSERT INTO wallet_balances(wallet_id, currency, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
    [walletId, currency, amount]
  );
  await client.query(
    `INSERT INTO wallet_holds(wallet_id, currency, amount)
     VALUES ($1, $2, 0)
     ON CONFLICT (wallet_id, currency) DO NOTHING`,
    [walletId, currency]
  );
}

async function cleanup(client, ids) {
  await client.query('DELETE FROM payout_locks WHERE withdrawal_id = ANY($1::uuid[])', [ids.withdrawals]);
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM ledger WHERE withdrawal_id = ANY($1::uuid[])', [ids.withdrawals]);
  await client.query('DELETE FROM withdrawals WHERE id = ANY($1::uuid[])', [ids.withdrawals]);
  await client.query('DELETE FROM wallet_holds WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
  try {
    await client.query('DELETE FROM runtime_db_state WHERE id = 1');
  } catch (_) {}
}

test('phase1b-e create + idempotency replay', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], withdrawals: [] };
  const currency = 'USD';
  try {
    await seedBaseRows(client, { userId: ids.users[0], walletId: ids.wallets[0], currency, amount: 5000 });
    const db = makeRuntimeDb({ userId: ids.users[0], walletId: ids.wallets[0], balanceAmount: 5000, currency });
    const created = createWithdrawal(db, ids.users[0], {
      walletId: ids.wallets[0],
      amount: 1200,
      currency,
      method: 'bank',
      isInternational: false,
      feeAmount: 10,
      feeRate: 0.0083,
      netPayout: 1190,
      country: 'US',
      bankName: 'Test Bank',
      accountNumber: '1234567890',
      accountHolderName: 'Test User',
    });
    ids.withdrawals.push(created.id);

    const responseBody = { withdrawal: created, feeBreakdown: { youSend: 1200, fee: 10, theyReceive: 1190, currency } };
    const first = await commitCreateWithdrawalPostgres({
      stateDb: db,
      withdrawal: created,
      userId: ids.users[0],
      clientKey: 'wd-key-1',
      responseBody,
      userLimitTracking: db.users[0].limitTracking,
      skipRuntimeStateSync: true,
    });
    assert.equal(first.replay, false);

    const replay = await commitCreateWithdrawalPostgres({
      stateDb: db,
      withdrawal: created,
      userId: ids.users[0],
      clientKey: 'wd-key-1',
      responseBody,
      userLimitTracking: db.users[0].limitTracking,
      skipRuntimeStateSync: true,
    });
    assert.equal(replay.replay, true);

    const row = await client.query('SELECT status, amount FROM withdrawals WHERE id = $1', [created.id]);
    assert.equal(row.rows[0].status, 'pending_review');
    assert.equal(Number(row.rows[0].amount), 1200);

    const bal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], currency]);
    const hold = await client.query('SELECT amount FROM wallet_holds WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], currency]);
    assert.equal(Number(bal.rows[0].amount), 3800);
    assert.equal(Number(hold.rows[0].amount), 1200);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-e approve transition', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], withdrawals: [] };
  try {
    await seedBaseRows(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 3000 });
    const db = makeRuntimeDb({ userId: ids.users[0], walletId: ids.wallets[0], balanceAmount: 3000, currency: 'USD' });
    const w = createWithdrawal(db, ids.users[0], {
      walletId: ids.wallets[0], amount: 1000, currency: 'USD', method: 'bank', isInternational: false, feeAmount: 0, feeRate: 0, netPayout: 1000,
    });
    ids.withdrawals.push(w.id);
    await commitCreateWithdrawalPostgres({ stateDb: db, withdrawal: w, userId: ids.users[0], clientKey: 'wd-key-2', responseBody: { withdrawal: w }, userLimitTracking: {}, skipRuntimeStateSync: true });

    const updated = adminTransition(db, w.id, 'approved', 'admin-1', null);
    const t = await commitWithdrawalTransitionPostgres({ stateDb: db, withdrawal: updated, expectedStatus: 'pending_review', skipRuntimeStateSync: true });
    assert.equal(t.notFound, false);
    const row = await client.query('SELECT status, approved_at FROM withdrawals WHERE id = $1', [w.id]);
    assert.equal(row.rows[0].status, 'approved');
    assert.ok(row.rows[0].approved_at);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-e paid transition releases hold only', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], withdrawals: [] };
  try {
    await seedBaseRows(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 2500 });
    const db = makeRuntimeDb({ userId: ids.users[0], walletId: ids.wallets[0], balanceAmount: 2500, currency: 'USD' });
    const w = createWithdrawal(db, ids.users[0], {
      walletId: ids.wallets[0], amount: 900, currency: 'USD', method: 'bank', isInternational: false, feeAmount: 0, feeRate: 0, netPayout: 900,
    });
    ids.withdrawals.push(w.id);
    await commitCreateWithdrawalPostgres({ stateDb: db, withdrawal: w, userId: ids.users[0], clientKey: 'wd-key-3', responseBody: { withdrawal: w }, userLimitTracking: {}, skipRuntimeStateSync: true });

    const approved = adminTransition(db, w.id, 'approved', 'admin-1', null);
    await commitWithdrawalTransitionPostgres({ stateDb: db, withdrawal: approved, expectedStatus: 'pending_review', skipRuntimeStateSync: true });
    const processing = adminTransition(db, w.id, 'processing', 'admin-1', null);
    await commitWithdrawalTransitionPostgres({ stateDb: db, withdrawal: processing, expectedStatus: 'approved', skipRuntimeStateSync: true });
    w.payoutSettled = true;
    w.payoutProvider = 'stripe';
    w.payoutReference = `po_${uuidv4().replace(/-/g, '')}`;
    const paid = adminTransition(db, w.id, 'paid', 'admin-1', null);
    await commitWithdrawalTransitionPostgres({ stateDb: db, withdrawal: paid, expectedStatus: 'processing', skipRuntimeStateSync: true });

    const hold = await client.query('SELECT amount FROM wallet_holds WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const bal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const row = await client.query('SELECT status, hold_released FROM withdrawals WHERE id = $1', [w.id]);
    assert.equal(Number(hold.rows[0].amount), 0);
    assert.equal(Number(bal.rows[0].amount), 1600);
    assert.equal(row.rows[0].status, 'paid');
    assert.equal(row.rows[0].hold_released, true);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-e failed transition refunds once (rollback/refund)', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], withdrawals: [] };
  try {
    await seedBaseRows(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 4000 });
    const db = makeRuntimeDb({ userId: ids.users[0], walletId: ids.wallets[0], balanceAmount: 4000, currency: 'USD' });
    const w = createWithdrawal(db, ids.users[0], {
      walletId: ids.wallets[0], amount: 1100, currency: 'USD', method: 'bank', isInternational: false, feeAmount: 0, feeRate: 0, netPayout: 1100,
    });
    ids.withdrawals.push(w.id);
    await commitCreateWithdrawalPostgres({ stateDb: db, withdrawal: w, userId: ids.users[0], clientKey: 'wd-key-4', responseBody: { withdrawal: w }, userLimitTracking: {}, skipRuntimeStateSync: true });

    const failed = adminTransition(db, w.id, 'failed', 'admin-1', 'manual failure');
    await commitWithdrawalTransitionPostgres({ stateDb: db, withdrawal: failed, expectedStatus: 'pending_review', skipRuntimeStateSync: true });

    const bal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const hold = await client.query('SELECT amount FROM wallet_holds WHERE wallet_id = $1 AND currency = $2', [ids.wallets[0], 'USD']);
    const row = await client.query('SELECT status, refund_issued FROM withdrawals WHERE id = $1', [w.id]);
    assert.equal(Number(bal.rows[0].amount), 4000);
    assert.equal(Number(hold.rows[0].amount), 0);
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].refund_issued, true);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('phase1b-e concurrent transition prevention', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { users: [uuidv4()], wallets: [uuidv4()], withdrawals: [] };
  try {
    await seedBaseRows(client, { userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 4500 });
    const db = makeRuntimeDb({ userId: ids.users[0], walletId: ids.wallets[0], balanceAmount: 4500, currency: 'USD' });
    const w = createWithdrawal(db, ids.users[0], {
      walletId: ids.wallets[0], amount: 1000, currency: 'USD', method: 'bank', isInternational: false, feeAmount: 0, feeRate: 0, netPayout: 1000,
    });
    ids.withdrawals.push(w.id);
    await commitCreateWithdrawalPostgres({ stateDb: db, withdrawal: w, userId: ids.users[0], clientKey: 'wd-key-5', responseBody: { withdrawal: w }, userLimitTracking: {}, skipRuntimeStateSync: true });

    const aDb = cloneDb(db);
    const bDb = cloneDb(db);
    const aW = adminTransition(aDb, w.id, 'approved', 'admin-A', null);
    const bW = adminTransition(bDb, w.id, 'failed', 'admin-B', null);

    const [a, b] = await Promise.allSettled([
      commitWithdrawalTransitionPostgres({ stateDb: aDb, withdrawal: aW, expectedStatus: 'pending_review', skipRuntimeStateSync: true }),
      commitWithdrawalTransitionPostgres({ stateDb: bDb, withdrawal: bW, expectedStatus: 'pending_review', skipRuntimeStateSync: true }),
    ]);
    const applied = [a, b].filter((r) => r.status === 'fulfilled' && r.value && !r.value.conflict).length;
    const conflict = [a, b].filter((r) => r.status === 'fulfilled' && r.value && r.value.conflict).length;
    assert.equal(applied, 1);
    assert.equal(conflict, 1);

    const row = await client.query('SELECT status FROM withdrawals WHERE id = $1', [w.id]);
    assert.ok(['approved', 'failed'].includes(row.rows[0].status));
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});
