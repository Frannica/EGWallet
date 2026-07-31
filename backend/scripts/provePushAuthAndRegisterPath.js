'use strict';
/**
 * Prove auth → register → DB storage → test-self queue path on production.
 * Uses a synthetic Expo token shape (not a real device token).
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/provePushAuthAndRegisterPath.js
 */
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const BASE = process.env.PUBLIC_API_BASE || 'https://egwalletsimple-production.up.railway.app';

async function api(method, path, { token, body, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL : null);
  if (!url) {
    console.error('DATABASE_PUBLIC_URL required');
    process.exit(2);
  }

  const stamp = Date.now().toString(36);
  const email = `e2e.push.${stamp}@egwallet.e2e.test`;
  const password = `E2e!Push${stamp}Aa1`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const reg = await api('POST', '/auth/register', {
    headers: { 'x-device-id': `push-proof-${stamp}` },
    body: {
      email,
      password,
      region: 'US',
      username: `psh${stamp}`.replace(/[^a-z0-9_]/g, '').slice(0, 20),
    },
  });
  if (!(reg.status === 200 && reg.json.token)) {
    console.log(JSON.stringify({ ok: false, stage: 'register_user', status: reg.status, err: reg.json.error }, null, 2));
    process.exit(3);
  }
  const token = reg.json.token;
  const userId = reg.json.user?.id || reg.json.userId;
  const deviceId = `device-proof-${stamp}`;
  const expoToken = `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`;

  const unauthorized = await api('POST', '/push/test-self', {
    body: { confirm: 'SEND_TEST_PUSH_TO_ME' },
  });
  const registerPush = await api('POST', '/push/register', {
    token,
    body: {
      token: expoToken,
      deviceId,
      platform: 'android',
      appVersion: 'proof',
    },
  });
  const testSelf = await api('POST', '/push/test-self', {
    token,
    body: { confirm: 'SEND_TEST_PUSH_TO_ME' },
  });

  await sleep(2500);

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const stored = await client.query(
    `SELECT enabled, platform, app_version, last_error IS NOT NULL AS has_error
       FROM push_tokens WHERE user_id = $1`,
    [userId]
  );
  const attempts = await client.query(
    `SELECT status, LEFT(COALESCE(error,''),80) AS error, provider_ticket IS NOT NULL AS has_ticket
       FROM push_delivery_attempts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [userId]
  );

  // Cleanup disposable account balances/tokens (soft) — keep audit rows if any
  await client.query(`UPDATE push_tokens SET enabled=FALSE, last_error='proof_cleanup' WHERE user_id=$1`, [userId]);
  await client.query(
    `UPDATE users SET email='deleted-e2e-'||id::text||'@egwallet.deleted', status='deleted',
            token_version = COALESCE(token_version,0)+1 WHERE id=$1`,
    [userId]
  );
  await client.end();

  const report = {
    ok:
      unauthorized.status === 401
      && registerPush.status === 200
      && testSelf.status === 200
      && testSelf.json.tokenCount >= 1
      && stored.rowCount >= 1
      && stored.rows[0].enabled === true,
    stages: {
      unauthenticatedTestSelfRejected: unauthorized.status === 401,
      pushRegister: { status: registerPush.status, ok: registerPush.json.ok === true },
      testSelf: {
        status: testSelf.status,
        tokenCount: testSelf.json.tokenCount,
        queued: testSelf.json.queued === true,
        errorCode: testSelf.json.errorCode || null,
      },
      dbTokenStored: stored.rows[0] || null,
      deliveryAttempts: attempts.rows,
    },
    rootCauseOfPhoneFailure:
      'Production logs showed POST /push/test-self → 401 and push_tokens count was 0. Client used a stale access token without refresh; register/storage/delivery never ran.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 3);
}

main().catch((e) => { console.error(e); process.exit(1); });
