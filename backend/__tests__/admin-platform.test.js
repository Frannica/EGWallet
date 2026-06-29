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
let superToken;
let supportToken;
let complianceToken;
let userToken;
let testUserId;
let testWalletId;
let testDocumentId;
let postgresReady = false;
let tempStorageDir;
let superAdminId;
let supportAdminId;

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
      email: 'platform-user@egwallet.test',
      username: 'platformuser',
      fullName: 'Platform User',
      passwordHash: require('bcryptjs').hashSync('UserPass123!', 4),
      kycStatus: 'pending',
      kycTier: 0,
      accountStatus: 'active',
      createdAt: Date.now(),
      role: 'individual',
      loginHistory: [],
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
    withdrawals: [{ id: uuidv4(), userId: testUserId, amount: 5000, currency: 'USD', status: 'pending_review', createdAt: Date.now() }],
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

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch (_error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function adminLogin(email, password) {
  const res = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(async () => ({ error: await res.text() }));
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(body)}`);
  return body.token;
}

async function startTestServer() {
  patchAppState();
  const {
    adminLoginHandler,
    adminLogoutHandler,
    adminMeHandler,
    adminAuth,
  } = require('../adminAuth');
  const adminUsersRouter = require('../adminUsers');
  const adminKycRouter = require('../adminKyc');
  const adminStatsRouter = require('../adminStats');
  const adminLogsRouter = require('../adminLogs');
  const { router: adminSettingsRouter } = require('../adminSettings');
  const { kycUploadMiddleware, handleKycUpload } = require('../kycUpload');
  const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');

  await ensureAdminPlatformTables();
  await pool.query(`DELETE FROM admin_users WHERE email LIKE '%@test.egwallet'`).catch(() => {});

  const superAdmin = await createAdminUser({
    email: 'super@test.egwallet',
    password: 'SuperPass123!',
    role: 'super_admin',
  });
  superAdminId = superAdmin.id;
  await createAdminUser({ email: 'support@test.egwallet', password: 'SupportPass123!', role: 'support' });
  supportAdminId = (await require('../db/adminPlatformPostgres').findAdminByEmail('support@test.egwallet')).id;
  await createAdminUser({ email: 'compliance@test.egwallet', password: 'CompliancePass123!', role: 'compliance' });

  const app = express();
  app.use(express.json());
  app.post('/admin/auth/login', adminLoginHandler);
  app.get('/admin/auth/me', adminAuth, adminMeHandler);
  app.post('/admin/auth/logout', adminAuth, adminLogoutHandler);
  app.use('/admin/stats', adminStatsRouter);
  app.use('/admin/logs', adminLogsRouter);
  app.use('/admin/settings', adminSettingsRouter);
  app.use('/admin/users', adminUsersRouter);
  app.use('/admin/kyc', adminKycRouter);
  app.post('/kyc/upload', authMiddleware, kycUploadMiddleware, handleKycUpload);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.before(async () => {
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-platform-test-jwt-secret-key-32b';
  tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egwallet-admin-platform-'));
  process.env.KYC_STORAGE_DIR = tempStorageDir;

  const databaseUrl = await pickDatabaseUrl();
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
    ({ pool } = require('../db/pool'));
    try {
      const { ensureKycDocumentsTable } = require('../db/kycUploadPostgres');
      await ensureKycDocumentsTable();
      postgresReady = true;
    } catch (error) {
      postgresReady = false;
      console.warn(`[admin-platform.test] PostgreSQL setup failed: ${error.message}`);
    }
  }

  if (!postgresReady) return;

  await startTestServer();
  superToken = await adminLogin('super@test.egwallet', 'SuperPass123!');
  supportToken = await adminLogin('support@test.egwallet', 'SupportPass123!');
  complianceToken = await adminLogin('compliance@test.egwallet', 'CompliancePass123!');
  userToken = jwt.sign({ userId: testUserId, type: 'access', tokenVersion: 0 }, process.env.JWT_SECRET);
});

test.after(async () => {
  restoreAppState();
  if (postgresReady && pool) {
    if (testDocumentId) {
      const { deleteKycDocument } = require('../db/kycUploadPostgres');
      await deleteKycDocument(testDocumentId).catch(() => {});
    }
    await pool.query('DELETE FROM admin_user_notes WHERE user_id = $1', [testUserId]).catch(() => {});
    await pool.query('DELETE FROM admin_users WHERE email LIKE $1', ['%@test.egwallet']).catch(() => {});
    await pool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempStorageDir) fs.rmSync(tempStorageDir, { recursive: true, force: true });
});

test('admin JWT login required', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/stats`);
  assert.equal(res.status, 401);
});

test('support role blocked from KYC approve', async (t) => {
  if (!postgresReady || !testDocumentId) {
    if (!postgresReady) return t.skip('PostgreSQL unavailable');
    const form = new FormData();
    form.append('document', new Blob([PNG_BUFFER], { type: 'image/png' }), 'id.png');
    form.append('documentType', 'passport');
    const uploadRes = await fetch(`${baseUrl}/kyc/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: form,
    });
    assert.equal(uploadRes.status, 200);
    testDocumentId = (await uploadRes.json()).document.id;
  }

  const res = await fetch(`${baseUrl}/admin/kyc/documents/${testDocumentId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supportToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kycTier: 1 }),
  });
  assert.equal(res.status, 403);
});

test('compliance can approve KYC', async (t) => {
  if (!postgresReady || !testDocumentId) return t.skip('PostgreSQL unavailable');

  const res = await fetch(`${baseUrl}/admin/kyc/documents/${testDocumentId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${complianceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kycTier: 2 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.kycTier, 2);
});

test('dashboard stats load', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/stats`, { headers: { Authorization: `Bearer ${superToken}` } });
  assert.equal(res.status, 200);
  const stats = await res.json();
  assert.ok(stats.totalUsers >= 1);
  assert.ok(typeof stats.pendingKyc === 'number');
});

test('user search and suspend', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const search = await fetch(`${baseUrl}/admin/users/search?q=platform`, {
    headers: { Authorization: `Bearer ${supportToken}` },
  });
  assert.equal(search.status, 200);
  const found = await search.json();
  assert.ok(found.users.some((u) => u.id === testUserId));

  const suspend = await fetch(`${baseUrl}/admin/users/${testUserId}/suspend`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supportToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(suspend.status, 200);
  const user = testDb.users.find((u) => u.id === testUserId);
  assert.equal(user.accountStatus, 'suspended');
});

test('user notes append-only with author', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const res = await fetch(`${baseUrl}/admin/users/${testUserId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supportToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Customer called about KYC delay.' }),
  });
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.equal(saved.note.adminEmail, 'support@test.egwallet');

  const list = await fetch(`${baseUrl}/admin/users/${testUserId}/notes`, {
    headers: { Authorization: `Bearer ${supportToken}` },
  });
  const notes = await list.json();
  assert.ok(notes.notes.some((n) => n.note.includes('KYC delay')));
});

test('user timeline includes deposits and admin actions', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}/timeline`, {
    headers: { Authorization: `Bearer ${superToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.events.some((e) => e.type === 'deposit'));
});

test('settings super_admin only write', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const denied = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${supportToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maintenanceMode: { enabled: true, message: 'test' } }),
  });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${superToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maintenanceMode: { enabled: false, message: 'ok' } }),
  });
  assert.equal(allowed.status, 200);
});

test('money data read-only on user detail', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}`, {
    headers: { Authorization: `Bearer ${superToken}` },
  });
  const body = await res.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.wallets[0].balances[0].amount, 10000);
});
