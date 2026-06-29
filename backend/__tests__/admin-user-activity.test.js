'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.PGSSLMODE = process.env.PGSSLMODE || 'disable';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

const FALLBACK_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

let pool;
let server;
let baseUrl;
let adminToken;
let adminCsrf;
let testUserId;
let testDb;
let postgresReady = false;

const appStateStore = require('../db/appStateStore');
const originalLoad = appStateStore.loadAppState;
const originalSave = appStateStore.saveAppState;

function buildTestDb() {
  testUserId = uuidv4();
  const walletId = uuidv4();
  const now = Date.now();
  return {
    users: [{
      id: testUserId,
      email: 'activity-user@test.local',
      kycTier: 1,
      kycStatus: 'approved',
      accountStatus: 'active',
      createdAt: now,
      limitTracking: {
        dailyUsedUSD: 150,
        weeklyUsedUSD: 400,
        monthlyUsedUSD: 900,
        dayKey: new Date().toISOString().slice(0, 10),
        weekKey: '2026-26',
        monthKey: new Date().toISOString().slice(0, 7),
      },
    }],
    wallets: [{ id: walletId, userId: testUserId, balances: [{ currency: 'USD', amount: 50000 }], holdBalance: {} }],
    transactions: [
      { id: uuidv4(), type: 'deposit', amount: 10000, currency: 'USD', toWalletId: walletId, status: 'completed', createdAt: now - 5000 },
      { id: uuidv4(), type: 'exchange', amount: 2000, currency: 'USD', fromWalletId: walletId, toWalletId: walletId, status: 'completed', createdAt: now - 4000 },
      { id: uuidv4(), type: 'qr_payment', amount: 500, currency: 'USD', fromWalletId: walletId, toWalletId: walletId, status: 'completed', createdAt: now - 3000 },
    ],
    paymentRequests: [{ id: uuidv4(), userId: testUserId, walletId, amount: 700, currency: 'USD', status: 'pending', createdAt: now - 2000 }],
    withdrawals: [{ id: uuidv4(), userId: testUserId, amount: 800, currency: 'USD', status: 'pending_review', method: 'bank', createdAt: now - 1000 }],
    virtualCards: [{ id: uuidv4(), userId: testUserId, walletId, last4: '4242', currency: 'USD', label: 'Test Card', status: 'active', spentToday: 100, dailyLimit: 100000, createdAt: now }],
    qrCodes: [{ id: uuidv4(), userId: testUserId, type: 'dynamic', used: false, createdAt: now, payload: { amount: 500, currency: 'USD', memo: 'QR test' } }],
    kyc: [], auditLog: [],
  };
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

test.before(async () => {
  const databaseUrl = await pickDatabaseUrl();
  if (!databaseUrl) return;
  process.env.DATABASE_URL = databaseUrl;
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-user-activity-test-jwt';

  testDb = buildTestDb();
  appStateStore.loadAppState = () => testDb;
  appStateStore.saveAppState = (s) => {
    testDb = s;
    return s;
  };

  ({ pool } = require('../db/pool'));
  const { adminLoginHandler } = require('../adminAuth');
  const adminUsersRouter = require('../adminUsers');
  const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');

  await ensureAdminPlatformTables();
  await pool.query(`DELETE FROM admin_users WHERE email = 'activity-admin@test.local'`).catch(() => {});
  await createAdminUser({ email: 'activity-admin@test.local', password: 'ActivityAdmin123!', role: 'super_admin' });

  const app = express();
  app.use(express.json());
  app.post('/admin/auth/login', adminLoginHandler);
  app.use('/admin/users', adminUsersRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'activity-admin@test.local', password: 'ActivityAdmin123!' }),
  });
  const body = await login.json();
  adminToken = body.token;
  adminCsrf = body.csrfToken;
  postgresReady = true;
});

test.after(async () => {
  appStateStore.loadAppState = originalLoad;
  appStateStore.saveAppState = originalSave;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) {
    await pool.query(`DELETE FROM admin_users WHERE email = 'activity-admin@test.local'`).catch(() => {});
    await pool.end();
  }
});

test('user detail includes limits, activity counts, and sync hint', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.limits?.daily?.limitUSD);
  assert.equal(body.activityCounts.deposits, 1);
  assert.equal(body.activityCounts.exchanges, 1);
  assert.equal(body.activityCounts.qr_payments, 1);
  assert.equal(body.virtualCards.length, 1);
  assert.ok(body.syncHint.includes('Refresh'));
});

test('activity endpoint paginates deposits and exchanges separately', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  for (const [category, expected] of [['deposits', 1], ['exchanges', 1], ['qr_payments', 1], ['virtual_cards', 1]]) {
    const res = await fetch(`${baseUrl}/admin/users/${testUserId}/activity?category=${category}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200, category);
    const body = await res.json();
    assert.equal(body.totalItems, expected, category);
  }
});

test('activity endpoint rejects invalid category', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}/activity?category=invalid`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 400);
});
