'use strict';

/**
 * Employer/payroll E2E — proves the product flow works without admin operator approval.
 * Covers: register → profile → add employee → fund wallet → bulk pay → worker received.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('pg');

const FALLBACK_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

const appStateStore = require('../db/appStateStore');
const originalLoad = appStateStore.loadAppState;
const originalSave = appStateStore.saveAppState;

let testDb;
let server;
let baseUrl;
let employerUserId;
let workerUserId;
let workerWalletId;
let employerToken;
let workerToken;

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

function buildTestDb() {
  employerUserId = uuidv4();
  workerUserId = uuidv4();
  workerWalletId = uuidv4();
  const now = Date.now();

  return appStateStore.hydrateAppState({
    users: [
      {
        id: employerUserId,
        email: 'employer-e2e@test.local',
        passwordHash: bcrypt.hashSync('EmployerTest123!', 8),
        kycTier: 2,
        kycStatus: 'approved',
        accountStatus: 'active',
        role: 'individual',
        region: 'GQ',
        tokenVersion: 0,
        createdAt: now,
      },
      {
        id: workerUserId,
        email: 'worker-e2e@test.local',
        passwordHash: bcrypt.hashSync('WorkerTest123!', 8),
        kycTier: 1,
        kycStatus: 'approved',
        accountStatus: 'active',
        role: 'individual',
        region: 'GQ',
        tokenVersion: 0,
        createdAt: now,
      },
    ],
    wallets: [
      {
        id: workerWalletId,
        userId: workerUserId,
        balances: [{ currency: 'XAF', amount: 0 }],
        holdBalance: {},
        createdAt: now,
      },
    ],
    employers: [],
    employerEmployees: [],
    payrollBatches: [],
    transactions: [],
    paymentRequests: [],
    notifications: [],
    idempotencyRecords: [],
    withdrawals: [],
    ledger: [],
    rates: appStateStore.emptyAppState().rates,
  });
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

function makeToken(userId) {
  return jwt.sign({ userId, type: 'access', tokenVersion: 0 }, process.env.JWT_SECRET);
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

async function startServer() {
  const express = require('express');
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    if (typeof args[0] === 'number') args[0] = 0;
    server = originalListen.apply(this, args);
    if (cb) cb();
    return server;
  };

  delete require.cache[require.resolve('../index.js')];
  require('../index.js');

  express.application.listen = originalListen;

  await new Promise((resolve) => setTimeout(resolve, 800));
  const addr = server?.address?.();
  if (!addr?.port) {
    throw new Error('Failed to bind test server');
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

test.before(async () => {
  const dbUrl = await pickDatabaseUrl();
  if (!dbUrl) {
    console.log('SKIP: employer payroll E2E — no PostgreSQL available');
    return;
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || 'disable';
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'employer-payroll-e2e-jwt-secret';
  process.env.PORT = process.env.PORT || '34567';
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.ENABLE_HELMET = 'false';

  patchAppState();
  employerToken = makeToken(employerUserId);
  workerToken = makeToken(workerUserId);

  await startServer();
});

test.after(async () => {
  restoreAppState();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('employer payroll full flow — register, employees, fund, bulk pay, worker received', async (t) => {
  if (!baseUrl) {
    t.skip('PostgreSQL not available');
    return;
  }

  const reg = await api('/employer/register', {
    method: 'POST',
    token: employerToken,
    body: {
      companyName: 'E2E Test Corp',
      taxId: 'E2E-TAX-001',
      businessLicense: 'BL-E2E',
      employeeCount: 3,
      fundingCurrency: 'XAF',
    },
  });
  assert.equal(reg.status, 200, `register failed: ${JSON.stringify(reg.data)}`);
  assert.equal(reg.data.employer.verificationStatus, 'verified');
  const employerId = reg.data.employer.id;
  const fundingWalletId = reg.data.employer.fundingWalletId;

  const profile = await api('/employer/profile', { token: employerToken });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.verificationStatus, 'verified');
  assert.equal(profile.data.fundingWalletId, fundingWalletId);

  const addEmp = await api('/employer/add-employee', {
    method: 'POST',
    token: employerToken,
    body: {
      workerEmail: 'worker-e2e@test.local',
      workerName: 'E2E Worker',
      position: 'Engineer',
    },
  });
  assert.equal(addEmp.status, 200, `add-employee failed: ${JSON.stringify(addEmp.data)}`);

  const employees = await api('/employer/employees', { token: employerToken });
  assert.equal(employees.status, 200);
  assert.equal(employees.data.employees.length, 1);
  assert.equal(employees.data.employees[0].workerId, workerUserId);
  assert.equal(employees.data.employees[0].walletId, workerWalletId);

  const fund = await api('/employer/fund-wallet', {
    method: 'POST',
    token: employerToken,
    body: { amount: 500000, currency: 'XAF' },
  });
  assert.equal(fund.status, 403, 'fund-wallet is admin-only — seed funding wallet in test db instead');

  const db = appStateStore.loadAppState();
  const fundingWallet = db.wallets.find(w => w.id === fundingWalletId);
  fundingWallet.balances = [{ currency: 'XAF', amount: 500000 }];
  appStateStore.saveAppState(db);

  const payKey = `e2e-payroll-${Date.now()}`;
  const bulk = await api('/employer/bulk-payment', {
    method: 'POST',
    token: employerToken,
    headers: { 'Idempotency-Key': payKey },
    body: {
      idempotencyKey: payKey,
      payrollItems: [{
        workerId: workerUserId,
        walletId: workerWalletId,
        workerEmail: 'worker-e2e@test.local',
        amount: 100000,
        currency: 'XAF',
        memo: 'E2E salary',
      }],
      payPeriod: '2026-06',
      notes: 'E2E batch',
    },
  });
  assert.equal(bulk.status, 200, `bulk-payment failed: ${JSON.stringify(bulk.data)}`);
  assert.equal(bulk.data.successCount, 1);
  assert.equal(bulk.data.failureCount, 0);
  assert.equal(bulk.data.status, 'completed');

  const workerBal = appStateStore.loadAppState().wallets
    .find(w => w.id === workerWalletId)
    .balances.find(b => b.currency === 'XAF');
  assert.equal(workerBal.amount, 100000);

  const received = await api('/payroll/received', { token: workerToken });
  assert.equal(received.status, 200);
  assert.ok(received.data.payrollTransactions.length >= 1);
  assert.equal(received.data.payrollTransactions[0].amount, 100000);

  const history = await api('/employer/payroll-history', { token: employerToken });
  assert.equal(history.status, 200);
  assert.ok(history.data.batches.length >= 1);
  assert.equal(history.data.batches[0].successCount, 1);

  const rejectedDb = appStateStore.loadAppState();
  const emp = rejectedDb.employers.find(e => e.id === employerId);
  emp.verificationStatus = 'rejected';
  appStateStore.saveAppState(rejectedDb);

  const blocked = await api('/employer/bulk-payment', {
    method: 'POST',
    token: employerToken,
    headers: { 'Idempotency-Key': `e2e-blocked-${Date.now()}` },
    body: {
      payrollItems: [{
        workerId: workerUserId,
        walletId: workerWalletId,
        amount: 1000,
        currency: 'XAF',
      }],
    },
  });
  assert.equal(blocked.status, 403, 'rejected employer must be blocked');
});
