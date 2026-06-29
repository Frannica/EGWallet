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
let kycUploadMiddleware;
let handleKycUpload;
let adminKycRouter;
let adminLoginHandler;
let deleteKycDocument;
let ensureKycDocumentsTable;

let server;
let baseUrl;
let tempStorageDir;
let testUserId;
let accessToken;
let adminToken;
let postgresReady = false;
const createdDocumentIds = [];

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
}

async function seedUser(userId) {
  const client = await pool.connect();
  try {
    await ensureUsersTable(client);
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at)
       VALUES ($1, $2, 'x', 'US', 'individual', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@kyc-upload.test`],
    );
  } finally {
    client.release();
  }
}

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.post('/admin/auth/login', adminLoginHandler);
  app.post('/kyc/upload', authMiddleware, kycUploadMiddleware, handleKycUpload);
  app.use('/admin/kyc', adminKycRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function uploadMultipart({ token, documentType, buffer, mimeType, filename }) {
  const form = new FormData();
  form.append('document', new Blob([buffer], { type: mimeType }), filename);
  form.append('documentType', documentType);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/kyc/upload`, { method: 'POST', headers, body: form });
}

test.before(async () => {
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'kyc-upload-test-jwt-secret';
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'kyc-upload-test-admin-secret';

  tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egwallet-kyc-upload-'));
  process.env.KYC_STORAGE_DIR = tempStorageDir;

  const databaseUrl = await pickDatabaseUrl();
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
    ({ pool } = require('../db/pool'));
    ({
      kycUploadMiddleware,
      handleKycUpload,
    } = require('../kycUpload'));
    adminKycRouter = require('../adminKyc');
    ({ adminLoginHandler } = require('../adminAuth'));
    const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');
    await ensureAdminPlatformTables();
    await pool.query(`DELETE FROM admin_users WHERE email = $1`, ['kyc-admin@test.local']).catch(() => {});
    await createAdminUser({ email: 'kyc-admin@test.local', password: 'KycAdminPass123!', role: 'super_admin' });
    ({
      deleteKycDocument,
      ensureKycDocumentsTable,
    } = require('../db/kycUploadPostgres'));
    try {
      const client = await pool.connect();
      try {
        await ensureUsersTable(client);
      } finally {
        client.release();
      }
      await ensureKycDocumentsTable();
      testUserId = uuidv4();
      await seedUser(testUserId);
      postgresReady = true;
    } catch (error) {
      postgresReady = false;
      console.warn(`[kyc-upload.test] PostgreSQL setup failed: ${error.message}`);
    }
  } else {
    ({
      kycUploadMiddleware,
      handleKycUpload,
    } = require('../kycUpload'));
    adminKycRouter = require('../adminKyc');
    ({ adminLoginHandler } = require('../adminAuth'));
    const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');
    await ensureAdminPlatformTables();
    await pool.query(`DELETE FROM admin_users WHERE email = $1`, ['kyc-admin@test.local']).catch(() => {});
    await createAdminUser({ email: 'kyc-admin@test.local', password: 'KycAdminPass123!', role: 'super_admin' });
    testUserId = uuidv4();
    console.warn('[kyc-upload.test] PostgreSQL unavailable — integration tests will be skipped');
  }

  accessToken = jwt.sign({ userId: testUserId, type: 'access', tokenVersion: 0 }, process.env.JWT_SECRET);
  await startTestServer();

  const adminLoginRes = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kyc-admin@test.local', password: 'KycAdminPass123!' }),
  });
  assert.equal(adminLoginRes.status, 200);
  const adminBody = await adminLoginRes.json();
  adminToken = adminBody.token;
});

test.after(async () => {
  if (postgresReady && pool) {
    for (const id of createdDocumentIds) {
      await deleteKycDocument(id);
    }
    await pool.query('DELETE FROM admin_users WHERE email = $1', ['kyc-admin@test.local']).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (tempStorageDir) {
    fs.rmSync(tempStorageDir, { recursive: true, force: true });
  }
});

test('upload succeeds with image', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await uploadMultipart({
    token: accessToken,
    documentType: 'passport',
    buffer: PNG_BUFFER,
    mimeType: 'image/png',
    filename: 'passport.png',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.document.type, 'passport');
  assert.equal(body.document.status, 'under_review');
  assert.ok(body.document.id);
  createdDocumentIds.push(body.document.id);
});

test('invalid MIME rejected', async () => {
  const res = await uploadMultipart({
    token: accessToken,
    documentType: 'id_card',
    buffer: Buffer.from('%PDF-1.4 fake'),
    mimeType: 'application/pdf',
    filename: 'id.pdf',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.errorCode, 'invalid_mime');
});

test('oversized file rejected', async () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0xff);
  oversized[0] = 0x89;
  oversized[1] = 0x50;
  oversized[2] = 0x4e;
  oversized[3] = 0x47;
  const res = await uploadMultipart({
    token: accessToken,
    documentType: 'proof_of_address',
    buffer: oversized,
    mimeType: 'image/png',
    filename: 'big.png',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.errorCode, 'file_too_large');
});

test('unauthenticated upload rejected', async () => {
  const res = await uploadMultipart({
    token: null,
    documentType: 'passport',
    buffer: PNG_BUFFER,
    mimeType: 'image/png',
    filename: 'passport.png',
  });
  assert.equal(res.status, 401);
});

test('admin can list submitted KYC docs', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const uploadRes = await uploadMultipart({
    token: accessToken,
    documentType: 'drivers_license',
    buffer: PNG_BUFFER,
    mimeType: 'image/png',
    filename: 'license.png',
  });
  assert.equal(uploadRes.status, 200);
  const uploadBody = await uploadRes.json();
  createdDocumentIds.push(uploadBody.document.id);

  const listRes = await fetch(`${baseUrl}/admin/kyc/documents?userId=${testUserId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.ok(Array.isArray(listBody.documents));
  const found = listBody.documents.find((doc) => doc.id === uploadBody.document.id);
  assert.ok(found);
  assert.equal(found.type, 'drivers_license');
  assert.equal(found.mimeType, 'image/png');
  assert.equal(found.sizeBytes, PNG_BUFFER.length);
});

test('admin can fetch/view document', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const uploadRes = await uploadMultipart({
    token: accessToken,
    documentType: 'proof_of_address',
    buffer: PNG_BUFFER,
    mimeType: 'image/png',
    filename: 'address.png',
  });
  assert.equal(uploadRes.status, 200);
  const uploadBody = await uploadRes.json();
  const documentId = uploadBody.document.id;
  createdDocumentIds.push(documentId);

  const metaRes = await fetch(`${baseUrl}/admin/kyc/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(metaRes.status, 200);
  const metaBody = await metaRes.json();
  assert.equal(metaBody.document.id, documentId);
  assert.equal(metaBody.document.mimeType, 'image/png');

  const contentRes = await fetch(`${baseUrl}/admin/kyc/documents/${documentId}/content`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(contentRes.status, 200);
  assert.match(contentRes.headers.get('content-type') || '', /image\/png/);
  const contentBuffer = Buffer.from(await contentRes.arrayBuffer());
  assert.ok(contentBuffer.equals(PNG_BUFFER));
});
