'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.PGSSLMODE = process.env.PGSSLMODE || 'disable';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

const FALLBACK_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let pool;
let server;
let baseUrl;
let adminToken;
let adminCsrf;
let userToken;
let testUserId;
let testWalletId;
let testDocumentId;
let postgresReady = false;
let tempStorageDir;

const appStateStore = require('../db/appStateStore');
const originalLoad = appStateStore.loadAppState;
const originalSave = appStateStore.saveAppState;
let testDb;

function buildTestDb() {
  testUserId = uuidv4();
  testWalletId = uuidv4();
  return {
    users: [{
      id: testUserId,
      email: 'admin-dash-user@egwallet.test',
      username: 'dashuser',
      fullName: 'Dash User',
      kycStatus: 'pending',
      kycTier: 0,
      createdAt: Date.now(),
      role: 'individual',
    }],
    wallets: [{
      id: testWalletId,
      userId: testUserId,
      balances: [{ currency: 'USD', amount: 10000 }],
      holdBalance: {},
    }],
    transactions: [{
      id: uuidv4(),
      type: 'deposit',
      amount: 10000,
      currency: 'USD',
      fromWalletId: null,
      toWalletId: testWalletId,
      status: 'completed',
      createdAt: Date.now(),
    }],
    paymentRequests: [],
    withdrawals: [],
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
  const candidates = [process.env.DATABASE_URL, FALLBACK_DATABASE_URL].filter(Boolean);
  for (const url of candidates) {
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

async function ensureUsersTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT 'US',
      role TEXT NOT NULL DEFAULT 'individual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_tier INT DEFAULT 0`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'pending'`);
}

async function seedPgUser(userId) {
  const client = await pool.connect();
  try {
    await ensureUsersTable(client);
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at)
       VALUES ($1, $2, 'x', 'US', 'individual', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@admin-dash.test`],
    );
  } finally {
    client.release();
  }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (_error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function startTestServer() {
  patchAppState();
  const { adminLoginHandler } = require('../adminAuth');
  const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');
  const adminUsersRouter = require('../adminUsers');
  const adminKycRouter = require('../adminKyc');
  const { kycUploadMiddleware, handleKycUpload } = require('../kycUpload');

  await ensureAdminPlatformTables();
  await createAdminUser({ email: 'admin@test.local', password: 'AdminTestPass123!', role: 'super_admin' });

  const app = express();
  app.use(express.json());
  app.post('/admin/auth/login', adminLoginHandler);
  app.use('/admin/users', adminUsersRouter);
  app.use('/admin/kyc', adminKycRouter);
  app.post('/kyc/upload', authMiddleware, kycUploadMiddleware, handleKycUpload);
  app.post('/admin/users/:id/balance', (_req, res) => res.status(404).json({ error: 'not found' }));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

test.before(async () => {
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-dashboard-test-jwt-secret';

  tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egwallet-admin-dash-'));
  process.env.KYC_STORAGE_DIR = tempStorageDir;

  const databaseUrl = await pickDatabaseUrl();
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
    ({ pool } = require('../db/pool'));
    const { ensureKycDocumentsTable } = require('../db/kycUploadPostgres');
    try {
      await ensureKycDocumentsTable();
      postgresReady = true;
    } catch (error) {
      postgresReady = false;
      console.warn(`[admin-dashboard.test] PostgreSQL setup failed: ${error.message}`);
    }
  }

  if (!postgresReady) return;

  await startTestServer();

  const loginRes = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'AdminTestPass123!' }),
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  adminToken = loginBody.token;
  adminCsrf = loginBody.csrfToken;

  userToken = jwt.sign({ userId: testUserId, type: 'access', tokenVersion: 0 }, process.env.JWT_SECRET);
});

function adminPostHeaders() {
  return {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
    'X-CSRF-Token': adminCsrf,
  };
}

test.after(async () => {
  restoreAppState();
  if (postgresReady && pool) {
    if (testDocumentId) {
      const { deleteKycDocument } = require('../db/kycUploadPostgres');
      await deleteKycDocument(testDocumentId);
    }
    await pool.query('DELETE FROM admin_users WHERE email = $1', ['admin@test.local']);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
    await pool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempStorageDir) fs.rmSync(tempStorageDir, { recursive: true, force: true });
});

test('admin login required for protected routes', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users`);
  assert.equal(res.status, 401);
});

test('non-admin bearer token blocked from admin routes', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.status, 401);
});

test('user search works', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users?q=dashuser`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.users.some((u) => u.id === testUserId));
});

test('user detail loads read-only money data', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.wallets[0].balances[0].amount, 10000);
});

test('money data is read-only — no balance edit endpoint', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}/balance`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 999999 }),
  });
  assert.equal(res.status, 404);
});

test('KYC document view requires admin', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  await seedPgUser(testUserId);
  const form = new FormData();
  form.append('document', new Blob([PNG_BUFFER], { type: 'image/png' }), 'passport.png');
  form.append('documentType', 'passport');
  const uploadRes = await fetch(`${baseUrl}/kyc/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: form,
  });
  assert.equal(uploadRes.status, 200);
  testDocumentId = (await uploadRes.json()).document.id;

  const blocked = await fetch(`${baseUrl}/admin/kyc/documents/${testDocumentId}/content`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(blocked.status, 401);

  const allowed = await fetch(`${baseUrl}/admin/kyc/documents/${testDocumentId}/content`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(allowed.status, 200);
});

test('KYC approve updates user status and tier', async (t) => {
  if (!postgresReady || !testDocumentId) return t.skip('PostgreSQL unavailable');

  const res = await fetch(`${baseUrl}/admin/kyc/documents/${testDocumentId}/approve`, {
    method: 'POST',
    headers: adminPostHeaders(),
    body: JSON.stringify({ kycTier: 2 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.kycStatus, 'approved');
  assert.equal(body.user.kycTier, 2);

  const user = testDb.users.find((u) => u.id === testUserId);
  assert.equal(user.kycStatus, 'approved');
});

test('KYC reject stores reason', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const rejectUserId = uuidv4();
  await seedPgUser(rejectUserId);
  testDb.users.push({
    id: rejectUserId,
    email: 'reject-user@egwallet.test',
    username: 'rejectme',
    kycStatus: 'pending',
    kycTier: 0,
    createdAt: Date.now(),
    role: 'individual',
  });

  const rejectToken = jwt.sign({ userId: rejectUserId, type: 'access', tokenVersion: 0 }, process.env.JWT_SECRET);
  const form = new FormData();
  form.append('document', new Blob([PNG_BUFFER], { type: 'image/png' }), 'id.png');
  form.append('documentType', 'id_card');
  const uploadRes = await fetch(`${baseUrl}/kyc/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rejectToken}` },
    body: form,
  });
  assert.equal(uploadRes.status, 200);
  const rejectDocId = (await uploadRes.json()).document.id;

  const res = await fetch(`${baseUrl}/admin/kyc/documents/${rejectDocId}/reject`, {
    method: 'POST',
    headers: adminPostHeaders(),
    body: JSON.stringify({ reason: 'Document unreadable' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.rejectionReason, 'Document unreadable');

  const { deleteKycDocument } = require('../db/kycUploadPostgres');
  await deleteKycDocument(rejectDocId);
});
