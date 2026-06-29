/**
 * Playwright UI tests for Admin Withdrawals tab.
 * Run: node __tests__/admin-withdrawals-ui.test.mjs
 * Requires: admin-dashboard built (npm run build in admin-dashboard), PostgreSQL, playwright (admin-dashboard devDep).
 */
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.join(__dirname, '..', 'admin-dashboard');
const { chromium } = require(path.join(dashboardRoot, 'node_modules', 'playwright'));

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.PGSSLMODE = process.env.PGSSLMODE || 'disable';

const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true, d }); console.log('PASS', n, d); };
const fail = (n, d = '') => { results.push({ n, ok: false, d }); console.log('FAIL', n, d); };

const NOW = Date.now();
const WITHDRAWALS = {
  pending: { id: 'wd-pending-ui', userId: 'u1', amount: 1000, currency: 'USD', status: 'pending_review', method: 'bank', country: 'GQ', createdAt: NOW - 4000, updatedAt: NOW - 4000, statusHistory: [{ status: 'pending_review', at: NOW - 4000, by: 'system' }] },
  processing: { id: 'wd-processing-ui', userId: 'u1', amount: 2000, currency: 'USD', status: 'processing', method: 'bank', country: 'GQ', createdAt: NOW - 3000, updatedAt: NOW - 3000, statusHistory: [{ status: 'pending_review', at: NOW - 3000, by: 'system' }, { status: 'processing', at: NOW - 2500, by: 'admin' }] },
  failed: { id: 'wd-failed-ui', userId: 'u1', amount: 3000, currency: 'USD', status: 'failed', method: 'bank', country: 'GQ', createdAt: NOW - 2000, updatedAt: NOW - 2000, statusHistory: [{ status: 'pending_review', at: NOW - 2000, by: 'system' }, { status: 'failed', at: NOW - 1500, by: 'admin' }] },
  completed: { id: 'wd-paid-ui', userId: 'u1', amount: 4000, currency: 'USD', status: 'paid', method: 'bank', country: 'GQ', createdAt: NOW - 1000, updatedAt: NOW - 1000, statusHistory: [{ status: 'pending_review', at: NOW - 1000, by: 'system' }, { status: 'paid', at: NOW - 500, by: 'system' }] },
};

let server;
let baseUrl;

async function pickDatabaseUrl() {
  const { Client } = require('pg');
  for (const url of [process.env.DATABASE_URL, 'postgres://postgres:postgres@localhost:5432/postgres'].filter(Boolean)) {
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

function makeAppState(withdrawals) {
  return {
    users: [{ id: 'u1', email: 'u@test.com', kycStatus: 'pending', kycTier: 0, accountStatus: 'active', createdAt: NOW }],
    wallets: [], transactions: [], supportTickets: [], disputes: [], fraudAlerts: [],
    withdrawals,
    notifications: [], announcements: [], kyc: [], auditLog: [], paymentRequests: [],
    ledger: withdrawals.length ? [{ id: 'l1', withdrawalId: withdrawals[0].id, type: 'withdrawal_hold', amount: -1000, currency: 'USD', createdAt: NOW }] : [],
  };
}

async function startUiServer(withdrawals) {
  const databaseUrl = await pickDatabaseUrl();
  if (!databaseUrl) throw new Error('PostgreSQL unavailable');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'withdrawals-ui-test-jwt-secret';

  const { adminLoginHandler, adminAuth, adminMeHandler } = require('../adminAuth');
  const adminUsersRouter = require('../adminUsers');
  const appStateStore = require('../db/appStateStore');
  const { createAdminUser, ensureAdminPlatformTables } = require('../db/adminPlatformPostgres');

  appStateStore.loadAppState = () => makeAppState(withdrawals);
  appStateStore.saveAppState = (s) => s;

  const withdrawalsPg = require('../db/withdrawalsPostgres');
  withdrawalsPg.commitWithdrawalStateUpdate = async (stateDb) => {
    appStateStore.saveAppState(stateDb);
    return { notFound: false, conflict: false };
  };
  delete require.cache[require.resolve('../adminWithdrawals')];
  const { router: adminWithdrawalsRouter } = require('../adminWithdrawals');

  const { pool } = require('../db/pool');
  await ensureAdminPlatformTables();
  await pool.query(`DELETE FROM admin_users WHERE email = 'wd-ui@test.local'`).catch(() => {});
  await createAdminUser({ email: 'wd-ui@test.local', password: 'WdUiPass123!', role: 'super_admin' });

  const app = express();
  app.use(express.json());
  app.locals.withBalanceMutex = async (fn) => fn();
  app.locals.logger = { info: () => {}, warn: () => {}, error: () => {} };
  app.post('/admin/auth/login', adminLoginHandler);
  app.get('/admin/auth/me', adminAuth, adminMeHandler);
  app.use('/admin/users', adminUsersRouter);
  app.use('/admin/withdrawals', adminWithdrawalsRouter);

  const dist = path.join(dashboardRoot, 'dist');
  app.use('/admin/dashboard', express.static(dist, { index: 'index.html' }));
  app.get('/admin/dashboard/*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (server) await new Promise((r) => server.close(r));
  server = null;
}

async function login(page) {
  await page.goto(`${baseUrl}/admin/dashboard/`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'wd-ui@test.local');
  await page.fill('input[type="password"]', 'WdUiPass123!');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.header-title', { timeout: 15000 });
}

async function openWithdrawalsTab(page) {
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.click('nav.nav-tabs button:has-text("Withdrawals")');
  await page.waitForSelector('.page-title', { timeout: 10000 });
  await page.waitForTimeout(800);
  const boundary = await page.locator('text=Something went wrong').count();
  return { jsErrors, boundary, heading: await page.locator('.page-title').first().textContent().catch(() => '') };
}

async function main() {
  console.log('=== ADMIN WITHDRAWALS UI TESTS ===\n');

  const fs = require('fs');
  if (!fs.existsSync(path.join(dashboardRoot, 'dist', 'index.html'))) {
    fail('UI build', 'admin-dashboard/dist missing — run npm run build in admin-dashboard');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    // Empty state
    await startUiServer([]);
    const page = await browser.newPage();
    await login(page);
    pass('UI: login');

    let tab = await openWithdrawalsTab(page);
    if (tab.boundary === 0 && tab.jsErrors.length === 0 && tab.heading?.includes('Withdrawals')) {
      pass('UI: open Withdrawals tab (empty)');
    } else {
      fail('UI: open Withdrawals tab (empty)', JSON.stringify(tab));
    }

    const emptyText = await page.locator('.empty-text').textContent().catch(() => '');
    if (emptyText?.includes('No withdrawals found')) pass('UI: empty state message');
    else fail('UI: empty state message', emptyText);

    for (const label of ['Pending', 'Processing', 'Failed', 'Completed']) {
      await page.click(`.queue-tab:has-text("${label}")`);
      await page.waitForTimeout(600);
      const err = await page.locator('text=Something went wrong').count();
      const empty = await page.locator('.empty-text').count();
      if (err === 0 && empty === 1) pass(`UI: queue tab empty — ${label}`);
      else fail(`UI: queue tab empty — ${label}`, JSON.stringify({ err, empty }));
    }

    await page.close();
    await stopServer();

    // With records — queue tabs + detail + action buttons
    await startUiServer(Object.values(WITHDRAWALS));
    const page2 = await browser.newPage();
    await login(page2);
    tab = await openWithdrawalsTab(page2);
    if (tab.boundary === 0 && tab.jsErrors.length === 0) pass('UI: open Withdrawals tab (with data)');
    else fail('UI: open Withdrawals tab (with data)', JSON.stringify(tab));

    await page2.click('.queue-tab:has-text("Pending")');
    await page2.waitForTimeout(800);
    const pendingRows = await page2.locator('.data-table tbody tr').count();
    if (pendingRows >= 1) pass('UI: pending queue shows rows', String(pendingRows));
    else fail('UI: pending queue shows rows');

    await page2.locator('.clickable-row').first().click();
    await page2.waitForTimeout(800);
    const approveBtn = await page2.locator('button:has-text("Approve")').count();
    const rejectBtn = await page2.locator('button:has-text("Reject")').count();
    if (approveBtn === 1 && rejectBtn === 1) pass('UI: pending_review action buttons');
    else fail('UI: pending_review action buttons', JSON.stringify({ approveBtn, rejectBtn }));

    await page2.click('button:has-text("← Back")');
    await page2.waitForTimeout(500);
    await page2.click('.queue-tab:has-text("Failed")');
    await page2.waitForTimeout(800);
    await page2.locator('.clickable-row').first().click();
    await page2.waitForTimeout(800);
    const terminalMsg = await page2.locator('text=Terminal state').count();
    const reopenBtn = await page2.locator('button:has-text("Reopen")').count();
    if (terminalMsg >= 1 && reopenBtn === 0) pass('UI: failed terminal — no Reopen button');
    else fail('UI: failed terminal — no Reopen button', JSON.stringify({ terminalMsg, reopenBtn }));

    await page2.click('button:has-text("← Back")');
    await page2.waitForTimeout(500);
    await page2.click('.queue-tab:has-text("Completed")');
    await page2.waitForTimeout(800);
    await page2.locator('.clickable-row').first().click();
    await page2.waitForTimeout(800);
    const completedReadOnly = await page2.locator('text=Completed — read only').count();
    const processBtn = await page2.locator('button:has-text("Process")').count();
    if (completedReadOnly >= 1 && processBtn === 0) pass('UI: paid/completed read-only');
    else fail('UI: paid/completed read-only', JSON.stringify({ completedReadOnly, processBtn }));

    await page2.close();
  } catch (err) {
    fail('UI runner', err.message);
    console.error(err);
  } finally {
    await stopServer();
    await browser.close();
    try {
      const { pool } = require('../db/pool');
      await pool.query(`DELETE FROM admin_users WHERE email = 'wd-ui@test.local'`).catch(() => {});
      await pool.end().catch(() => {});
    } catch (_) {}
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\nTotal: ${results.length} | PASS: ${results.length - fails.length} | FAIL: ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
}

main();
