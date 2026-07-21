'use strict';

/**
 * Kora LIVE integration — production payout provider tests.
 *
 * Covers:
 *   - Live credential resolution (KORA_LIVE_PUBLIC_KEY / _SECRET_KEY / _ENCRYPTION_KEY)
 *     with backward-compatible fallback to the legacy single KORA_API_KEY var.
 *   - Optional AES-256-GCM payload encryption round-trip (interop with Kora's spec).
 *   - Provider routing / readiness unchanged, and no existing provider removed.
 *   - Idempotency (deterministic reference / dispatch ref), retry safety (no blind
 *     re-POST on retry), and error classification are all still intact.
 *   - Startup guards in index.js: live-key format, encryption-key length.
 *   - Webhook signature verification matches Kora's documented algorithm exactly:
 *     HMAC-SHA256(secretKey, JSON.stringify(data)) — Kora issues NO separate webhook
 *     secret (see https://developers.korapay.com/docs/webhooks), so there must be no
 *     KORA_WEBHOOK_SECRET env var anywhere in the integration.
 *   - Stripe remains the deposit provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const payoutProviders = require('../payoutProviders');
const { payoutRouter, isPayoutProviderReady } = payoutProviders;
const {
  getKoraSecretKey,
  getKoraPublicKey,
  getKoraEncryptionKey,
  encryptKoraPayload,
  verifyKoraWebhookSignature,
  toKoraAmount,
} = payoutProviders._test;

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');
const adminWithdrawalsSource = fs.readFileSync(path.join(__dirname, '..', 'adminWithdrawals.js'), 'utf8');
const envExampleSource = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

// ── env isolation ─────────────────────────────────────────────────────────────
const ENV_KEYS = [
  'KORA_LIVE_PUBLIC_KEY', 'KORA_LIVE_SECRET_KEY', 'KORA_LIVE_ENCRYPTION_KEY',
  'KORA_API_KEY',
];
function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function decryptKoraPayload(encryptionKey, encoded) {
  const [ivHex, cipherHex, tagHex] = encoded.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const cipherText = Buffer.from(cipherHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

// ── Provider list / routing unchanged ─────────────────────────────────────────

test('Kora: country routing unchanged — Africa → kora, everything else → stripe', () => {
  assert.equal(payoutRouter('NG'), 'kora');
  assert.equal(payoutRouter('GH'), 'kora');
  assert.equal(payoutRouter('CM'), 'kora');
  assert.equal(payoutRouter('US'), 'stripe');
  assert.equal(payoutRouter('FR'), 'stripe');
  assert.equal(payoutRouter(''), 'stripe');
  assert.equal(payoutRouter(null), 'stripe');
});

test('Kora: no existing provider removed — stripePayout and koraPayout both still defined', () => {
  assert.match(payoutSource, /async function stripePayout/);
  assert.match(payoutSource, /async function koraPayout/);
  assert.match(payoutSource, /module\.exports = \{/);
  assert.match(payoutSource, /payoutRouter,\s*\n\s*isPayoutProviderReady,\s*\n\s*executePayout,/);
});

// ── Live credential resolution ────────────────────────────────────────────────

test('Kora: getKoraSecretKey prefers KORA_LIVE_SECRET_KEY, falls back to legacy KORA_API_KEY', () => {
  const snap = snapshotEnv();
  try {
    delete process.env.KORA_LIVE_SECRET_KEY;
    delete process.env.KORA_API_KEY;
    assert.equal(getKoraSecretKey(), null);

    process.env.KORA_API_KEY = 'legacy-secret';
    assert.equal(getKoraSecretKey(), 'legacy-secret');

    process.env.KORA_LIVE_SECRET_KEY = 'sk_live_new';
    assert.equal(getKoraSecretKey(), 'sk_live_new', 'live key must take priority over legacy key');
  } finally {
    restoreEnv(snap);
  }
});

test('Kora: getKoraPublicKey / getKoraEncryptionKey read the new live env vars', () => {
  const snap = snapshotEnv();
  try {
    delete process.env.KORA_LIVE_PUBLIC_KEY;
    delete process.env.KORA_LIVE_ENCRYPTION_KEY;
    assert.equal(getKoraPublicKey(), null);
    assert.equal(getKoraEncryptionKey(), null);

    process.env.KORA_LIVE_PUBLIC_KEY = 'pk_live_abc';
    process.env.KORA_LIVE_ENCRYPTION_KEY = '12345678901234567890123456789012';
    assert.equal(getKoraPublicKey(), 'pk_live_abc');
    assert.equal(getKoraEncryptionKey(), '12345678901234567890123456789012');
  } finally {
    restoreEnv(snap);
  }
});

test('Kora: isPayoutProviderReady is region-scoped and honours both live and legacy keys', () => {
  const snap = snapshotEnv();
  try {
    delete process.env.KORA_LIVE_SECRET_KEY;
    delete process.env.KORA_API_KEY;
    assert.equal(isPayoutProviderReady('NG'), false);
    assert.equal(isPayoutProviderReady('US'), false); // no Stripe Connect env set in test

    process.env.KORA_LIVE_SECRET_KEY = 'sk_live_xyz';
    assert.equal(isPayoutProviderReady('NG'), true);
    assert.equal(isPayoutProviderReady('GH'), true);

    delete process.env.KORA_LIVE_SECRET_KEY;
    process.env.KORA_API_KEY = 'legacy-key';
    assert.equal(isPayoutProviderReady('KE'), true, 'legacy KORA_API_KEY must still satisfy readiness');
  } finally {
    restoreEnv(snap);
  }
});

// ── Optional payload encryption (AES-256-GCM per Kora spec) ──────────────────

test('Kora: encryptKoraPayload produces an iv:cipher:tag hex triplet decryptable back to the original payload', () => {
  const key = '12345678901234567890123456789012'; // 32 bytes
  const payload = {
    reference: 'egw-test-1',
    destination: { type: 'bank_account', amount: 1000, currency: 'NGN' },
  };
  const encoded = encryptKoraPayload(key, payload);
  const parts = encoded.split(':');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^[0-9a-f]{32}$/); // 16-byte IV, hex-encoded
  assert.match(parts[2], /^[0-9a-f]{32}$/); // 16-byte GCM auth tag, hex-encoded

  const decrypted = decryptKoraPayload(key, encoded);
  assert.deepEqual(JSON.parse(decrypted), payload);
});

test('Kora: encryptKoraPayload uses a fresh random IV every call — no ciphertext reuse', () => {
  const key = '12345678901234567890123456789012';
  const payload = { reference: 'egw-test-2' };
  const a = encryptKoraPayload(key, payload);
  const b = encryptKoraPayload(key, payload);
  assert.notEqual(a, b);
  assert.deepEqual(JSON.parse(decryptKoraPayload(key, a)), payload);
  assert.deepEqual(JSON.parse(decryptKoraPayload(key, b)), payload);
});

test('Kora: koraPayout sends plain payload when unset, encrypted_data when KORA_LIVE_ENCRYPTION_KEY is set', () => {
  assert.match(payoutSource, /requestBody\s*=\s*koraEncryptionKey\s*\n\s*\?\s*\{\s*encrypted_data:\s*encryptKoraPayload\(koraEncryptionKey,\s*payload\)\s*\}\s*\n\s*:\s*payload;/);
});

test('Kora: amount conversion to major units is unaffected by credential changes', () => {
  assert.equal(toKoraAmount(150000, 'NGN'), 1500);   // minor -> major
  assert.equal(toKoraAmount(1000, 'XAF'), 1000);      // zero-decimal passthrough
});

// ── Idempotency & retry safety ─────────────────────────────────────────────────

test('Kora: idempotency — deterministic reference and dispatch ref unchanged', () => {
  assert.match(payoutSource, /const reference = `egw-\$\{w\.id\}`;/);
  assert.match(payoutSource, /wAttempt\.payoutDispatchRef = `egw-\$\{withdrawalId\}`;/);
});

test('Kora: retry path queries provider status first and never blindly re-POSTs disburse', () => {
  const block = payoutSource.match(/if \(provider === 'kora'\) \{[\s\S]*?\n {6}\} else \{/);
  assert.ok(block, 'Kora pre-retry branch not found');
  assert.match(block[0], /getKoraSecretKey\(\)/);
  assert.match(block[0], /transactions\/\$\{dispatchRef\}/);
  assert.doesNotMatch(block[0], /attemptPayout\(2\)/, 'Kora retry must never re-invoke attemptPayout blindly');
});

test('Kora: error classification retains retryable/permanent split', () => {
  assert.match(payoutSource, /msg\.startsWith\('kora api error:'\)/);
  assert.match(payoutSource, /msg\.startsWith\('kora disbursement failed:'\)/);
  assert.match(payoutSource, /RETRYABLE_CODES/);
});

test('Kora: disbursement response logging stays PII-safe (no raw body.data)', () => {
  assert.match(payoutSource, /Log only safe scalar fields/);
});

// ── Startup guards (index.js) ─────────────────────────────────────────────────

test('index.js: Kora live-key production guards exist (mirrors Stripe test-key ban)', () => {
  assert.match(indexSource, /KORA_LIVE_SECRET_KEY \|\| ''\)\.startsWith\('sk_test_'\)/);
  assert.match(indexSource, /KORA_LIVE_PUBLIC_KEY \|\| ''\)\.startsWith\('pk_test_'\)/);
});

test('index.js: KORA_LIVE_ENCRYPTION_KEY must be exactly 32 bytes when set', () => {
  assert.match(indexSource, /KORA_LIVE_ENCRYPTION_KEY &&\s*\n\s*Buffer\.byteLength\(process\.env\.KORA_LIVE_ENCRYPTION_KEY, 'utf8'\) !== 32/);
});

// ── Webhook signature verification — Kora issues NO separate webhook secret ──
// Per https://developers.korapay.com/docs/webhooks, the signature is HMAC-SHA256
// of JSON.stringify(data) using the SAME Secret Key as API auth. There is no
// dashboard step that generates a distinct webhook secret, so KORA_WEBHOOK_SECRET
// must not exist anywhere in this integration — these tests guard against
// reintroducing that (incorrect) pattern.

test('index.js: no KORA_WEBHOOK_SECRET env var anywhere — Kora has no separate webhook secret', () => {
  assert.doesNotMatch(indexSource, /KORA_WEBHOOK_SECRET/);
});

test('.env.example: no KORA_WEBHOOK_SECRET assignment (Kora has no separate webhook secret to set)', () => {
  assert.doesNotMatch(envExampleSource, /^KORA_WEBHOOK_SECRET=/m);
});

test('README_RAILWAY.txt: documents that Kora webhooks are signed with the Secret Key, not a separate var', () => {
  const readmeSource = fs.readFileSync(path.join(__dirname, '..', 'README_RAILWAY.txt'), 'utf8');
  assert.doesNotMatch(readmeSource, /^\s*KORA_WEBHOOK_SECRET\s*(=|\()/m); // never declared as a var to set
  assert.match(readmeSource, /does not issue a separate webhook secret/);
});

test('index.js: Kora webhook route parses JSON then verifies via verifyKoraWebhookSignature(getKoraSecretKey())', () => {
  assert.match(indexSource, /app\.post\('\/webhooks\/kora'/);
  assert.match(indexSource, /express\.json\(\{ type: 'application\/json' \}\)/);
  assert.match(indexSource, /const koraSecretKey = getKoraSecretKey\(\);/);
  assert.match(indexSource, /verifyKoraWebhookSignature\(koraSecretKey, data, sig\)/);
  assert.match(indexSource, /x-korapay-signature/);
});

test('verifyKoraWebhookSignature: accepts a signature computed the way Kora documents (HMAC-SHA256 of JSON.stringify(data), signed with the Secret Key)', () => {
  const secretKey = 'sk_live_test_secret_1234567890';
  const data = { amount: 150.99, status: 'success', currency: 'NGN', reference: 'egw-abc123' };
  // Exactly Kora's own reference implementation from their docs.
  const koraSignature = crypto.createHmac('sha256', secretKey).update(JSON.stringify(data)).digest('hex');
  assert.equal(verifyKoraWebhookSignature(secretKey, data, koraSignature), true);
});

test('verifyKoraWebhookSignature: rejects a tampered payload, wrong key, or missing signature', () => {
  const secretKey = 'sk_live_test_secret_1234567890';
  const data = { amount: 150.99, status: 'success', reference: 'egw-abc123' };
  const validSig = crypto.createHmac('sha256', secretKey).update(JSON.stringify(data)).digest('hex');

  assert.equal(verifyKoraWebhookSignature(secretKey, { ...data, amount: 999 }, validSig), false, 'tampered data must fail');
  assert.equal(verifyKoraWebhookSignature('sk_live_wrong_key', data, validSig), false, 'wrong secret key must fail');
  assert.equal(verifyKoraWebhookSignature(secretKey, data, undefined), false, 'missing signature must fail');
  assert.equal(verifyKoraWebhookSignature(null, data, validSig), false, 'missing secret key must fail');
  assert.equal(verifyKoraWebhookSignature(secretKey, data, 'not-valid-hex'), false, 'malformed signature must not throw');
});

// ── Stripe stays the production deposit provider ─────────────────────────────

test('Stripe: deposit endpoints untouched by Kora credential changes', () => {
  assert.match(indexSource, /app\.post\('\/deposits\/create-intent'/);
  assert.match(indexSource, /app\.post\('\/deposits\/confirm'/);
  assert.match(indexSource, /sk_test_/); // Stripe test-key production guard still present
});

// ── Admin reconcile path ──────────────────────────────────────────────────────

test('adminWithdrawals reconcile uses the shared getKoraSecretKey() helper (no duplicated key logic)', () => {
  assert.match(adminWithdrawalsSource, /require\('\.\/payoutProviders'\)/);
  assert.match(adminWithdrawalsSource, /const KORA_API_KEY\s*=\s*getKoraSecretKey\(\);/);
});

// ── Documentation ─────────────────────────────────────────────────────────────

test('.env.example documents the three Kora live credentials and explains the webhook signing model', () => {
  assert.match(envExampleSource, /KORA_LIVE_PUBLIC_KEY=/);
  assert.match(envExampleSource, /KORA_LIVE_SECRET_KEY=/);
  assert.match(envExampleSource, /KORA_LIVE_ENCRYPTION_KEY=/);
  assert.match(envExampleSource, /does NOT issue a separate webhook-signing secret/);
});
