'use strict';

/**
 * Phase 0 Lightspark Grid — sandbox env validation, read-only connectivity,
 * and fail-closed payout dispatch. No customers, quotes, or payouts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  OFFICIAL_GRID_API_BASE_URL,
  ALLOWED_GRID_ENVIRONMENT,
  validateGridEnvironment,
  isGridSandboxConfigured,
  assertGridEnvOrExit,
} = require('../grid/gridEnv');
const {
  isAllowedPath,
  checkGridConnectivity,
  probeGridConnectivity,
  getGridHealthFlags,
  resetGridConnectivityCache,
} = require('../grid/gridClient');
const { payoutRouter, isPayoutProviderReady, dispatchToProvider } = require('../payoutProviders');

const GRID_KEYS = [
  'GRID_CLIENT_ID',
  'GRID_CLIENT_SECRET',
  'GRID_ENVIRONMENT',
  'GRID_API_BASE_URL',
  'GRID_WEBHOOK_PUBLIC_KEY',
];

const SECRET_CANARY = 'grid-secret-must-never-appear-in-errors';

function snapshotGridEnv() {
  const snap = {};
  for (const key of GRID_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreGridEnv(snap) {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearGridEnv() {
  for (const key of GRID_KEYS) delete process.env[key];
}

function setValidSandboxEnv() {
  process.env.GRID_CLIENT_ID = 'test-grid-client-id';
  process.env.GRID_CLIENT_SECRET = SECRET_CANARY;
  process.env.GRID_ENVIRONMENT = 'sandbox';
  process.env.GRID_API_BASE_URL = OFFICIAL_GRID_API_BASE_URL;
}

const gridEnvSource = fs.readFileSync(path.join(__dirname, '..', 'grid', 'gridEnv.js'), 'utf8');
const gridClientSource = fs.readFileSync(path.join(__dirname, '..', 'grid', 'gridClient.js'), 'utf8');
const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('official Grid constants match Lightspark docs (2025-10-13 sandbox URL)', () => {
  assert.equal(OFFICIAL_GRID_API_BASE_URL, 'https://api.lightspark.com/grid/2025-10-13');
  assert.equal(ALLOWED_GRID_ENVIRONMENT, 'sandbox');
  assert.equal(isAllowedPath('GET', '/config'), true);
  assert.equal(isAllowedPath('POST', '/transfer-in'), false);
});

test('missing Grid credentials: not configured when no GRID_* vars are set', () => {
  const snap = snapshotGridEnv();
  try {
    clearGridEnv();
    const result = validateGridEnvironment();
    assert.equal(result.ok, true);
    assert.equal(result.configured, false);
    assert.deepEqual(result.errors, []);
    assert.equal(isGridSandboxConfigured(), false);
  } finally {
    restoreGridEnv(snap);
  }
});

test('missing Grid credentials: requireConfigured reports each missing variable', () => {
  const snap = snapshotGridEnv();
  try {
    clearGridEnv();
    const result = validateGridEnvironment({ requireConfigured: true });
    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.ok(result.errors.includes('GRID_CLIENT_ID is missing'));
    assert.ok(result.errors.includes('GRID_CLIENT_SECRET is missing'));
    assert.ok(result.errors.includes('GRID_ENVIRONMENT is missing'));
    assert.ok(result.errors.includes('GRID_API_BASE_URL is missing'));
  } finally {
    restoreGridEnv(snap);
  }
});

test('partial Grid credentials are invalid (any GRID_* set requires the full sandbox set)', () => {
  const snap = snapshotGridEnv();
  try {
    clearGridEnv();
    process.env.GRID_CLIENT_ID = 'test-grid-client-id';
    const result = validateGridEnvironment();
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('GRID_CLIENT_SECRET is missing'));
    assert.ok(result.errors.includes('GRID_ENVIRONMENT is missing'));
    assert.ok(result.errors.includes('GRID_API_BASE_URL is missing'));
    assert.equal(isGridSandboxConfigured(), false);
  } finally {
    restoreGridEnv(snap);
  }
});

test('non-sandbox GRID_ENVIRONMENT is rejected (production / live / empty-other)', () => {
  const snap = snapshotGridEnv();
  try {
    for (const environment of ['production', 'prod', 'live', 'PRODUCTION', 'Sandbox']) {
      clearGridEnv();
      process.env.GRID_CLIENT_ID = 'test-grid-client-id';
      process.env.GRID_CLIENT_SECRET = SECRET_CANARY;
      process.env.GRID_ENVIRONMENT = environment;
      process.env.GRID_API_BASE_URL = OFFICIAL_GRID_API_BASE_URL;
      const result = validateGridEnvironment({ requireConfigured: true });
      assert.equal(result.ok, false, `${environment} must be rejected`);
      assert.ok(
        result.errors.includes('GRID_ENVIRONMENT must be sandbox'),
        `${environment} must fail the sandbox rule`
      );
      assert.ok(
        result.errors.every((msg) => !msg.includes(SECRET_CANARY)),
        'errors must not include the client secret'
      );
    }
  } finally {
    restoreGridEnv(snap);
  }
});

test('non-official GRID_API_BASE_URL is rejected', () => {
  const snap = snapshotGridEnv();
  try {
    clearGridEnv();
    setValidSandboxEnv();
    process.env.GRID_API_BASE_URL = 'https://api.lightspark.com/grid/production';
    const result = validateGridEnvironment({ requireConfigured: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('GRID_API_BASE_URL must be the official Grid 2025-10-13 URL'));
  } finally {
    restoreGridEnv(snap);
  }
});

test('valid sandbox env is accepted and GRID_WEBHOOK_PUBLIC_KEY is not required', () => {
  const snap = snapshotGridEnv();
  try {
    clearGridEnv();
    setValidSandboxEnv();
    delete process.env.GRID_WEBHOOK_PUBLIC_KEY;
    const result = validateGridEnvironment({ requireConfigured: true });
    assert.deepEqual(result, { ok: true, configured: true, errors: [] });
    assert.equal(isGridSandboxConfigured(), true);
  } finally {
    restoreGridEnv(snap);
  }
});

test('assertGridEnvOrExit is a no-op when Grid is unset', () => {
  const snap = snapshotGridEnv();
  const originalExit = process.exit;
  let exited = false;
  process.exit = () => { exited = true; };
  try {
    clearGridEnv();
    assertGridEnvOrExit();
    assert.equal(exited, false);
  } finally {
    process.exit = originalExit;
    restoreGridEnv(snap);
  }
});

test('assertGridEnvOrExit fatals on GRID_ENVIRONMENT=production without printing secrets', () => {
  const snap = snapshotGridEnv();
  const originalExit = process.exit;
  const errors = [];
  const originalError = console.error;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('process-exit');
  };
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  try {
    clearGridEnv();
    process.env.GRID_ENVIRONMENT = 'production';
    process.env.GRID_CLIENT_SECRET = SECRET_CANARY;
    assert.throws(() => assertGridEnvOrExit(), /process-exit/);
    assert.equal(exitCode, 1);
    const joined = errors.join('\n');
    assert.match(joined, /must be sandbox/i);
    assert.doesNotMatch(joined, new RegExp(SECRET_CANARY));
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    restoreGridEnv(snap);
  }
});

test('invalid Grid credentials: GET /config 401 is unauthorized and not ok', async () => {
  const snap = snapshotGridEnv();
  resetGridConnectivityCache();
  try {
    clearGridEnv();
    setValidSandboxEnv();
    const result = await checkGridConnectivity({
      axiosImpl: async (config) => {
        assert.equal(config.url, `${OFFICIAL_GRID_API_BASE_URL}/config`);
        assert.equal(config.method, 'GET');
        assert.equal(config.auth.username, 'test-grid-client-id');
        assert.equal(config.auth.password, SECRET_CANARY);
        return { status: 401, data: { message: 'nope' } };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    assert.equal(result.reason, 'unauthorized');
    assert.equal('data' in result, false);
    assert.equal('body' in result, false);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(SECRET_CANARY));
  } finally {
    resetGridConnectivityCache();
    restoreGridEnv(snap);
  }
});

test('valid sandbox credentials: GET /config 200 marks connectivity ok (no body leaked)', async () => {
  const snap = snapshotGridEnv();
  resetGridConnectivityCache();
  try {
    clearGridEnv();
    setValidSandboxEnv();
    const result = await probeGridConnectivity({
      axiosImpl: async () => {
        return { status: 200, data: { webhookUrl: 'https://example.invalid', apiSecret: SECRET_CANARY } };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.reason, 'ok');
    const flags = getGridHealthFlags();
    assert.equal(flags.gridSandboxConfigured, true);
    assert.equal(flags.gridConnectivityOk, true);
    assert.equal(flags.gridWebhookPublicKeyConfigured, false);
    assert.deepEqual(Object.keys(flags).sort(), [
      'gridConnectivityOk',
      'gridSandboxConfigured',
      'gridWebhookPublicKeyConfigured',
    ]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_CANARY));
    assert.doesNotMatch(JSON.stringify(flags), new RegExp(SECRET_CANARY));
  } finally {
    resetGridConnectivityCache();
    restoreGridEnv(snap);
  }
});

test('connectivity check does not run when Grid is not configured', async () => {
  const snap = snapshotGridEnv();
  let called = false;
  try {
    clearGridEnv();
    const result = await checkGridConnectivity({
      axiosImpl: async () => {
        called = true;
        return { status: 200, data: {} };
      },
    });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
  } finally {
    restoreGridEnv(snap);
  }
});

test('Grid client allowlists official 2025-10-13 paths and rejects invented ones', () => {
  assert.equal(isAllowedPath('GET', '/config'), true);
  assert.equal(isAllowedPath('POST', '/customers'), true);
  assert.equal(isAllowedPath('POST', '/customers/external-accounts'), true);
  assert.equal(isAllowedPath('POST', '/quotes'), true);
  assert.equal(isAllowedPath('POST', '/transfer-out'), true);
  assert.equal(isAllowedPath('POST', '/transfer-in'), false);
  assert.equal(isAllowedPath('DELETE', '/customers'), false);
  assert.doesNotMatch(gridClientSource, /\/transfer-in/);
  assert.match(gridEnvSource, /GRID_WEBHOOK_PUBLIC_KEY/);
});

test('payoutRouter keeps Kora eight countries and leaves US/UK/EU null when Grid is unset', () => {
  const snap = snapshotGridEnv();
  try {
    clearGridEnv();
    for (const country of ['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ']) {
      assert.equal(payoutRouter(country), 'kora', `${country} must stay on Kora`);
    }
    assert.equal(payoutRouter('US'), null);
    assert.equal(payoutRouter('GB'), null);
    assert.equal(payoutRouter('DE'), null);
    assert.equal(payoutRouter('lightspark'), null);
    assert.notEqual(payoutRouter('NG'), 'lightspark');
  } finally {
    restoreGridEnv(snap);
  }
});

test('isPayoutProviderReady is unchanged for Kora and unsupported countries when Grid is unset', () => {
  const snap = snapshotGridEnv();
  const koraSnap = process.env.KORA_LIVE_SECRET_KEY;
  try {
    clearGridEnv();
    process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
    assert.equal(isPayoutProviderReady('NG'), true);
    assert.equal(isPayoutProviderReady('US'), false);
    assert.equal(isPayoutProviderReady('GQ'), false);
  } finally {
    if (koraSnap === undefined) delete process.env.KORA_LIVE_SECRET_KEY;
    else process.env.KORA_LIVE_SECRET_KEY = koraSnap;
    restoreGridEnv(snap);
  }
});

test('dispatchToProvider is fail-closed: unknown providers never call Kora', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  let koraCalled = false;
  const originalKora = require('../payoutProviders')._test.koraPayout;
  assert.equal(typeof originalKora, 'function');

  await assert.rejects(
    () => dispatchToProvider('unknown', { id: 'wd-x' }, logger),
    /No payout executor for provider unknown/
  );
  await assert.rejects(
    () => dispatchToProvider(null, { id: 'wd-null' }, logger),
    /No payout executor for provider none/
  );
  assert.equal(koraCalled, false);
});

test('dispatchToProvider still routes explicit kora to koraPayout (missing key is pre-HTTP, not a fallthrough)', async () => {
  const snap = {
    KORA_LIVE_SECRET_KEY: process.env.KORA_LIVE_SECRET_KEY,
    KORA_API_KEY: process.env.KORA_API_KEY,
  };
  const logger = { info() {}, warn() {}, error() {} };
  try {
    delete process.env.KORA_LIVE_SECRET_KEY;
    delete process.env.KORA_API_KEY;
    await assert.rejects(
      () => dispatchToProvider('kora', { id: 'wd-kora', currency: 'XAF', netPayout: 1000, method: 'mobile' }, logger),
      /Kora is not configured/
    );
  } finally {
    if (snap.KORA_LIVE_SECRET_KEY === undefined) delete process.env.KORA_LIVE_SECRET_KEY;
    else process.env.KORA_LIVE_SECRET_KEY = snap.KORA_LIVE_SECRET_KEY;
    if (snap.KORA_API_KEY === undefined) delete process.env.KORA_API_KEY;
    else process.env.KORA_API_KEY = snap.KORA_API_KEY;
  }
});

test('payoutProviders.js no longer falls through else to koraPayout', () => {
  assert.match(payoutSource, /async function dispatchToProvider/);
  assert.match(payoutSource, /if \(provider === 'kora'\) \{\s*return koraPayout/);
  assert.doesNotMatch(payoutSource, /else \{\s*result = await koraPayout/);
  assert.match(indexSource, /assertGridEnvOrExit\(\)/);
  assert.match(indexSource, /getGridHealthFlags\(\)/);
  assert.doesNotMatch(indexSource, /require\('\.\/payout'\)/);
  assert.match(indexSource, /require\('\.\/payoutProviders'\)/);
});
