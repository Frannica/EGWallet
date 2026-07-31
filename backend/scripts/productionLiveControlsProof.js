'use strict';
/**
 * Live production proof that holds/freeze/suspend block money ops BEFORE debit.
 * No Stripe/Kora. Uses disposable @egwallet.e2e.test accounts + internal float.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/productionLiveControlsProof.js
 */
const { Client } = require('pg');
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');

const BASE = process.env.PUBLIC_API_BASE || 'https://egwalletsimple-production.up.railway.app';
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, result: pass ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.error(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

async function api(method, path, { token, body, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL : null);
  if (!url || !process.env.JWT_SECRET) {
    console.error('DATABASE_PUBLIC_URL and JWT_SECRET required');
    process.exit(2);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const users = await client.query(
    `SELECT u.id, u.email, COALESCE(u.token_version,0) AS token_version, w.id AS wallet_id
       FROM users u JOIN wallets w ON w.user_id = u.id
      WHERE u.email LIKE '%@egwallet.e2e.test'
        AND (w.type IS NULL OR w.type IN ('personal',''))
      ORDER BY u.created_at DESC LIMIT 10`
  );
  const byEmail = new Map();
  for (const r of users.rows) if (!byEmail.has(r.email)) byEmail.set(r.email, r);
  const picked = [...byEmail.values()].slice(0, 2);
  if (picked.length < 2) {
    check('accounts', false, 'need >=2 e2e accounts');
    await client.end();
    process.exit(3);
  }
  const payer = picked[0];
  const payee = picked[1];
  const tokenPayer = jwt.sign(
    { userId: payer.id, email: payer.email, type: 'access', tokenVersion: Number(payer.token_version || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );

  // Ensure spendable float
  await client.query(
    `INSERT INTO wallet_balances(wallet_id,currency,amount) VALUES ($1,'USD',500)
     ON CONFLICT (wallet_id,currency) DO UPDATE SET amount = GREATEST(wallet_balances.amount, 200)`,
    [payer.wallet_id]
  );

  const adminRow = await client.query(
    `SELECT id, email, role, COALESCE(token_version,0) AS token_version FROM admin_users WHERE status='active' ORDER BY created_at ASC LIMIT 1`
  );
  const admin = adminRow.rows[0];
  const adminToken = jwt.sign(
    { adminId: admin.id, email: admin.email, role: admin.role, type: 'admin_access', tokenVersion: Number(admin.token_version || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  // Heal JSON balances so preflight sees funds
  await api('POST', '/admin/ledger/heal-balances', {
    token: adminToken,
    body: { walletIds: [payer.wallet_id, payee.wallet_id], dryRun: false },
  });

  async function bal() {
    const r = await client.query(
      `SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency='USD'`,
      [payer.wallet_id]
    );
    return Number(r.rows[0]?.amount || 0);
  }

  async function trySend(label) {
    const before = await bal();
    const res = await api('POST', '/transactions', {
      token: tokenPayer,
      headers: { 'Idempotency-Key': `ctrl-${label}-${randomUUID()}` },
      body: {
        fromWalletId: payer.wallet_id,
        toWalletId: payee.email,
        amount: 5,
        currency: 'USD',
        idempotencyKey: `ctrl-${label}-${randomUUID()}`,
      },
    });
    const after = await bal();
    return { res, before, after, debit: before - after };
  }

  const scenarios = [
    { name: 'fraudHold', set: { fraudHold: true }, clear: { fraudHold: false }, code: 'FRAUD_REVIEW_REQUIRED' },
    { name: 'amlHold', set: { amlHold: true }, clear: { amlHold: false }, code: 'COMPLIANCE_REVIEW_REQUIRED' },
    { name: 'sanctionsHold', set: { sanctionsHold: true }, clear: { sanctionsHold: false }, code: 'SANCTIONS_REVIEW_REQUIRED' },
    { name: 'courtOrderHold', set: { courtOrderHold: true }, clear: { courtOrderHold: false }, code: 'LEGAL_HOLD_REVIEW_REQUIRED' },
  ];

  for (const sc of scenarios) {
    await api('POST', `/admin/users/${payer.id}/holds`, { token: adminToken, body: sc.set });
    const { res, debit } = await trySend(sc.name);
    check(`${sc.name}_blocks_before_debit`, res.status === 403 && res.json.code === sc.code && debit === 0, {
      status: res.status, code: res.json.code, debit,
    });
    await api('POST', `/admin/users/${payer.id}/holds`, { token: adminToken, body: sc.clear });
  }

  await api('POST', `/admin/users/${payer.id}/freeze`, { token: adminToken, body: {} });
  {
    const { res, debit } = await trySend('frozen');
    check('frozen_blocks_before_debit', res.status === 403 && res.json.code === 'ACCOUNT_FROZEN' && debit === 0, {
      status: res.status, code: res.json.code, debit,
    });
  }
  await api('POST', `/admin/users/${payer.id}/unfreeze`, { token: adminToken, body: {} });

  // Suspend needs CSRF — set via holds path alternative: reuse freeze-style if suspend CSRF fails
  const sus = await api('POST', `/admin/users/${payer.id}/suspend`, { token: adminToken, body: {} });
  if (sus.status === 200) {
    const { res, debit } = await trySend('suspended');
    check('suspended_blocks_before_debit', res.status === 403 && res.json.code === 'ACCOUNT_SUSPENDED' && debit === 0, {
      status: res.status, code: res.json.code, debit,
    });
    await api('POST', `/admin/users/${payer.id}/unsuspend`, { token: adminToken, body: {} });
  } else {
    // Fallback: set accountStatus via freeze-equivalent hold path already covered; mark suspend via SSH-less JSON by freeze reuse
    // Use lock instead (also CSRF) — if both fail, set frozen already proven and document suspend CSRF gap
    check('suspended_blocks_before_debit', false, { status: sus.status, err: sus.json.error, note: 'admin CSRF required for suspend; freeze proven' });
  }

  // Clear all holds/status
  await api('POST', `/admin/users/${payer.id}/holds`, {
    token: adminToken,
    body: { fraudHold: false, amlHold: false, sanctionsHold: false, courtOrderHold: false },
  });
  await api('POST', `/admin/users/${payer.id}/unfreeze`, { token: adminToken, body: {} });

  await client.end();
  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    total: checks.length,
  };
  console.log(JSON.stringify({ checks, summary }, null, 2));
  process.exit(summary.fail === 0 ? 0 : 3);
}

main().catch((e) => { console.error(e); process.exit(1); });
