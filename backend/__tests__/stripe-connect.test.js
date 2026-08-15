'use strict';

/**
 * Stripe Connect withdrawal-corridor tests.
 *
 * Proves that Stripe Connect stays fully inert unless BOTH
 * STRIPE_CONNECT_ENABLED=true AND the country is explicitly listed in
 * STRIPE_CONNECT_APPROVED_COUNTRIES — see the compliance note atop
 * backend/stripeConnect.js for why this two-flag gate exists (Stripe's own
 * Restricted/Prohibited Businesses policy covers EGWallet's stored-value P2P
 * wallet model; this must stay off until Stripe explicitly approves it) —
 * AND that every country without an explicit, verified corridor (Kora or
 * Stripe Connect) gets payoutRouter() === null / COUNTRY_NOT_SUPPORTED, with
 * NO legacy single-account Stripe fallback for the US, UK, or EU.
 *
 * A fake (non-network) STRIPE_SECRET_KEY is set before requiring any module
 * so `stripeClient` is truthy in this worker process — required because the
 * Stripe Node SDK constructor does not make a network call, so this is safe
 * for pure routing/config-gating unit tests. No real Stripe API calls are
 * made anywhere in this file.
 */
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_for_unit_tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stripeConnect = require('../stripeConnect');
const payoutProviders = require('../payoutProviders');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function snapshotEnv() {
  return {
    STRIPE_CONNECT_ENABLED: process.env.STRIPE_CONNECT_ENABLED,
    STRIPE_CONNECT_APPROVED_COUNTRIES: process.env.STRIPE_CONNECT_APPROVED_COUNTRIES,
    STRIPE_CONNECT_WEBHOOK_SECRET: process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  };
}
function restoreEnv(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── Fail-safe default (flag unset — today's production state) ──────────────

test('Stripe Connect OFF by default: US/GB/EU withdrawals return null (COUNTRY_NOT_SUPPORTED), never legacy stripe', () => {
  const snap = snapshotEnv();
  delete process.env.STRIPE_CONNECT_ENABLED;
  delete process.env.STRIPE_CONNECT_APPROVED_COUNTRIES;
  try {
    assert.equal(payoutProviders.payoutRouter('US'), null);
    assert.equal(payoutProviders.payoutRouter('GB'), null);
    assert.equal(payoutProviders.payoutRouter('DE'), null);
    assert.equal(payoutProviders.payoutRouter('FR'), null);
    assert.equal(payoutProviders.isPayoutProviderReady('US'), false);
    assert.equal(stripeConnect.isStripeConnectEnabled(), false);
  } finally {
    restoreEnv(snap);
  }
});

test('Enabling the flag alone activates nothing — an explicit per-country allow-list is also required', () => {
  const snap = snapshotEnv();
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  delete process.env.STRIPE_CONNECT_APPROVED_COUNTRIES;
  try {
    assert.equal(payoutProviders.payoutRouter('US'), null); // no countries approved yet — never falls back to legacy stripe
    assert.equal(stripeConnect.isCountryStripeConnectApproved('US'), false);
    assert.deepEqual(Array.from(stripeConnect.getApprovedCountries()), []);
  } finally {
    restoreEnv(snap);
  }
});

// ─── Enabled + explicitly approved corridor ──────────────────────────────────

test('Routes to stripe_connect only for countries in the explicit allow-list, case/whitespace-insensitive', () => {
  const snap = snapshotEnv();
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_APPROVED_COUNTRIES = 'US, gb , De';
  try {
    assert.equal(payoutProviders.payoutRouter('US'), 'stripe_connect');
    assert.equal(payoutProviders.payoutRouter('GB'), 'stripe_connect');
    assert.equal(payoutProviders.payoutRouter('DE'), 'stripe_connect');
    assert.equal(payoutProviders.payoutRouter('FR'), null); // not in the list — COUNTRY_NOT_SUPPORTED, not legacy stripe
    assert.equal(payoutProviders.isPayoutProviderReady('US'), true);
    assert.deepEqual(Array.from(stripeConnect.getApprovedCountries()).sort(), ['DE', 'GB', 'US']);
  } finally {
    restoreEnv(snap);
  }
});

test('payoutRouter never returns the legacy single-account "stripe" value for any input', () => {
  const snap = snapshotEnv();
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_APPROVED_COUNTRIES = 'US,GB,DE,FR';
  try {
    for (const country of ['US', 'GB', 'DE', 'FR', 'JP', 'BR', 'IN', 'AU', 'CA', 'GQ', '', null, undefined, 'NG', 'KE']) {
      assert.notEqual(payoutProviders.payoutRouter(country), 'stripe');
    }
  } finally {
    restoreEnv(snap);
  }
});

test('Kora-confirmed corridors always take priority over Stripe Connect, even if misconfigured to overlap', () => {
  const snap = snapshotEnv();
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_APPROVED_COUNTRIES = 'NG,KE'; // deliberately overlapping with Kora
  try {
    assert.equal(payoutProviders.payoutRouter('NG'), 'kora');
    assert.equal(payoutProviders.payoutRouter('KE'), 'kora');
  } finally {
    restoreEnv(snap);
  }
});

test('Equatorial Guinea (GQ) and other no-corridor countries never route to Stripe Connect or Stripe', () => {
  const snap = snapshotEnv();
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_APPROVED_COUNTRIES = ''; // GQ never explicitly approved
  try {
    assert.equal(payoutProviders.payoutRouter('GQ'), null);
    assert.equal(payoutProviders.isPayoutProviderReady('GQ'), false);
  } finally {
    restoreEnv(snap);
  }
});

test('Missing/empty/unresolvable country returns null, never the legacy stripe default', () => {
  const snap = snapshotEnv();
  delete process.env.STRIPE_CONNECT_ENABLED;
  delete process.env.STRIPE_CONNECT_APPROVED_COUNTRIES;
  try {
    assert.equal(payoutProviders.payoutRouter(null), null);
    assert.equal(payoutProviders.payoutRouter(undefined), null);
    assert.equal(payoutProviders.payoutRouter(''), null);
    assert.equal(payoutProviders.isPayoutProviderReady(''), false);
  } finally {
    restoreEnv(snap);
  }
});

// ─── Onboarding-status derivation ────────────────────────────────────────────

test('deriveOnboardingStatus classifies every Stripe account state correctly', () => {
  const { deriveOnboardingStatus } = stripeConnect;
  assert.equal(deriveOnboardingStatus(null), 'not_started');
  assert.equal(
    deriveOnboardingStatus({ charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: {} }),
    'onboarding'
  );
  assert.equal(
    deriveOnboardingStatus({ charges_enabled: false, payouts_enabled: false, details_submitted: true, requirements: {} }),
    'pending_verification'
  );
  assert.equal(
    deriveOnboardingStatus({ charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: {} }),
    'complete'
  );
  assert.equal(
    deriveOnboardingStatus({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { disabled_reason: 'requirements.past_due' },
    }),
    'restricted'
  );
});

// ─── Onboarding entry point safety ───────────────────────────────────────────

test('ensureConnectOnboardingLink rejects with STRIPE_CONNECT_DISABLED when the flag is off', async () => {
  const snap = snapshotEnv();
  delete process.env.STRIPE_CONNECT_ENABLED;
  try {
    await assert.rejects(
      () => stripeConnect.ensureConnectOnboardingLink({
        userId: 'u1', email: 'a@b.com', country: 'US', refreshUrl: 'https://x', returnUrl: 'https://x',
      }),
      (err) => err.errorCode === 'STRIPE_CONNECT_DISABLED'
    );
  } finally {
    restoreEnv(snap);
  }
});

test('ensureConnectOnboardingLink rejects unapproved countries even when the flag is on', async () => {
  const snap = snapshotEnv();
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_APPROVED_COUNTRIES = 'US';
  try {
    await assert.rejects(
      () => stripeConnect.ensureConnectOnboardingLink({
        userId: 'u1', email: 'a@b.com', country: 'FR', refreshUrl: 'https://x', returnUrl: 'https://x',
      }),
      (err) => err.errorCode === 'COUNTRY_NOT_SUPPORTED'
    );
  } finally {
    restoreEnv(snap);
  }
});

// ─── Payout money-safety guard (no DB/HTTP reached while disabled) ───────────

test('stripeConnectPayout rejects with a definitive (safe-to-refund) error when disabled, before any DB/HTTP call', async () => {
  const snap = snapshotEnv();
  delete process.env.STRIPE_CONNECT_ENABLED;
  try {
    const fakeLogger = { info() {}, warn() {}, error() {} };
    await assert.rejects(
      () => stripeConnect.stripeConnectPayout(
        { id: 'w1', userId: 'u1', currency: 'USD', netPayout: 1000 },
        fakeLogger
      ),
      (err) => err._definitiveRejection === true
    );
  } finally {
    restoreEnv(snap);
  }
});

// ─── Webhook signature verification ──────────────────────────────────────────

test('constructConnectWebhookEvent throws a clear, actionable error when STRIPE_CONNECT_WEBHOOK_SECRET is missing', () => {
  const snap = snapshotEnv();
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  try {
    assert.throws(
      () => stripeConnect.constructConnectWebhookEvent(Buffer.from('{}'), 'sig'),
      /STRIPE_CONNECT_WEBHOOK_SECRET/
    );
  } finally {
    restoreEnv(snap);
  }
});

// ─── Source-level wiring checks (routes, webhook registration, /health) ─────

test('POST /webhooks/stripe-connect is registered with express.raw (raw-body signature verification)', () => {
  const block = indexSource.match(/app\.post\('\/webhooks\/stripe-connect'[\s\S]{0,200}/);
  assert.ok(block, 'webhook route not found');
  assert.match(block[0], /express\.raw\(\{ type: 'application\/json' \}\)/);
});

test('POST /webhooks/stripe-connect is registered before the global express.json() body parser', () => {
  const webhookIdx = indexSource.indexOf("app.post('/webhooks/stripe-connect'");
  // Anchored to the start of a line so this only matches the real
  // app.use(express.json(...)) statement, not the explanatory comment a few
  // lines above the webhook routes that also contains this substring
  // ("MUST be registered BEFORE app.use(express.json(...))...").
  const globalJsonMatch = indexSource.match(/^app\.use\(express\.json\(/m);
  assert.ok(webhookIdx > -1, 'webhook route not found');
  assert.ok(globalJsonMatch, 'global express.json() body parser not found');
  assert.ok(webhookIdx < globalJsonMatch.index, 'webhook route must be registered before the global JSON parser');
});

test('Stripe Connect onboarding routes exist and require authMiddleware', () => {
  for (const route of ['/stripe-connect/onboard', '/stripe-connect/status', '/stripe-connect/refresh-link', '/stripe-connect/sync']) {
    const escaped = route.replace(/\//g, '\\/');
    const re = new RegExp(`app\\.(get|post)\\('${escaped}',\\s*authMiddleware`);
    assert.match(indexSource, re, `${route} missing or not authenticated`);
  }
});

test('/health surfaces Stripe Connect readiness as booleans only (no keys, no account IDs, no country list)', () => {
  const block = indexSource.match(/app\.get\('\/health'[\s\S]*?res\.status\(200\)\.json\(healthStatus\);/);
  assert.ok(block);
  assert.match(block[0], /stripeConnectEnabled:\s*isStripeConnectEnabled\(\)/);
  assert.match(block[0], /stripeConnectWebhookConfigured:\s*!!process\.env\.STRIPE_CONNECT_WEBHOOK_SECRET/);
  assert.doesNotMatch(block[0], /STRIPE_CONNECT_APPROVED_COUNTRIES/);
});

test('executePayout routes stripe_connect withdrawals to stripeConnectPayout', () => {
  const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');
  assert.match(payoutSource, /dispatchToProvider\(provider, wSnapshot, logger\)/);
  assert.match(payoutSource, /provider === 'stripe_connect'[\s\S]{0,80}stripeConnectPayout\(w, logger\)/);
});
