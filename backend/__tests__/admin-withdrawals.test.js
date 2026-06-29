'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.PGSSLMODE = process.env.PGSSLMODE || 'disable';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

const FALLBACK_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

let pool;
let server;
let baseUrl;
let superToken;
let superCsrf;
let testUserId;
let postgresReady = false;

const appStateStore = require('../db/appStateStore');
const originalLoad = appStateStore.loadAppState;
const originalSave = appStateStore.saveAppState;
let testDb;

const withdrawalIds = {
  pending: uuidv4(),
  processing: uuidv4(),
  failed: uuidv4(),
  completed: uuidv4(),
};

function buildTestDb() {
  testUserId = uuidv4();
  const now = Date.now();
  return {
    users: [{ id: testUserId, email: 'wd-user@test.local', kycStatus: 'pending', kycTier: 0, accountStatus: 'active', createdAt: now }],
    wallets: [{ id: uuidv4(), userId: testUserId, balances: [{ currency: 'USD', amount: 500000 }], holdBalance: {} }],
    transactions: [],
    withdrawals: [
      { id: withdrawalIds.pending, userId: testUserId, amount: 1000, currency: 'USD', status: 'pending_review', method: 'bank', country: 'GQ', createdAt: now - 4000, updatedAt: now - 4000, statusHistory: [{ status: 'pending_review', at: now - 4000, by: 'system' }] },
      { id: withdrawalIds.processing, userId: testUserId, amount: 2000, currency: 'USD', status: 'processing', method: 'bank', country: 'GQ', createdAt: now - 3000, updatedAt: now - 3000, statusHistory: [{ status: 'pending_review', at: now - 3000, by: 'system' }, { status: 'processing', at: now - 2500, by: 'admin@test' }] },
      { id: withdrawalIds.failed, userId: testUserId, amount: 3000, currency: 'USD', status: 'failed', method: 'bank', country: 'GQ', createdAt: now - 2000, updatedAt: now - 2000, statusHistory: [{ status: 'pending_review', at: now - 2000, by: 'system' }, { status: 'failed', at: now - 1500, by: 'admin@test' }] },
      { id: withdrawalIds.completed, userId: testUserId, amount: 4000, currency: 'USD', status: 'paid', method: 'bank', country: 'GQ', createdAt: now - 1000, updatedAt: now - 1000, statusHistory: [{ status: 'pending_review', at: now - 1000, by: 'system' }, { status: 'paid', at: now - 500, by: 'system' }] },
    ],
    ledger: [{ id: uuidv4(), withdrawalId: withdrawalIds.pending, type: 'withdrawal_hold', amount: -1000, currency: 'USD', createdAt: now }],
    kyc: [],
    auditLog: [],
  };
}

function patchAppState() {
  testDb = buildTestDb();
  appStateStore.loadAppState = () => testDb;
  appStateStore.saveAppState = (state) => {
    testDb = state;
    return state;
  };
}

function restoreAppState() {
  appStateStore.loadAppState = originalLoad;
  appStateStore.saveAppState = originalSave;
}

async function pickDatabaseUrl() {
  for (const url of [process.env.DATABASE_URL, FALLBACK_DATABASE_URL].filter(Boolean)) {
    const client = new Client({ connectionString: url, ssl: false });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return url;
    } catch {
      try { await client.end(); } catch (_) {}
    }
  }
  return null;
}

function postHeaders(token, csrf) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
}

async function startServer() {
  patchAppState();
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-withdrawals-test-jwt-secret';

  const { adminLoginHandler } = require('../adminAuth');
  const withdrawalsPg = require('../db/withdrawalsPostgres');
  withdrawalsPg.commitWithdrawalStateUpdate = async (stateDb) => {
    appStateStore.saveAppState(stateDb);
    return { notFound: false, conflict: false };
  };
  delete require.cache[require.resolve('../adminWithdrawals')];
  const { router: adminWithdrawalsRouter } = require('../adminWithdrawals');
  const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');

  await ensureAdminPlatformTables();
  await pool.query(`DELETE FROM admin_users WHERE email = 'wd-admin@test.local'`).catch(() => {});
  await createAdminUser({ email: 'wd-admin@test.local', password: 'WdAdminPass123!', role: 'super_admin' });

  const app = express();
  app.use(express.json());
  app.locals.withBalanceMutex = async (fn) => fn();
  app.locals.logger = { info: () => {}, warn: () => {}, error: () => {} };
  app.post('/admin/auth/login', adminLoginHandler);
  app.use('/admin/withdrawals', adminWithdrawalsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.before(async () => {
  const databaseUrl = await pickDatabaseUrl();
  if (!databaseUrl) return;
  process.env.DATABASE_URL = databaseUrl;
  ({ pool } = require('../db/pool'));
  try {
    await require('../db/adminPlatformPostgres').ensureAdminPlatformTables();
    postgresReady = true;
  } catch {
    postgresReady = false;
    return;
  }
  await startServer();
  const login = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'wd-admin@test.local', password: 'WdAdminPass123!' }),
  });
  const body = await login.json();
  superToken = body.token;
  superCsrf = body.csrfToken;
});

test.after(async () => {
  restoreAppState();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) {
    await pool.query(`DELETE FROM admin_users WHERE email = 'wd-admin@test.local'`).catch(() => {});
    await pool.end();
  }
});

test('withdrawals list empty state shape', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  testDb.withdrawals = [];
  const res = await fetch(`${baseUrl}/admin/withdrawals?queue=pending`, {
    headers: { Authorization: `Bearer ${superToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data, []);
  assert.equal(body.totalItems, 0);
  assert.ok(Array.isArray(body.withdrawals));
});

test('withdrawals queue filters return correct statuses', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  patchAppState();

  for (const [queue, expectedId] of Object.entries({
    pending: withdrawalIds.pending,
    processing: withdrawalIds.processing,
    failed: withdrawalIds.failed,
    completed: withdrawalIds.completed,
  })) {
    const res = await fetch(`${baseUrl}/admin/withdrawals?queue=${queue}`, {
      headers: { Authorization: `Bearer ${superToken}` },
    });
    assert.equal(res.status, 200, queue);
    const body = await res.json();
    assert.ok(body.data.some((w) => w.id === expectedId), queue);
  }
});

test('withdrawal detail response includes ledger aliases', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/withdrawals/${withdrawalIds.pending}`, {
    headers: { Authorization: `Bearer ${superToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.withdrawal);
  assert.ok(Array.isArray(body.ledger));
  assert.ok(Array.isArray(body.ledgerEntries));
  assert.equal(body.ledger.length, body.ledgerEntries.length);
});

test('withdrawal approve transition and audit log', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  patchAppState();
  const res = await fetch(`${baseUrl}/admin/withdrawals/${withdrawalIds.pending}/transition`, {
    method: 'POST',
    headers: postHeaders(superToken, superCsrf),
    body: JSON.stringify({ status: 'approved', note: 'test approve' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.withdrawal.status, 'approved');
  const { getAdminAuditLogs } = require('../adminAudit');
  assert.ok(getAdminAuditLogs({ limit: 20 }).some((l) => l.action === 'WITHDRAWAL_TRANSITION'));
});

test('terminal failed withdrawal cannot transition again', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/withdrawals/${withdrawalIds.failed}/transition`, {
    method: 'POST',
    headers: postHeaders(superToken, superCsrf),
    body: JSON.stringify({ status: 'approved', note: 'should fail' }),
  });
  assert.equal(res.status, 409);
});

test('CSRF required for withdrawal transition', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  patchAppState();
  const res = await fetch(`${baseUrl}/admin/withdrawals/${withdrawalIds.pending}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${superToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(res.status, 403);
});
