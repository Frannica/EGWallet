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
let superCsrf;
let supportToken;
let supportCsrf;
let complianceToken;
let complianceCsrf;
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
    supportTickets: [{
      id: 'TKT-TEST-001',
      userId: testUserId,
      subject: 'Test support ticket',
      description: 'Need help with fraud on my account',
      category: 'fraud',
      priority: 'urgent',
      status: 'open',
      tags: ['fraud', 'auto-escalated'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      replies: [],
    }],
    disputes: [{
      id: uuidv4(),
      ticketNumber: 'EGW-12345',
      userId: testUserId,
      userEmail: 'platform-user@egwallet.test',
      transactionId: null,
      reason: 'unauthorized',
      description: 'I did not authorize this transaction',
      status: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
    fraudAlerts: [{
      id: uuidv4(),
      userId: testUserId,
      reason: 'Velocity check triggered',
      severity: 'high',
      createdAt: Date.now(),
    }],
    notifications: [],
    announcements: [],
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
  return body;
}

function postHeaders(token, csrf) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrf,
  };
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
  const adminDashboardRouter = require('../adminDashboard');
  const { router: adminSearchRouter } = require('../adminSearch');
  const adminStatsRouter = require('../adminStats');
  const adminLogsRouter = require('../adminLogs');
  const { router: adminSettingsRouter } = require('../adminSettings');
  const adminSupportRouter = require('../adminSupport');
  const adminDisputesRouter = require('../adminDisputes');
  const adminNotificationsRouter = require('../adminNotifications');
  const adminFraudRouter = require('../adminFraud');
  const { kycUploadMiddleware, handleKycUpload } = require('../kycUpload');
  const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');

  await ensureAdminPlatformTables();
  await pool.query(`DELETE FROM admin_refresh_tokens WHERE admin_id IN (SELECT id FROM admin_users WHERE email LIKE '%@test.egwallet')`).catch(() => {});
  await pool.query(`DELETE FROM admin_user_notes WHERE admin_id IN (SELECT id FROM admin_users WHERE email LIKE '%@test.egwallet')`).catch(() => {});
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
  app.use('/admin/overview', adminDashboardRouter);
  app.use('/admin/search', adminSearchRouter);
  app.use('/admin/stats', adminStatsRouter);
  app.use('/admin/logs', adminLogsRouter);
  app.use('/admin/settings', adminSettingsRouter);
  app.use('/admin/support/tickets', adminSupportRouter);
  app.use('/admin/disputes', adminDisputesRouter);
  app.use('/admin/notifications', adminNotificationsRouter);
  app.use('/admin/fraud', adminFraudRouter);
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
  const superSession = await adminLogin('super@test.egwallet', 'SuperPass123!');
  superToken = superSession.token;
  superCsrf = superSession.csrfToken;
  const supportSession = await adminLogin('support@test.egwallet', 'SupportPass123!');
  supportToken = supportSession.token;
  supportCsrf = supportSession.csrfToken;
  const complianceSession = await adminLogin('compliance@test.egwallet', 'CompliancePass123!');
  complianceToken = complianceSession.token;
  complianceCsrf = complianceSession.csrfToken;
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
    await pool.query(`DELETE FROM admin_refresh_tokens WHERE admin_id IN (SELECT id FROM admin_users WHERE email LIKE '%@test.egwallet')`).catch(() => {});
    await pool.query(`DELETE FROM admin_user_notes WHERE admin_id IN (SELECT id FROM admin_users WHERE email LIKE '%@test.egwallet')`).catch(() => {});
    await pool.query('DELETE FROM admin_users WHERE email LIKE $1', ['%@test.egwallet']).catch(() => {});
    // ensureRelationalUser() (kycUploadPostgres.js) shims a `users` row for this
    // test's fixed fixture email on every run — clean it up so repeated runs
    // against a persistent test database never collide on users_email_lower_idx.
    if (testUserId) {
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE email = $1', ['platform-user@egwallet.test']).catch(() => {});
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
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({ kycTier: 1 }),
  });
  assert.equal(res.status, 403);
});

test('compliance can approve KYC', async (t) => {
  if (!postgresReady || !testDocumentId) return t.skip('PostgreSQL unavailable');

  const res = await fetch(`${baseUrl}/admin/kyc/documents/${testDocumentId}/approve`, {
    method: 'POST',
    headers: postHeaders(complianceToken, complianceCsrf),
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
    headers: postHeaders(supportToken, supportCsrf),
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
    headers: postHeaders(supportToken, supportCsrf),
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
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({ maintenanceMode: { enabled: true, message: 'test' } }),
  });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PATCH',
    headers: postHeaders(superToken, superCsrf),
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

test('impersonation is permanently disabled', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/users/${testUserId}/impersonate`, {
    method: 'POST',
    headers: postHeaders(superToken, superCsrf),
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('dashboard overview includes activity and health', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/overview`, {
    headers: { Authorization: `Bearer ${superToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.stats);
  assert.ok(Array.isArray(body.activity));
  assert.ok(body.health);
});

test('global search finds users by email', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/search?q=platform`, {
    headers: { Authorization: `Bearer ${superToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.results.some((r) => r.type === 'user'));
});

test('audit entries include before and after fields', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const { getAdminAuditLogs } = require('../adminAudit');
  const logs = getAdminAuditLogs({ limit: 20 });
  const suspendLog = logs.find((l) => l.action === 'USER_SUSPEND');
  assert.ok(suspendLog);
  assert.ok(suspendLog.admin);
  assert.ok(suspendLog.ipAddress);
  assert.ok(suspendLog.browser);
  assert.ok(suspendLog.before);
  assert.ok(suspendLog.after);
});

test('support tickets list, reply, and close', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const list = await fetch(`${baseUrl}/admin/support/tickets`, {
    headers: { Authorization: `Bearer ${supportToken}` },
  });
  assert.equal(list.status, 200);
  const tickets = await list.json();
  assert.ok(tickets.tickets.some((tk) => tk.id === 'TKT-TEST-001'));

  const reply = await fetch(`${baseUrl}/admin/support/tickets/TKT-TEST-001/reply`, {
    method: 'POST',
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({ message: 'We are investigating your report.' }),
  });
  assert.equal(reply.status, 200);

  const close = await fetch(`${baseUrl}/admin/support/tickets/TKT-TEST-001/close`, {
    method: 'POST',
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({ resolution: 'Resolved after review' }),
  });
  assert.equal(close.status, 200);
  const closed = await close.json();
  assert.equal(closed.ticket.status, 'closed');
});

test('disputes list and update', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const list = await fetch(`${baseUrl}/admin/disputes`, {
    headers: { Authorization: `Bearer ${supportToken}` },
  });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.ok(body.disputes.length >= 1);

  const disputeId = body.disputes[0].id;
  const patch = await fetch(`${baseUrl}/admin/disputes/${disputeId}`, {
    method: 'PATCH',
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({ status: 'investigating', resolution: 'Reviewing transaction' }),
  });
  assert.equal(patch.status, 200);
  const updated = await patch.json();
  assert.equal(updated.dispute.status, 'investigating');
});

test('notifications send to individual and all users', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const single = await fetch(`${baseUrl}/admin/notifications/send`, {
    method: 'POST',
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({
      title: 'Test message',
      body: 'Hello user',
      audience: 'user_ids',
      userIds: [testUserId],
      type: 'admin_message',
    }),
  });
  assert.equal(single.status, 200);
  assert.equal((await single.json()).recipientCount, 1);

  const all = await fetch(`${baseUrl}/admin/notifications/send`, {
    method: 'POST',
    headers: postHeaders(supportToken, supportCsrf),
    body: JSON.stringify({
      title: 'System notice',
      body: 'Maintenance tonight',
      audience: 'all',
      type: 'maintenance',
    }),
  });
  assert.equal(all.status, 200);
  assert.ok((await all.json()).recipientCount >= 1);
  assert.ok((testDb.notifications || []).length >= 2);
});

test('broadcast announcement', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const res = await fetch(`${baseUrl}/admin/notifications/announcements`, {
    method: 'POST',
    headers: postHeaders(superToken, superCsrf),
    body: JSON.stringify({
      title: 'Platform update',
      body: 'New features available',
      audience: 'all',
      type: 'announcement',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.announcement.id);
  assert.ok(body.recipientCount >= 1);
});

test('fraud signals list', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');

  const res = await fetch(`${baseUrl}/admin/fraud`, {
    headers: { Authorization: `Bearer ${supportToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.signals.some((s) => s.type === 'fraud_alert' || s.type === 'support_escalation'));
});
