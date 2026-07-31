'use strict';
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const BASE = process.env.PUBLIC_API_BASE || 'https://egwalletsimple-production.up.railway.app';

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) throw new Error('DATABASE_PUBLIC_URL required');
  const stamp = Date.now().toString(36);
  const email = `e2e.pushd.${stamp}@egwallet.e2e.test`;
  const password = `E2e!Push${stamp}Aa1`;

  const regRes = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-id': `diag-${stamp}` },
    body: JSON.stringify({
      email,
      password,
      region: 'US',
      username: `pd${stamp}`.replace(/[^a-z0-9_]/g, '').slice(0, 20),
    }),
  });
  const reg = await regRes.json().catch(() => ({}));
  const userId = reg.user?.id || reg.userId || null;
  const report = {
    authRegisterStatus: regRes.status,
    hasToken: !!reg.token,
    userIdPresent: !!userId,
  };
  if (!reg.token || !userId) {
    console.log(JSON.stringify({ ...report, authError: reg.error || null }, null, 2));
    process.exit(3);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const pgUser = await client.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  report.pgUserExists = pgUser.rowCount > 0;

  const pushRes = await fetch(`${BASE}/push/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${reg.token}`,
    },
    body: JSON.stringify({
      token: `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`,
      deviceId: `diag-device-${stamp}`,
      platform: 'android',
      appVersion: 'diag',
    }),
  });
  const push = await pushRes.json().catch(() => ({}));
  report.pushRegisterStatus = pushRes.status;
  report.pushError = push.error || null;
  report.pushErrorCode = push.errorCode || null;

  // Direct DB insert to see FK error
  if (!report.pgUserExists) {
    try {
      await client.query(
        `INSERT INTO push_tokens (id, user_id, device_id, token, platform, enabled)
         VALUES ($1,$2,$3,$4,'android',TRUE)`,
        [randomUUID(), userId, `x-${stamp}`, `ExponentPushToken[db${stamp}]`]
      );
      report.directInsert = 'unexpected_success';
    } catch (e) {
      report.directInsertErrorCode = e.code || null;
      report.directInsertError = String(e.message || '').slice(0, 160);
    }
  }

  // cleanup
  await client.query('DELETE FROM push_tokens WHERE user_id = $1', [userId]).catch(() => {});
  await client.query(
    `UPDATE users SET email = 'deleted-e2e-'||id::text||'@egwallet.deleted', status='deleted'
      WHERE id = $1`,
    [userId]
  ).catch(() => {});
  await client.end();

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
