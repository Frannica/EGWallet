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
let testUserId;
let cardId;
let testDb;
let postgresReady = false;

const appStateStore = require('../db/appStateStore');
const { recordVirtualCardCharge } = require('../virtualCardCharges');
const originalLoad = appStateStore.loadAppState;
const originalSave = appStateStore.saveAppState;

function buildTestDb() {
  testUserId = uuidv4();
  cardId = uuidv4();
  const walletId = uuidv4();
  const now = Date.now();
  return {
    users: [{
      id: testUserId,
      email: 'card-charges-user@test.local',
      kycTier: 1,
      accountStatus: 'active',
      createdAt: now,
    }],
    wallets: [{ id: walletId, userId: testUserId, balances: [{ currency: 'USD', amount: 50000 }] }],
    virtualCards: [{
      id: cardId,
      userId: testUserId,
      walletId,
      last4: '4242',
      currency: 'USD',
      label: 'Test Card',
      status: 'active',
      spentToday: 0,
      dailyLimit: 100000,
      createdAt: now,
    }],
    virtualCardCharges: [],
    transactions: [],
    paymentRequests: [],
    withdrawals: [],
    qrCodes: [],
    kyc: [],
    auditLog: [],
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-virtual-card-charges-test-jwt';

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
  await pool.query(`DELETE FROM admin_users WHERE email = 'card-charges-admin@test.local'`).catch(() => {});
  await createAdminUser({ email: 'card-charges-admin@test.local', password: 'CardChargesAdmin123!', role: 'super_admin' });

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
    body: JSON.stringify({ email: 'card-charges-admin@test.local', password: 'CardChargesAdmin123!' }),
  });
  const body = await login.json();
  adminToken = body.token;
  postgresReady = true;
});

test.after(async () => {
  appStateStore.loadAppState = originalLoad;
  appStateStore.saveAppState = originalSave;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) {
    await pool.query(`DELETE FROM admin_users WHERE email = 'card-charges-admin@test.local'`).catch(() => {});
    await pool.end();
  }
});

test('recordVirtualCardCharge persists charge and updates spentToday', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const result = recordVirtualCardCharge(testDb, {
    cardId,
    userId: testUserId,
    amount: 2500,
    currency: 'USD',
    merchant: 'Coffee Shop',
    status: 'completed',
    type: 'purchase',
    providerReference: 'prov-purchase-001',
    idempotencyKey: 'idem-purchase-001',
  });

  assert.equal(result.created, true);
  assert.equal(result.duplicate, false);
  assert.equal(testDb.virtualCardCharges.length, 1);
  assert.equal(testDb.virtualCardCharges[0].merchant, 'Coffee Shop');
  assert.equal(testDb.virtualCardCharges[0].type, 'purchase');

  const card = testDb.virtualCards.find((c) => c.id === cardId);
  assert.equal(card.spentToday, 2500);
});

test('duplicate providerReference or idempotencyKey does not create second record', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const dupByRef = recordVirtualCardCharge(testDb, {
    cardId,
    userId: testUserId,
    amount: 9999,
    currency: 'USD',
    type: 'purchase',
    providerReference: 'prov-purchase-001',
    idempotencyKey: 'different-key',
  });
  assert.equal(dupByRef.duplicate, true);
  assert.equal(testDb.virtualCardCharges.length, 1);

  const dupByKey = recordVirtualCardCharge(testDb, {
    cardId,
    userId: testUserId,
    amount: 9999,
    currency: 'USD',
    type: 'purchase',
    idempotencyKey: 'idem-purchase-001',
    providerReference: 'different-ref',
  });
  assert.equal(dupByKey.duplicate, true);
  assert.equal(testDb.virtualCardCharges.length, 1);
  assert.equal(testDb.virtualCards.find((c) => c.id === cardId).spentToday, 2500);
});

test('admin activity lists virtual card charges with empty state support', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  recordVirtualCardCharge(testDb, {
    cardId,
    userId: testUserId,
    amount: 500,
    currency: 'USD',
    merchant: 'Refund Store',
    status: 'completed',
    type: 'refund',
    providerReference: 'prov-refund-001',
    idempotencyKey: 'idem-refund-001',
  });

  recordVirtualCardCharge(testDb, {
    cardId,
    userId: testUserId,
    amount: 1200,
    currency: 'USD',
    merchant: 'Gas Station',
    status: 'declined',
    type: 'decline',
    providerReference: 'prov-decline-001',
    idempotencyKey: 'idem-decline-001',
  });

  const detailRes = await fetch(`${baseUrl}/admin/users/${testUserId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.activityCounts.virtual_card_charges, 3);
  assert.equal(detail.virtualCards[0].spentToday, 2000);

  const listRes = await fetch(`${baseUrl}/admin/users/${testUserId}/activity?category=virtual_card_charges`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.totalItems, 3);
  assert.equal(list.data.length, 3);
  assert.ok(list.data.some((row) => row.type === 'purchase' && row.merchant === 'Coffee Shop'));
  assert.ok(list.data.some((row) => row.type === 'decline'));

  const emptyUserId = uuidv4();
  testDb.users.push({ id: emptyUserId, email: 'empty-charges@test.local', accountStatus: 'active', createdAt: Date.now() });
  const emptyRes = await fetch(`${baseUrl}/admin/users/${emptyUserId}/activity?category=virtual_card_charges`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(emptyRes.status, 200);
  const emptyBody = await emptyRes.json();
  assert.equal(emptyBody.totalItems, 0);
  assert.deepEqual(emptyBody.data, []);
});
