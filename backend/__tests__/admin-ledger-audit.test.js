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
let testWalletId;
let testUserId;
let testDb;
let postgresReady = false;

const appStateStore = require('../db/appStateStore');
const originalLoad = appStateStore.loadAppState;
const originalSave = appStateStore.saveAppState;

function buildTestDb() {
  testUserId = uuidv4();
  testWalletId = uuidv4();
  return {
    users: [{ id: testUserId, email: 'ledger-audit-user@test.local', accountStatus: 'active' }],
    wallets: [{
      id: testWalletId,
      userId: testUserId,
      balances: [
        { currency: 'USD', amount: 50000 },   // will match Postgres
        { currency: 'EUR', amount: 12345 },   // will NOT match Postgres (mismatch)
        { currency: 'GBP', amount: 9999 },    // no Postgres row at all (unmigrated — not a mismatch)
      ],
    }],
    transactions: [], paymentRequests: [], withdrawals: [], virtualCards: [], qrCodes: [], kyc: [], auditLog: [],
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-ledger-audit-test-jwt';

  testDb = buildTestDb();
  appStateStore.loadAppState = () => testDb;
  appStateStore.saveAppState = (s) => { testDb = s; return s; };

  ({ pool } = require('../db/pool'));
  const { adminLoginHandler } = require('../adminAuth');
  const adminLedgerAuditRouter = require('../adminLedgerAudit');
  const { createAdminUser } = require('../db/adminPlatformPostgres');

  await pool.query(`DELETE FROM admin_users WHERE email = 'ledger-audit-admin@test.local'`).catch(() => {});
  await createAdminUser({ email: 'ledger-audit-admin@test.local', password: 'LedgerAudit123!', role: 'read_only' });

  // Seed the relational graph (users -> wallets) so wallet_balances' FK is satisfiable,
  // then seed wallet_balances directly: USD matches JSON, EUR deliberately drifts.
  await pool.query('DELETE FROM wallet_balances WHERE wallet_id = $1', [testWalletId]).catch(() => {});
  await pool.query('DELETE FROM wallets WHERE id = $1', [testWalletId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
  await pool.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at) VALUES ($1, $2, 'x', 'US', 'individual', NOW())`,
    [testUserId, 'ledger-audit-user@test.local']
  );
  await pool.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd) VALUES ($1, $2, NOW(), 250000)`,
    [testWalletId, testUserId]
  );
  await pool.query(
    'INSERT INTO wallet_balances(wallet_id, currency, amount) VALUES ($1, $2, $3), ($1, $4, $5)',
    [testWalletId, 'USD', 50000, 'EUR', 11111]
  );
  // GBP intentionally has no Postgres row — simulates a pre-migration/unmigrated wallet.

  const app = express();
  app.use(express.json());
  app.post('/admin/auth/login', adminLoginHandler);
  app.use('/admin/ledger', adminLedgerAuditRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ledger-audit-admin@test.local', password: 'LedgerAudit123!' }),
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
    await pool.query('DELETE FROM wallet_balances WHERE wallet_id = $1', [testWalletId]).catch(() => {});
    await pool.query('DELETE FROM wallets WHERE id = $1', [testWalletId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
    await pool.query(`DELETE FROM admin_users WHERE email = 'ledger-audit-admin@test.local'`).catch(() => {});
    await pool.end();
  }
});

test('balance-check requires admin auth', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/balance-check?walletId=${testWalletId}&currency=USD`);
  assert.equal(res.status, 401);
});

test('balance-check reports matched=true when JSON and Postgres agree', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/balance-check?walletId=${testWalletId}&currency=USD`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonAmount, 50000);
  assert.equal(body.postgresAmount, 50000);
  assert.equal(body.matched, true);
  assert.equal(body.delta, 0);
});

test('balance-check reports matched=false and the correct delta on drift', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/balance-check?walletId=${testWalletId}&currency=EUR`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonAmount, 12345);
  assert.equal(body.postgresAmount, 11111);
  assert.equal(body.matched, false);
  assert.equal(body.delta, 12345 - 11111);
});

test('balance-check returns null postgresAmount (not a false mismatch) when no Postgres row exists yet', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/balance-check?walletId=${testWalletId}&currency=GBP`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.postgresAmount, null);
  assert.equal(body.matched, false);
  assert.ok(body.note);
});

test('balance-check requires walletId and currency', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/balance-check?walletId=${testWalletId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 400);
});

test('mismatches scan finds exactly the EUR drift, not the matched USD pair or the unmigrated GBP pair', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/mismatches`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.authoritative, 'postgres');
  const eurMismatch = body.mismatches.find((m) => m.walletId === testWalletId && m.currency === 'EUR');
  assert.ok(eurMismatch, 'EUR drift must be reported');
  assert.equal(eurMismatch.jsonAmount, 12345);
  assert.equal(eurMismatch.postgresAmount, 11111);
  const usdMismatch = body.mismatches.find((m) => m.walletId === testWalletId && m.currency === 'USD');
  assert.equal(usdMismatch, undefined, 'matched USD pair must not be reported as a mismatch');
  const gbpMismatch = body.mismatches.find((m) => m.walletId === testWalletId && m.currency === 'GBP');
  assert.equal(gbpMismatch, undefined, 'unmigrated GBP pair (no Postgres row) must not be reported as a mismatch');
});

test('mismatches scan requires admin auth', async (t) => {
  if (!postgresReady) return t.skip('PostgreSQL unavailable');
  const res = await fetch(`${baseUrl}/admin/ledger/mismatches`);
  assert.equal(res.status, 401);
});
