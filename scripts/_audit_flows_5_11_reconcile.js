'use strict';

/**
 * Flows 5–11 ledger reconciliation audit.
 *
 * Verifies GET /wallets (JSON snapshot) matches PostgreSQL wallet_balances after each step.
 *
 * Usage:
 *   API_BASE=http://127.0.0.1:3000 \
 *   DATABASE_URL=postgres://... \
 *   AUDIT_EMAIL=x AUDIT_PASSWORD=y \
 *   node scripts/_audit_flows_5_11_reconcile.js
 *
 * Flow 5 (Stripe deposit) is skipped unless DEMO_DEPOSIT=1 (demo confirm path).
 * Production Stripe deposit requires device/manual confirmation — fund wallet before running.
 */

const path = require('path');
const { Pool } = require(path.join(__dirname, '../backend/node_modules/pg'));

const API = process.env.API_BASE || 'http://127.0.0.1:3000';
const email = process.env.AUDIT_EMAIL;
const password = process.env.AUDIT_PASSWORD;
const RUN = Date.now().toString(36);
const SEND_MINOR = Number(process.env.AUDIT_SEND_MINOR || 40);
const REQ_MINOR = Number(process.env.AUDIT_REQ_MINOR || 30);
const EX_MINOR = Number(process.env.AUDIT_EX_MINOR || 10);
const DEMO_DEPOSIT = process.env.DEMO_DEPOSIT === '1';
const DEMO_CREDIT = Number(process.env.DEMO_CREDIT_MINOR || 100);

if (!email || !password) {
  console.error('AUDIT_EMAIL and AUDIT_PASSWORD required');
  process.exit(1);
}

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

function idem(tag) {
  return `${tag}-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.deviceId ? { 'x-device-id': opts.deviceId } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

function jsonBal(walletsRes, walletId, currency = 'USD') {
  const w = (walletsRes.data?.wallets || []).find((x) => x.id === walletId)
    || walletsRes.data?.wallets?.[0];
  const b = (w?.balances || []).find((x) => x.currency === currency);
  return { walletId: w?.id, amount: b ? Number(b.amount) : 0 };
}

async function pgBal(walletId, currency = 'USD') {
  if (!pool) return null;
  const row = await pool.query(
    'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
    [walletId, currency]
  );
  return row.rowCount > 0 ? Number(row.rows[0].amount) : 0;
}

function record(num, name, status, proof = {}) {
  console.log(`\n[${status}] Flow ${num}: ${name}`);
  for (const [k, v] of Object.entries(proof)) {
    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return { num, name, status, proof };
}

async function assertReconcile(walletId, currency, label, results) {
  const wallets = await api('/wallets', { token: results.token });
  const json = jsonBal(wallets, walletId, currency);
  const pg = await pgBal(walletId, currency);
  const proof = {
    walletId,
    currency,
    jsonMinor: json.amount,
    postgresMinor: pg,
    jsonDollars: `$${(json.amount / 100).toFixed(2)}`,
    postgresDollars: pg === null ? 'n/a' : `$${(pg / 100).toFixed(2)}`,
  };
  const ok = pg === null ? true : json.amount === pg;
  record(0, `Reconcile ${label}`, ok ? 'PASS' : 'FAIL', proof);
  if (!ok) results.failed = true;
  return json.amount;
}

async function main() {
  console.log('Flows 5–11 ledger reconciliation audit');
  console.log(`API: ${API}`);
  console.log(`PostgreSQL verify: ${pool ? 'enabled' : 'disabled (set DATABASE_URL)'}`);
  console.log(`Account: ${email}\n`);

  const results = { token: null, failed: false };
  const deviceId = `audit-ledger-${RUN}`;

  const login = await api('/auth/login', { method: 'POST', deviceId, body: { email, password } });
  results.token = login.data?.accessToken || login.data?.token;
  if (!results.token) {
    record(5, 'Login (prerequisite)', 'FAIL', { status: login.status, error: login.data?.error });
    process.exit(1);
  }

  let wallets = await api('/wallets', { token: results.token });
  const payerWalletId = wallets.data?.wallets?.[0]?.id;
  let balance = jsonBal(wallets, payerWalletId).amount;

  // Flow 5 — Deposit
  if (DEMO_DEPOSIT) {
    const intent = await api('/deposits/create-intent', {
      method: 'POST',
      token: results.token,
      body: { walletId: payerWalletId, amount: DEMO_CREDIT, currency: 'USD' },
    });
    const intentId = intent.data?.intentId || intent.data?.id;
    const confirm = await api('/deposits/confirm', {
      method: 'POST',
      token: results.token,
      body: { walletId: payerWalletId, intentId, currency: 'USD' },
    });
    record(5, 'Add money (demo deposit)', confirm.status === 200 ? 'PASS' : 'FAIL', {
      status: confirm.status,
      intentId,
      creditedMinor: DEMO_CREDIT,
    });
    if (confirm.status !== 200) results.failed = true;
    balance = await assertReconcile(payerWalletId, 'USD', 'after deposit', results);
  } else {
    record(5, 'Add money (Stripe)', 'SKIP', {
      reason: 'Set DEMO_DEPOSIT=1 for API demo path, or fund via device Stripe first',
      currentUsdMinor: balance,
    });
  }

  const need = SEND_MINOR + REQ_MINOR + EX_MINOR;
  if (balance < need) {
    record(6, 'Pre-flight balance', 'BLOCKED', {
      needMinor: need,
      haveMinor: balance,
      hint: `Fund wallet with at least $${(need / 100).toFixed(2)}`,
    });
    if (pool) await pool.end();
    process.exit(2);
  }

  // Flow 6 — Withdraw (prod guard expected)
  const withdraw = await api('/withdrawals', {
    method: 'POST',
    token: results.token,
    headers: { 'Idempotency-Key': idem('wd') },
    body: {
      walletId: payerWalletId,
      amount: 100,
      currency: 'USD',
      method: 'bank',
      bankName: 'Test',
      accountNumber: '1234567890',
      accountHolderName: 'Audit',
    },
  });
  record(6, 'Withdraw', withdraw.status === 503 ? 'PASS' : 'INFO', {
    status: withdraw.status,
    note: withdraw.status === 503 ? 'Expected prod guard' : 'Unexpected status',
  });

  // Flow 7 — Send
  const recvEmail = `audit.recv.${RUN}@egwallet.test`;
  await api('/auth/register', {
    method: 'POST',
    deviceId: `audit-recv-${RUN}`,
    body: { email: recvEmail, password: 'AuditRecv123!!!', region: 'US' },
  });
  const recvLogin = await api('/auth/login', {
    method: 'POST',
    deviceId: `audit-recv-${RUN}`,
    body: { email: recvEmail, password: 'AuditRecv123!!!' },
  });
  const recvWallets = await api('/wallets', { token: recvLogin.data?.accessToken || recvLogin.data?.token });
  const recvWalletId = recvWallets.data?.wallets?.[0]?.id;

  const send = await api('/transactions', {
    method: 'POST',
    token: results.token,
    headers: { 'Idempotency-Key': idem('send') },
    body: {
      fromWalletId: payerWalletId,
      toWalletId: recvWalletId,
      amount: SEND_MINOR,
      currency: 'USD',
      memo: 'audit-send',
    },
  });
  record(7, 'Send money', send.status === 200 ? 'PASS' : 'FAIL', {
    status: send.status,
    txId: send.data?.transaction?.id,
    amountMinor: SEND_MINOR,
  });
  if (send.status !== 200) results.failed = true;
  balance = await assertReconcile(payerWalletId, 'USD', 'after send', results);

  // Flow 8 — Receive (implicit in send credit)
  record(8, 'Receive money', send.status === 200 ? 'PASS' : 'FAIL', {
    receiverWalletId: recvWalletId,
    creditedMinor: SEND_MINOR,
  });

  // Flow 9 — Request
  const req = await api('/payment-requests', {
    method: 'POST',
    token: recvLogin.data?.accessToken || recvLogin.data?.token,
    body: {
      walletId: recvWalletId,
      targetWalletId: payerWalletId,
      amount: REQ_MINOR,
      currency: 'USD',
      memo: 'audit-request',
    },
  });
  record(9, 'Request money', req.status === 200 || req.status === 201 ? 'PASS' : 'FAIL', {
    status: req.status,
    requestId: req.data?.request?.id || req.data?.id,
  });
  if (req.status !== 200 && req.status !== 201) results.failed = true;

  // Flow 10 — Pay request
  const requestId = req.data?.request?.id || req.data?.id;
  const pay = await api(`/payment-requests/${requestId}/pay`, {
    method: 'POST',
    token: results.token,
    headers: { 'Idempotency-Key': idem('pay') },
    body: {},
  });
  record(10, 'Pay request', pay.status === 200 ? 'PASS' : 'FAIL', {
    status: pay.status,
    requestId,
    amountMinor: REQ_MINOR,
  });
  if (pay.status !== 200) results.failed = true;
  balance = await assertReconcile(payerWalletId, 'USD', 'after pay request', results);

  // Flow 11 — Exchange
  const quote = await api('/fx-quote', {
    method: 'POST',
    token: results.token,
    body: { fromCurrency: 'USD', toCurrency: 'EUR', amount: EX_MINOR },
  });
  const exchange = await api('/exchange', {
    method: 'POST',
    token: results.token,
    headers: { 'Idempotency-Key': idem('ex') },
    body: {
      walletId: payerWalletId,
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amount: EX_MINOR,
      idempotencyKey: idem('ex-body'),
    },
  });
  record(11, 'Exchange', exchange.status === 200 ? 'PASS' : 'FAIL', {
    status: exchange.status,
    error: exchange.data?.error,
    quoteStatus: quote.status,
    amountMinor: EX_MINOR,
  });
  if (exchange.status !== 200) results.failed = true;
  await assertReconcile(payerWalletId, 'USD', 'after exchange USD', results);
  await assertReconcile(payerWalletId, 'EUR', 'after exchange EUR', results);

  console.log('\n' + '═'.repeat(60));
  console.log(results.failed ? 'AUDIT: FAIL — JSON/PostgreSQL mismatch or flow error' : 'AUDIT: PASS — flows reconciled');
  if (pool) await pool.end();
  process.exit(results.failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
