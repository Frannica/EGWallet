'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const {
  isValidExpoPushToken,
  registerPushToken,
  unregisterPushToken,
  setUserPushEnabled,
  isUserPushEnabled,
  listEnabledTokensForUser,
  reserveDeliveryAttempt,
  disableToken,
} = require('../db/pushTokens');
const {
  isDeviceNotRegistered,
  getPushProviderReadiness,
  deliverPushForNotification,
} = require('../pushNotifications');

function requireDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL,
      token TEXT NOT NULL,
      platform TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      app_version TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ,
      last_error TEXT,
      CONSTRAINT push_tokens_token_unique UNIQUE (token),
      CONSTRAINT push_tokens_user_device_unique UNIQUE (user_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS push_delivery_attempts (
      id UUID PRIMARY KEY,
      notification_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id),
      token TEXT NOT NULL,
      provider_ticket TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT push_delivery_notification_token_unique UNIQUE (notification_id, token)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  `);
}

async function seedUser(id, email) {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1,$2,'x','US','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
    [id, email]
  );
}

async function cleanup(userIds) {
  await pool.query('DELETE FROM push_delivery_attempts WHERE user_id = ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM push_tokens WHERE user_id = ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

test('push token format validation', () => {
  assert.equal(isValidExpoPushToken('ExponentPushToken[abcdef]'), true);
  assert.equal(isValidExpoPushToken('ExpoPushToken[xyz]'), true);
  assert.equal(isValidExpoPushToken('fcm:raw'), false);
  assert.equal(isValidExpoPushToken(''), false);
  assert.equal(isValidExpoPushToken(null), false);
});

test('DeviceNotRegistered detection', () => {
  assert.equal(isDeviceNotRegistered({ details: { error: 'DeviceNotRegistered' } }), true);
  assert.equal(isDeviceNotRegistered({ message: 'ok' }), false);
});

test('push provider readiness never exposes secrets', () => {
  const prev = process.env.EXPO_ACCESS_TOKEN;
  process.env.EXPO_ACCESS_TOKEN = 'secret-should-not-appear';
  try {
    const r = getPushProviderReadiness();
    assert.equal(r.provider, 'expo');
    assert.equal(r.expoAccessTokenConfigured, true);
    const json = JSON.stringify(r);
    assert.equal(json.includes('secret-should-not-appear'), false);
    assert.equal(json.includes('Authorization'), false);
  } finally {
    if (prev === undefined) delete process.env.EXPO_ACCESS_TOKEN;
    else process.env.EXPO_ACCESS_TOKEN = prev;
  }
});

test('register binds token to authenticated user only; reassign steals from previous user', async () => {
  requireDb();
  await ensureSchema();
  const a = uuidv4();
  const b = uuidv4();
  const token = `ExponentPushToken[${uuidv4().replace(/-/g, '').slice(0, 22)}]`;
  try {
    await seedUser(a, `${a}@push.test`);
    await seedUser(b, `${b}@push.test`);
    await registerPushToken({ userId: a, deviceId: 'device-aaaa-1111', token, platform: 'android' });
    let tokensA = await listEnabledTokensForUser(a);
    assert.equal(tokensA.length, 1);

    await registerPushToken({ userId: b, deviceId: 'device-bbbb-2222', token, platform: 'ios' });
    tokensA = await listEnabledTokensForUser(a);
    const tokensB = await listEnabledTokensForUser(b);
    assert.equal(tokensA.length, 0);
    assert.equal(tokensB.length, 1);
    assert.equal(tokensB[0].token, token);
  } finally {
    await cleanup([a, b]);
  }
});

test('register creates placeholder Postgres user when JSON-only account has no users row', async () => {
  requireDb();
  await ensureSchema();
  const u = uuidv4();
  const token = `ExponentPushToken[${uuidv4().replace(/-/g, '').slice(0, 22)}]`;
  try {
    // Intentionally do NOT seed users row — mimics production JSON-first auth.
    const row = await registerPushToken({
      userId: u,
      deviceId: 'device-json-only-1',
      token,
      platform: 'android',
      email: `${u}@jsononly.test`,
    });
    assert.ok(row.id);
    const pg = await pool.query('SELECT email FROM users WHERE id=$1', [u]);
    assert.equal(pg.rowCount, 1);
    assert.equal((await listEnabledTokensForUser(u)).length, 1);
  } finally {
    await cleanup([u]);
  }
});

test('opt-out and logout unregister disable delivery', async () => {
  requireDb();
  await ensureSchema();
  const u = uuidv4();
  const token = `ExponentPushToken[${uuidv4().replace(/-/g, '').slice(0, 22)}]`;
  try {
    await seedUser(u, `${u}@push.test`);
    await registerPushToken({ userId: u, deviceId: 'device-cccc-3333', token, platform: 'android' });
    assert.equal(await isUserPushEnabled(u), true);
    await setUserPushEnabled(u, false);
    assert.equal(await isUserPushEnabled(u), false);
    assert.equal((await listEnabledTokensForUser(u)).length, 0);

    await registerPushToken({ userId: u, deviceId: 'device-cccc-3333', token, platform: 'android' });
    await setUserPushEnabled(u, true);
    await unregisterPushToken({ userId: u, deviceId: 'device-cccc-3333' });
    assert.equal((await listEnabledTokensForUser(u)).length, 0);
  } finally {
    await cleanup([u]);
  }
});

test('duplicate delivery attempts are prevented', async () => {
  requireDb();
  await ensureSchema();
  const u = uuidv4();
  const token = `ExponentPushToken[${uuidv4().replace(/-/g, '').slice(0, 22)}]`;
  const nid = uuidv4();
  try {
    await seedUser(u, `${u}@push.test`);
    const first = await reserveDeliveryAttempt({ notificationId: nid, userId: u, token });
    const second = await reserveDeliveryAttempt({ notificationId: nid, userId: u, token });
    assert.equal(first, true);
    assert.equal(second, false);
  } finally {
    await cleanup([u]);
  }
});

test('invalid token disable works', async () => {
  requireDb();
  await ensureSchema();
  const u = uuidv4();
  const token = `ExponentPushToken[${uuidv4().replace(/-/g, '').slice(0, 22)}]`;
  try {
    await seedUser(u, `${u}@push.test`);
    await registerPushToken({ userId: u, deviceId: 'device-dddd-4444', token, platform: 'ios' });
    await disableToken(token, 'DeviceNotRegistered');
    assert.equal((await listEnabledTokensForUser(u)).length, 0);
  } finally {
    await cleanup([u]);
  }
});

test('deliverPush skips when user has no tokens (no network)', async () => {
  requireDb();
  await ensureSchema();
  const u = uuidv4();
  try {
    await seedUser(u, `${u}@push.test`);
    const r = await deliverPushForNotification({
      userId: u,
      notificationId: uuidv4(),
      type: 'test',
      title: 't',
      body: 'b',
      metadata: {},
    });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no_tokens');
  } finally {
    await cleanup([u]);
  }
});
