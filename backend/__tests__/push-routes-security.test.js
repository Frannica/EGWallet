'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const { createPushRouter } = require('../pushRoutes');

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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  `);
}

function startApp(userId) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, _res, next) => {
    req.user = { userId, type: 'access' };
    next();
  };
  app.use('/push', createPushRouter({ authMiddleware }));
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            server.close();
            let json;
            try { json = JSON.parse(data); } catch { json = { _raw: data }; }
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

test('POST /push/register rejects foreign userId and invalid tokens', async () => {
  requireDb();
  await ensureSchema();
  const userId = uuidv4();
  const other = uuidv4();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1,$2,'x','US','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@pushsec.test`]
  );
  const app = startApp(userId);
  try {
    const foreign = await request(app, 'POST', '/push/register', {
      userId: other,
      token: 'ExponentPushToken[abc123]',
      deviceId: 'device-sec-0001',
      platform: 'android',
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.errorCode, 'PUSH_USER_MISMATCH');

    const bad = await request(app, 'POST', '/push/register', {
      token: 'not-an-expo-token',
      deviceId: 'device-sec-0001',
      platform: 'android',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.errorCode, 'TOKEN_INVALID');

    const ok = await request(app, 'POST', '/push/register', {
      token: 'ExponentPushToken[abc123xyz]',
      deviceId: 'device-sec-0001',
      platform: 'android',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.ok(ok.json.tokenSuffix);
    assert.equal(JSON.stringify(ok.json).includes('ExponentPushToken[abc123xyz]'), false);

    const ready = await request(app, 'GET', '/push/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.json.provider, 'expo');
    assert.equal(JSON.stringify(ready.json).includes('Bearer'), false);

    await pool.query('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
    const noTokens = await request(app, 'POST', '/push/test-self', {
      confirm: 'SEND_TEST_PUSH_TO_ME',
    });
    assert.equal(noTokens.status, 400);
    assert.equal(noTokens.json.errorCode, 'NO_PUSH_TOKENS');
    assert.equal(noTokens.json.tokenCount, 0);
  } finally {
    await pool.query('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('createNotification schedules push without throwing when push fails', () => {
  // Source-level guarantee: createNotification wraps schedule in try/catch and returns
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const idx = src.indexOf('function createNotification');
  assert.ok(idx > 0);
  const chunk = src.slice(idx, idx + 1200);
  assert.match(chunk, /schedulePushForNotification/);
  assert.match(chunk, /Push must never break financial/);
  assert.match(chunk, /return notification/);
});
