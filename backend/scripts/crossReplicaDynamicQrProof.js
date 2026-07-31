'use strict';
/**
 * Cross-replica dynamic QR proof against production API.
 * Create on one request, pay/validate from subsequent requests (any replica).
 * Also proves expired / tampered / duplicate rejection.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/crossReplicaDynamicQrProof.js
 */
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

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
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL : null);
  if (!url || !process.env.JWT_SECRET) {
    console.error('DATABASE_PUBLIC_URL + JWT_SECRET required');
    process.exit(2);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const rows = await client.query(
    `SELECT u.id, u.email, COALESCE(u.token_version,0) AS token_version, w.id AS wallet_id
       FROM users u JOIN wallets w ON w.user_id = u.id
      WHERE u.email LIKE '%@egwallet.e2e.test'
        AND (w.type IS NULL OR w.type IN ('personal',''))
      ORDER BY u.created_at DESC LIMIT 20`
  );
  const by = new Map();
  for (const r of rows.rows) if (!by.has(r.email)) by.set(r.email, r);
  const picked = [...by.values()].slice(0, 2);
  if (picked.length < 2) {
    check('accounts', false, 'need e2e accounts');
    await client.end();
    process.exit(3);
  }
  const payer = picked[0];
  const recv = picked[1];
  const mint = (u) => jwt.sign(
    { userId: u.id, email: u.email, type: 'access', tokenVersion: Number(u.token_version || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );
  const tokenP = mint(payer);
  const tokenR = mint(recv);

  await client.query(
    `INSERT INTO wallet_balances(wallet_id,currency,amount) VALUES ($1,'USD',800)
     ON CONFLICT (wallet_id,currency) DO UPDATE SET amount = GREATEST(wallet_balances.amount, 400)`,
    [payer.wallet_id]
  );
  const admin = (await client.query(
    `SELECT id,email,role,COALESCE(token_version,0) AS token_version FROM admin_users WHERE status='active' ORDER BY created_at ASC LIMIT 1`
  )).rows[0];
  const adminToken = jwt.sign(
    { adminId: admin.id, email: admin.email, role: admin.role, type: 'admin_access', tokenVersion: Number(admin.token_version || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  await api('POST', '/admin/ledger/heal-balances', {
    token: adminToken,
    body: { walletIds: [payer.wallet_id, recv.wallet_id], dryRun: false },
  });

  // Ensure users not held
  await api('POST', `/admin/users/${payer.id}/holds`, {
    token: adminToken,
    body: { fraudHold: false, amlHold: false, sanctionsHold: false, courtOrderHold: false },
  });
  await api('POST', `/admin/users/${payer.id}/unfreeze`, { token: adminToken, body: {} });
  await api('POST', `/admin/users/${payer.id}/unsuspend`, { token: adminToken, body: {} });

  const created = await api('POST', '/qr/dynamic', {
    token: tokenR,
    body: { amount: 40, currency: 'USD', memo: 'cross-replica', expiryMinutes: 10 },
  });
  check('dynamic_create_pg', created.status === 200 && created.json.durable === true && !!created.json.qrCode, {
    status: created.status, err: created.json.error, durable: created.json.durable, requestId: created.json.requestId,
  });
  const qr = created.json.qrCode;
  const requestId = created.json.requestId;

  // Validate from a fresh request (likely different replica)
  const validated = await api('POST', '/qr/validate', { token: tokenP, body: { qrString: qr } });
  check('dynamic_validate_cross_request', validated.status === 200 && validated.json.valid === true, {
    status: validated.status, valid: validated.json.valid, code: validated.json.code, err: validated.json.error,
  });

  // Tampered
  const tampered = qr.replace(/a=\d+/, 'a=999');
  const tamperVal = await api('POST', '/qr/validate', { token: tokenP, body: { qrString: tampered } });
  check('tampered_rejected', tamperVal.json.valid === false && tamperVal.json.code === 'TAMPERED', tamperVal.json);

  // Successful pay
  const pay = await api('POST', '/qr/pay', {
    token: tokenP,
    headers: { 'Idempotency-Key': `xr-pay-${randomUUID()}` },
    body: { qrString: qr, fromWalletId: payer.wallet_id, idempotencyKey: `xr-pay-${randomUUID()}` },
  });
  check('dynamic_pay_success', pay.status === 200 && pay.json.success === true, {
    status: pay.status, err: pay.json.error, tx: pay.json.transaction?.id,
  });

  // Duplicate scan
  const dup = await api('POST', '/qr/pay', {
    token: tokenP,
    headers: { 'Idempotency-Key': `xr-dup-${randomUUID()}` },
    body: { qrString: qr, fromWalletId: payer.wallet_id, idempotencyKey: `xr-dup-${randomUUID()}` },
  });
  check('duplicate_scan_rejected', dup.status === 400 && (dup.json.code === 'USED' || /used|already/i.test(String(dup.json.error || ''))), {
    status: dup.status, code: dup.json.code, err: dup.json.error,
  });

  // Expired QR: create short-lived then force expire in PG
  const short = await api('POST', '/qr/dynamic', {
    token: tokenR,
    body: { amount: 25, currency: 'USD', memo: 'expire-me', expiryMinutes: 10 },
  });
  if (short.json.requestId) {
    await client.query(`UPDATE qr_codes SET expires_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [short.json.requestId]);
    const expPay = await api('POST', '/qr/pay', {
      token: tokenP,
      headers: { 'Idempotency-Key': `xr-exp-${randomUUID()}` },
      body: { qrString: short.json.qrCode, fromWalletId: payer.wallet_id, idempotencyKey: `xr-exp-${randomUUID()}` },
    });
    check('expired_rejected', expPay.status === 400 && (expPay.json.code === 'EXPIRED' || /expired/i.test(String(expPay.json.error || ''))), {
      status: expPay.status, code: expPay.json.code, err: expPay.json.error,
    });
  } else {
    check('expired_rejected', false, short.json);
  }

  // PG proof row used
  if (requestId) {
    const row = await client.query(`SELECT status, used_at IS NOT NULL AS used FROM qr_codes WHERE id=$1`, [requestId]);
    check('pg_qr_marked_used', row.rowCount === 1 && row.rows[0].status === 'used' && row.rows[0].used === true, row.rows[0]);
  }

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
