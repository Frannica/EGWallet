'use strict';

/**
 * Full Kora-country-coverage tests.
 *
 * Extends the Cameroon/XAF-specific work (kora-cameroon-xaf.test.js) to cover
 * EVERY country Kora currently supports for this account, and — just as
 * importantly — proves that countries which merely SHARE A CURRENCY with a
 * real Kora corridor (the XAF/XOF CFA-franc zones in particular) do NOT get
 * routed to Kora, and fail safely instead of silently falling through to
 * Stripe.
 *
 * Source of truth (see the long comment above KORA_COUNTRIES in
 * backend/payoutProviders.js for full citations):
 *   https://developers.korapay.com/docs/send-payments
 *   https://developers.korapay.com/docs/payout-via-api
 *   https://developers.korapay.com/docs/payout-utilities
 *   Live account probe: backend/scripts/kora-cm-mobile-money-probe.js
 *     (2026-07-22 — confirms CM mobile-money is live-active for this account,
 *      and that /misc/* utility endpoints require the PUBLIC key, not the
 *      secret key — a real bug this test suite locks in the fix for).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const payoutProviders = require('../payoutProviders');
const {
  payoutRouter,
  isPayoutProviderReady,
  normalizeCountryToISO2,
  resolveWithdrawalCountry,
  isKoraBankAccountSupported,
  isKoraMobileMoneySupported,
  isKoraBankAccountCountry,
  isKoraBankResolutionSupported,
  isKoraMobileResolutionSupported,
  KORA_COUNTRIES,
  KORA_CURRENCY_TO_COUNTRY,
  listKoraBanks,
  listKoraMobileMoneyOperators,
} = payoutProviders;
const { getKoraSecretKey, getKoraPublicKey } = payoutProviders._test;
const { KORA_UNSUPPORTED_COUNTRIES } = payoutProviders._test;

const axios = require('axios');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');
const sendScreenSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'screens', 'SendScreen.tsx'),
  'utf8'
);

function snapshotEnv() {
  return {
    KORA_LIVE_SECRET_KEY: process.env.KORA_LIVE_SECRET_KEY,
    KORA_LIVE_PUBLIC_KEY: process.env.KORA_LIVE_PUBLIC_KEY,
    STRIPE_CONNECT_READY: process.env.STRIPE_CONNECT_READY,
    STRIPE_CONNECT_ACCOUNT: process.env.STRIPE_CONNECT_ACCOUNT,
  };
}
function restoreEnv(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function withMockedAxios(mockGet, mockPost, fn) {
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = mockGet || originalGet;
  axios.post = mockPost || originalPost;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      axios.get = originalGet;
      axios.post = originalPost;
    });
}

// ─── 1. Exact supported-country list ──────────────────────────────────────

test('KORA_COUNTRIES is exactly the 8 confirmed Kora corridors', () => {
  const expected = ['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ'];
  assert.deepEqual([...KORA_COUNTRIES].sort(), expected.sort());
});

test('Equatorial Guinea (GQ) is NOT a Kora corridor, despite sharing XAF with Cameroon', () => {
  assert.equal(KORA_COUNTRIES.has('GQ'), false);
  assert.equal(KORA_UNSUPPORTED_COUNTRIES.has('GQ'), true);
});

// ─── 2. payoutRouter: every real Kora country routes to 'kora' ───────────

test('payoutRouter routes every confirmed Kora country to "kora"', () => {
  for (const c of ['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ']) {
    assert.equal(payoutRouter(c), 'kora', `${c} should route to kora`);
  }
  // Case-insensitive / whitespace-tolerant
  assert.equal(payoutRouter(' cm '), 'kora');
  assert.equal(payoutRouter('gh'), 'kora');
});

test('payoutRouter fails safely (null) for CFA-zone / broader-African countries Kora does NOT support', () => {
  // XAF zone (everyone except Cameroon)
  for (const c of ['GQ', 'CF', 'TD', 'CG', 'GA']) {
    assert.equal(payoutRouter(c), null, `${c} (XAF zone, non-Cameroon) must not route anywhere`);
  }
  // XOF zone (everyone except Ivory Coast)
  for (const c of ['SN', 'BJ', 'BF', 'GW', 'ML', 'NE', 'TG']) {
    assert.equal(payoutRouter(c), null, `${c} (XOF zone, non-Ivory-Coast) must not route anywhere`);
  }
  // Other African countries with no documented Kora corridor
  for (const c of ['UG', 'RW', 'ET', 'ZM', 'ZW', 'MA', 'DZ', 'SO']) {
    assert.equal(payoutRouter(c), null, `${c} must not route anywhere`);
  }
});

test('payoutRouter NEVER falls through to "stripe" for a Kora-unsupported African country', () => {
  for (const c of KORA_UNSUPPORTED_COUNTRIES) {
    assert.notEqual(payoutRouter(c), 'stripe', `${c} must not silently become a Stripe withdrawal`);
  }
});

test('payoutRouter unchanged for rest-of-world / unknown countries (regression)', () => {
  assert.equal(payoutRouter('US'), 'stripe');
  assert.equal(payoutRouter('FR'), 'stripe');
  assert.equal(payoutRouter('GB'), 'stripe');
  assert.equal(payoutRouter(''), 'stripe');
  assert.equal(payoutRouter(null), 'stripe');
  assert.equal(payoutRouter(undefined), 'stripe');
});

// ─── 3. isPayoutProviderReady: null-provider countries are never "ready" ──

test('isPayoutProviderReady returns false for unsupported countries even when Kora AND Stripe are both configured', () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  process.env.STRIPE_CONNECT_READY = '1';
  process.env.STRIPE_CONNECT_ACCOUNT = 'acct_test';
  try {
    assert.equal(isPayoutProviderReady('GQ'), false, 'Equatorial Guinea must never be reported as ready');
    assert.equal(isPayoutProviderReady('SN'), false);
    assert.equal(isPayoutProviderReady('CF'), false);
  } finally {
    restoreEnv(snap);
  }
});

test('isPayoutProviderReady is true for a real Kora country when the secret key is configured', () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    for (const c of ['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ']) {
      assert.equal(isPayoutProviderReady(c), true, `${c} should be ready with a secret key configured`);
    }
  } finally {
    restoreEnv(snap);
  }
});

// ─── 4. resolveWithdrawalCountry: per-currency safe defaults ──────────────

test('resolveWithdrawalCountry: unambiguous Kora currencies resolve to their single confirmed country', () => {
  const cases = { NGN: 'NG', KES: 'KE', ZAR: 'ZA', GHS: 'GH', EGP: 'EG', TZS: 'TZ' };
  for (const [ccy, expected] of Object.entries(cases)) {
    assert.equal(
      resolveWithdrawalCountry({ country: null, userRegion: null, currency: ccy }),
      expected,
      `${ccy} should default to ${expected}`
    );
  }
  assert.deepEqual(KORA_CURRENCY_TO_COUNTRY.NGN, 'NG');
});

test('resolveWithdrawalCountry: XAF/XOF currency-only fallback still defaults to CM/CI (documented, unchanged)', () => {
  assert.equal(resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'XAF' }), 'CM');
  assert.equal(resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'XOF' }), 'CI');
});

test('resolveWithdrawalCountry: a real user region OVERRIDES the XAF currency default — Equatorial Guinea stays Equatorial Guinea', () => {
  // This is the critical safety fix: an XAF-wallet user whose signup region is
  // GQ (Equatorial Guinea) must resolve to GQ — NOT be silently assumed to be
  // in Cameroon just because they share a currency.
  assert.equal(
    resolveWithdrawalCountry({ country: null, userRegion: 'GQ', currency: 'XAF' }),
    'GQ'
  );
  assert.equal(payoutRouter('GQ'), null, 'and GQ correctly has no payout provider');
});

test('resolveWithdrawalCountry: a real Cameroon user region also resolves correctly', () => {
  assert.equal(
    resolveWithdrawalCountry({ country: null, userRegion: 'CM', currency: 'XAF' }),
    'CM'
  );
});

test('resolveWithdrawalCountry: explicit country always wins over region/currency', () => {
  assert.equal(
    resolveWithdrawalCountry({ country: 'ke', userRegion: 'GQ', currency: 'XAF' }),
    'KE'
  );
});

test('resolveWithdrawalCountry: unresolvable currency + no region/country returns null (never guesses)', () => {
  assert.equal(resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'USD' }), null);
  assert.equal(resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'EUR' }), null);
});

// ─── 5. Per-country method support (bank vs mobile-money) ────────────────

test('isKoraBankAccountCountry: only NG, KE, ZA — never CM/GH/CI/EG/TZ (mobile-money-only corridors)', () => {
  assert.equal(isKoraBankAccountCountry('NG'), true);
  assert.equal(isKoraBankAccountCountry('KE'), true);
  assert.equal(isKoraBankAccountCountry('ZA'), true);
  for (const c of ['GH', 'CI', 'CM', 'EG', 'TZ']) {
    assert.equal(isKoraBankAccountCountry(c), false, `${c} has no Kora bank_account corridor`);
  }
});

test('Every Kora country supports at least one of bank_account / mobile_money (no silently-unusable corridor)', () => {
  const currencyByCountry = { NG: 'NGN', KE: 'KES', ZA: 'ZAR', GH: 'GHS', CI: 'XOF', CM: 'XAF', EG: 'EGP', TZ: 'TZS' };
  for (const [country, ccy] of Object.entries(currencyByCountry)) {
    const hasBank = isKoraBankAccountSupported(ccy);
    const hasMobile = isKoraMobileMoneySupported(ccy);
    assert.ok(hasBank || hasMobile, `${country} (${ccy}) must support at least one payout method`);
  }
});

// ─── 6. USD/GBP: real Kora corridor, deliberately not implemented here ────

test('USD/GBP intentionally NOT routed to Kora — the full bank_account payload (address, beneficiary_type, docs) is not implemented', () => {
  assert.equal(payoutRouter('US'), 'stripe');
  assert.equal(payoutRouter('GB'), 'stripe');
  assert.equal(isKoraBankAccountSupported('USD'), false);
  assert.equal(isKoraBankAccountSupported('GBP'), false);
});

// ─── 7. Beneficiary-resolution support matrix ─────────────────────────────

test('Bank-account resolution is documented ONLY for Nigeria and Kenya', () => {
  assert.equal(isKoraBankResolutionSupported('NG'), true);
  assert.equal(isKoraBankResolutionSupported('KE'), true);
  assert.equal(isKoraBankResolutionSupported('ZA'), false, 'ZAR requires manual account_name per Kora docs');
});

test('Mobile-money resolution is documented ONLY for Ghana (numeric operator codes)', () => {
  assert.equal(isKoraMobileResolutionSupported('GH'), true);
  for (const c of ['CM', 'CI', 'KE', 'EG', 'TZ']) {
    assert.equal(isKoraMobileResolutionSupported(c), false, `${c} mobile-money resolution is not documented/confirmed`);
  }
});

// ─── 8. koraMiscRequest auth fix: /misc/* uses the PUBLIC key, not secret ──
// Confirmed live: secret key gets 401 "Invalid authentication token" on every
// /misc/* endpoint; the public key succeeds. See kora-cm-mobile-money-probe.js.

test('listKoraBanks: authenticates with the PUBLIC key when configured', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_should_not_be_used_here';
  process.env.KORA_LIVE_PUBLIC_KEY = 'pk_live_correct_key';
  let capturedConfig;
  try {
    await withMockedAxios(
      async (url, config) => {
        capturedConfig = config;
        return { data: { status: true, message: 'ok', data: [] } };
      },
      null,
      async () => {
        await listKoraBanks('NG');
        assert.equal(capturedConfig.headers.Authorization, 'Bearer pk_live_correct_key');
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('listKoraMobileMoneyOperators: authenticates with the PUBLIC key when configured', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_should_not_be_used_here';
  process.env.KORA_LIVE_PUBLIC_KEY = 'pk_live_correct_key';
  let capturedConfig;
  try {
    await withMockedAxios(
      async (url, config) => {
        capturedConfig = config;
        return { data: { status: true, message: 'ok', data: [] } };
      },
      null,
      async () => {
        await listKoraMobileMoneyOperators('CM');
        assert.equal(capturedConfig.headers.Authorization, 'Bearer pk_live_correct_key');
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('koraMiscRequest falls back to the secret key only when no public key is configured (legacy safety net)', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_fallback_test';
  delete process.env.KORA_LIVE_PUBLIC_KEY;
  let capturedConfig;
  try {
    await withMockedAxios(
      async (url, config) => {
        capturedConfig = config;
        return { data: { status: true, message: 'ok', data: [] } };
      },
      null,
      async () => {
        await listKoraBanks('NG');
        assert.equal(capturedConfig.headers.Authorization, 'Bearer sk_live_fallback_test');
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

// ─── 9. koraPayout: corridor guards hold for every non-Cameroon country too ─

function makeWithdrawal(overrides = {}) {
  return {
    id: 'wd-all-1',
    userId: 'user-all-1',
    method: 'bank',
    currency: 'NGN',
    country: 'NG',
    netPayout: 10000,
    accountNumber: 'enc:2158634852',
    accountHolderName: 'enc:Jane Doe',
    bankName: 'enc:GTBank',
    bankCode: '058',
    ...overrides,
  };
}

test('koraPayout: rejects bank withdrawal for a mobile-money-only country currency (GHS)', async () => {
  const { koraPayout } = payoutProviders._test;
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    await assert.rejects(
      koraPayout(makeWithdrawal({ currency: 'GHS', country: 'GH', method: 'bank' }), { info(){}, warn(){}, error(){} }),
      (err) => {
        assert.equal(err._definitiveRejection, true);
        return true;
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('koraPayout: rejects mobile-money withdrawal for a bank-only country currency (ZAR)', async () => {
  const { koraPayout } = payoutProviders._test;
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    await assert.rejects(
      koraPayout(makeWithdrawal({ currency: 'ZAR', country: 'ZA', method: 'mobile', bankCode: 'some-operator' }), { info(){}, warn(){}, error(){} }),
      (err) => {
        assert.equal(err._definitiveRejection, true);
        return true;
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

// ─── 10. executePayout: unsupported-country guard (balance safety) ────────

test('executePayout: has an explicit early-return guard for a null (unsupported) provider before any dispatch/demo-mode logic', () => {
  assert.match(
    payoutSource,
    /const provider = payoutRouter\(w\.country\);[\s\S]{0,800}if \(!provider\) \{[\s\S]{0,800}markWithdrawalFailed\(dbNoProvider, withdrawalId,/,
    'executePayout must mark an unsupported-country withdrawal failed (refund-safe) rather than defaulting into the Kora branch'
  );
});

// ─── 11. index.js wiring: unsupported-country fails safely, not via Stripe ─

test('index.js: POST /withdrawals returns a distinct 400 COUNTRY_NOT_SUPPORTED for payoutRouter()===null, before the generic provider-not-ready 503', () => {
  const withdrawalsHandlerStart = indexSource.indexOf("app.post('/withdrawals'");
  assert.ok(withdrawalsHandlerStart > -1, 'POST /withdrawals handler not found');
  const nullCheckIdx = indexSource.indexOf('payoutRouter(resolvedCountry) === null', withdrawalsHandlerStart);
  const readyCheckIdx = indexSource.indexOf('isPayoutProviderReady(resolvedCountry', withdrawalsHandlerStart);
  assert.ok(nullCheckIdx > -1, 'unsupported-country guard not found');
  assert.ok(readyCheckIdx > -1, 'provider-ready guard not found');
  assert.ok(nullCheckIdx < readyCheckIdx, 'unsupported-country guard must run BEFORE the generic provider-ready guard');
  const block = indexSource.slice(nullCheckIdx, nullCheckIdx + 400);
  assert.match(block, /COUNTRY_NOT_SUPPORTED/);
  assert.match(block, /status\(400\)/);
});

test('index.js: POST /withdrawals returns a clear 400 COUNTRY_NOT_SUPPORTED (not a generic 503) for US/UK/Europe when Stripe Connect is not configured', () => {
  // Requirement: never claim US/UK/Europe withdrawals "work" and never return
  // a misleading generic provider error implying a fixable/transient outage.
  // payoutRouter() defaults any country outside the 8 Kora corridors and the
  // explicit KORA_UNSUPPORTED_COUNTRIES list to 'stripe' — but Stripe Connect
  // payouts are not wired up for ANY corridor in this deployment
  // (STRIPE_CONNECT_READY / STRIPE_CONNECT_ACCOUNT). That combination must
  // surface as an honest "not supported yet" message, not "temporarily
  // unavailable, contact support" (which implies a config bug, not a missing
  // feature).
  const withdrawalsHandlerStart = indexSource.indexOf("app.post('/withdrawals'");
  assert.ok(withdrawalsHandlerStart > -1, 'POST /withdrawals handler not found');
  const readyCheckIdx = indexSource.indexOf('isPayoutProviderReady(resolvedCountry', withdrawalsHandlerStart);
  assert.ok(readyCheckIdx > -1, 'provider-ready guard not found');
  const block = indexSource.slice(readyCheckIdx, readyCheckIdx + 1600);
  assert.match(block, /unreadyProvider === 'stripe'/, 'must branch on the unready provider being the stripe fallback');
  assert.match(block, /status\(400\)/, 'stripe-fallback unready countries must be a 400, not a 503');
  assert.match(block, /COUNTRY_NOT_SUPPORTED/, 'must use the same distinct errorCode as the explicit unsupported-country guard');
  assert.match(block, /not available yet/i, 'message must say the corridor is not supported yet, not that it is a temporary outage');
});

test('index.js: GET /payout/banks rejects countries with no Kora bank_account corridor', () => {
  assert.match(indexSource, /app\.get\('\/payout\/banks'[\s\S]{0,400}isKoraBankAccountCountry\(country\)/);
});

test('index.js: GET /payout/mobile-money-operators rejects countries with no Kora corridor at all', () => {
  assert.match(indexSource, /app\.get\('\/payout\/mobile-money-operators'[\s\S]{0,400}payoutRouter\(country\) !== 'kora'/);
});

test('index.js: POST /payout/resolve-account fast-fails with resolutionSupported:false for undocumented corridors (never fabricates a name)', () => {
  assert.match(indexSource, /resolutionSupported\s*:\s*false/);
  assert.match(indexSource, /isKoraMobileResolutionSupported\(resolutionCountry\)/);
  assert.match(indexSource, /isKoraBankResolutionSupported\(resolutionCountry\)/);
});

// ─── 12. SendScreen.tsx wiring: generalized to all Kora countries ─────────

test('SendScreen.tsx: currency→country maps cover all 8 Kora corridors (mobile + bank)', () => {
  assert.match(sendScreenSource, /KORA_MOBILE_COUNTRY_BY_CURRENCY[\s\S]{0,200}KES:\s*'KE'[\s\S]{0,50}GHS:\s*'GH'[\s\S]{0,50}XOF:\s*'CI'[\s\S]{0,50}XAF:\s*'CM'[\s\S]{0,50}EGP:\s*'EG'[\s\S]{0,50}TZS:\s*'TZ'/);
  assert.match(sendScreenSource, /KORA_BANK_COUNTRY_BY_CURRENCY[\s\S]{0,200}NGN:\s*'NG'[\s\S]{0,50}KES:\s*'KE'[\s\S]{0,50}ZAR:\s*'ZA'/);
});

test('SendScreen.tsx: never forces country=CM/CI for XAF/XOF — relies on backend region resolution to protect Equatorial Guinea users', () => {
  assert.doesNotMatch(sendScreenSource, /country:\s*'CM'/);
  assert.doesNotMatch(sendScreenSource, /country:\s*'CI'/);
  assert.match(sendScreenSource, /currency !== 'XAF' && currency !== 'XOF'/);
});

test('SendScreen.tsx: generalized bank picker exists and is wired to /payout/banks', () => {
  assert.match(sendScreenSource, /isKoraBankWithdrawal/);
  assert.match(sendScreenSource, /showBankPicker/);
  assert.match(sendScreenSource, /\/payout\/banks\?country=\$\{koraBankCountryForCurrency\}/);
  assert.match(sendScreenSource, /bankPickerModal/);
});

test('SendScreen.tsx: generalized mobile-money picker no longer hardcoded to Cameroon', () => {
  assert.match(sendScreenSource, /isKoraMobileMoneyWithdrawal/);
  assert.match(sendScreenSource, /\/payout\/mobile-money-operators\?country=\$\{koraMobileCountryForCurrency\}/);
});

test('SendScreen.tsx: bank method is disabled only for currencies where Kora is mobile-money-only', () => {
  assert.match(sendScreenSource, /koraBankUnavailableForCurrency = activeTab === 'withdraw' && !!koraMobileCountryForCurrency && !koraBankCountryForCurrency/);
});

// ─── 13. Regression: existing Stripe / Cameroon behavior untouched ────────

test('Regression: stripePayout and executePayout entry points still exported unchanged', () => {
  assert.equal(typeof payoutProviders.executePayout, 'function');
  assert.equal(typeof payoutProviders.payoutRouter, 'function');
  assert.equal(typeof payoutProviders.isPayoutProviderReady, 'function');
});

test('Regression: Cameroon/XAF mobile-money corridor from the prior mission is unchanged', () => {
  assert.equal(payoutRouter('CM'), 'kora');
  assert.equal(isKoraMobileMoneySupported('XAF'), true);
  assert.equal(isKoraBankAccountSupported('XAF'), false);
});

test('Regression: new exports are present on module.exports (not just _test)', () => {
  for (const name of [
    'isKoraBankAccountCountry', 'isKoraBankResolutionSupported', 'isKoraMobileResolutionSupported',
    'KORA_COUNTRIES', 'KORA_CURRENCY_TO_COUNTRY',
  ]) {
    assert.ok(name in payoutProviders, `${name} should be exported`);
  }
});
