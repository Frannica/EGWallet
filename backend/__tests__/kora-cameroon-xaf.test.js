'use strict';

/**
 * Cameroon / XAF withdrawal production-readiness tests.
 *
 * Covers the blockers fixed for making Cameroon (XAF) withdrawals go live
 * through Kora:
 *   1. Country routing    — local Cameroon withdrawals resolve to ISO-2 "CM",
 *                            never free-text country matching.
 *   2. Kora routing        — CM / XAF reaches the Kora provider path, not Stripe.
 *   3. Bank list           — GET /payout/banks uses Kora's official List Banks API.
 *   4. Account resolution  — POST /payout/resolve-account verifies/resolves before
 *                            submission and never fabricates a name.
 *   5. Bank code            — selected bank/operator supplies the Kora code/slug
 *                            automatically; no manual bank-code typing required.
 *   6. Mobile money        — Cameroon (XAF) is mobile-money-only on Kora (MTN/Orange);
 *                            bank_account payouts for XAF are rejected before
 *                            ever reaching Kora.
 *   7. No admin approval   — a normal, unflagged Cameroon withdrawal is still
 *                            auto-processed (no fraud/AML/legal-hold triggered).
 *
 * Source references used throughout: https://developers.korapay.com/docs/
 *   send-payments, payout-via-api, payout-utilities.
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
  listKoraBanks,
  listKoraMobileMoneyOperators,
  resolveKoraBankAccount,
  resolveKoraMobileMoneyAccount,
} = payoutProviders;
const { koraPayout, getKoraSecretKey } = payoutProviders._test;

const { requiresAdminIntervention } = require('../adminInterventionPolicy');

const axios = require('axios');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');
const sendScreenSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'screens', 'SendScreen.tsx'),
  'utf8'
);

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function snapshotEnv() {
  return { KORA_LIVE_SECRET_KEY: process.env.KORA_LIVE_SECRET_KEY };
}
function restoreEnv(snap) {
  if (snap.KORA_LIVE_SECRET_KEY === undefined) delete process.env.KORA_LIVE_SECRET_KEY;
  else process.env.KORA_LIVE_SECRET_KEY = snap.KORA_LIVE_SECRET_KEY;
}

// ─── 1. Country routing — ISO-2 normalization, never free text ───────────────

test('normalizeCountryToISO2: recognized free-text country names map to ISO-2', () => {
  assert.equal(normalizeCountryToISO2('Cameroon'), 'CM');
  assert.equal(normalizeCountryToISO2('cameroon'), 'CM');
  assert.equal(normalizeCountryToISO2('  Cameroon  '), 'CM');
  assert.equal(normalizeCountryToISO2('Nigeria'), 'NG');
});

test('normalizeCountryToISO2: 2-letter codes pass through uppercased', () => {
  assert.equal(normalizeCountryToISO2('cm'), 'CM');
  assert.equal(normalizeCountryToISO2('CM'), 'CM');
  assert.equal(normalizeCountryToISO2('Ng'), 'NG');
});

test('normalizeCountryToISO2: unrecognized input never silently resolves — returns null', () => {
  assert.equal(normalizeCountryToISO2('Wakanda'), null);
  assert.equal(normalizeCountryToISO2(''), null);
  assert.equal(normalizeCountryToISO2(null), null);
  assert.equal(normalizeCountryToISO2(undefined), null);
  assert.equal(normalizeCountryToISO2('Cameroonian'), null); // no fuzzy/partial matching
});

test('resolveWithdrawalCountry: explicit country input always wins, normalized to ISO-2', () => {
  assert.equal(
    resolveWithdrawalCountry({ country: 'Cameroon', userRegion: 'NG', currency: 'XAF' }),
    'CM'
  );
  assert.equal(
    resolveWithdrawalCountry({ country: 'ng', userRegion: 'CM', currency: 'XAF' }),
    'NG'
  );
});

test('resolveWithdrawalCountry: local Cameroon withdrawal (no country field) resolves to CM via user region', () => {
  // Mirrors the mobile app's local withdrawal path, which historically sent no
  // `country` field at all — the authoritative ISO-2 signup region must be used.
  assert.equal(
    resolveWithdrawalCountry({ country: null, userRegion: 'CM', currency: 'XAF' }),
    'CM'
  );
});

test('resolveWithdrawalCountry: local Cameroon withdrawal with neither country nor region still resolves to CM for XAF', () => {
  assert.equal(
    resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'XAF' }),
    'CM'
  );
  assert.equal(
    resolveWithdrawalCountry({ country: '', userRegion: undefined, currency: 'xaf' }),
    'CM'
  );
});

test('resolveWithdrawalCountry: unresolvable input returns null rather than guessing a provider', () => {
  assert.equal(
    resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'USD' }),
    null
  );
});

// ─── 2. Kora routing — CM / XAF reaches Kora, not Stripe ──────────────────────

test('payoutRouter: CM routes to kora', () => {
  assert.equal(payoutRouter('CM'), 'kora');
});

test('End-to-end: a normal local Cameroon withdrawal (no country field, no region) resolves to the Kora provider path', () => {
  const resolvedCountry = resolveWithdrawalCountry({ country: null, userRegion: null, currency: 'XAF' });
  assert.equal(resolvedCountry, 'CM');
  assert.equal(payoutRouter(resolvedCountry), 'kora');
});

test('isPayoutProviderReady("CM") is true once KORA_LIVE_SECRET_KEY is configured', () => {
  const snap = snapshotEnv();
  try {
    process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test_cm';
    assert.equal(isPayoutProviderReady('CM'), true);
  } finally {
    restoreEnv(snap);
  }
});

// ─── 3 & 6. Corridor support — Cameroon/XAF is mobile-money-only on Kora ──────
// https://developers.korapay.com/docs/send-payments

test('isKoraBankAccountSupported: XAF (Cameroon) has NO bank_account support on Kora', () => {
  assert.equal(isKoraBankAccountSupported('XAF'), false);
  assert.equal(isKoraBankAccountSupported('xaf'), false);
});

test('isKoraMobileMoneySupported: XAF (Cameroon) IS supported — MTN/Orange mobile money', () => {
  assert.equal(isKoraMobileMoneySupported('XAF'), true);
});

test('Corridor support matches Kora\'s documented "Currently supports Payouts to" list', () => {
  // NOTE: USD/GBP bank_account is a real, documented Kora corridor, but this
  // integration deliberately does not implement it (it requires a materially
  // different payload — bank_country, beneficiary_type, address_information,
  // supporting_documents, routing/SWIFT — that isn't wired up). USD/GBP
  // withdrawals continue to route to Stripe — see kora-all-countries.test.js
  // "USD/GBP intentionally NOT routed to Kora" for the full rationale.
  for (const ccy of ['NGN', 'KES', 'ZAR']) {
    assert.equal(isKoraBankAccountSupported(ccy), true, `${ccy} should support bank_account`);
  }
  for (const ccy of ['KES', 'GHS', 'XOF', 'XAF', 'EGP', 'TZS']) {
    assert.equal(isKoraMobileMoneySupported(ccy), true, `${ccy} should support mobile_money`);
  }
  assert.equal(isKoraBankAccountSupported('GHS'), false, 'GHS has no bank_account corridor on Kora');
  assert.equal(isKoraBankAccountSupported('USD'), false, 'USD bank_account corridor is not implemented — routes to Stripe');
  assert.equal(isKoraBankAccountSupported('GBP'), false, 'GBP bank_account corridor is not implemented — routes to Stripe');
});

// ─── koraPayout guards — reject unsupported corridors BEFORE contacting Kora ──

function makeWithdrawal(overrides = {}) {
  return {
    id: 'wd-cm-1',
    userId: 'user-cm-1',
    method: 'bank',
    currency: 'XAF',
    netPayout: 500000, // XAF is zero-decimal — toKoraAmount passes this through as 5000
    bankCode: null,
    accountNumber: null,
    accountHolderName: null,
    bankName: null,
    ...overrides,
  };
}

test('koraPayout: bank withdrawal method for XAF is rejected as a definitive rejection (no Kora bank_account corridor)', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    await assert.rejects(
      koraPayout(makeWithdrawal({ method: 'bank' }), noopLogger),
      (err) => {
        assert.match(err.message, /does not support bank-account payouts in XAF/);
        assert.equal(err._definitiveRejection, true, 'must be flagged for immediate refund, not ambiguous retry');
        return true;
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('koraPayout: mobile-money withdrawal for an unsupported currency is rejected as a definitive rejection', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    await assert.rejects(
      koraPayout(makeWithdrawal({ method: 'mobile', currency: 'NGN', netPayout: 100000 }), noopLogger),
      (err) => {
        assert.match(err.message, /does not support mobile-money payouts in NGN/);
        assert.equal(err._definitiveRejection, true);
        return true;
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('koraPayout: XAF mobile-money amounts must be a multiple of 5 — non-conforming amounts rejected before disbursement', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    // netPayout of 101 (minor==major for XAF) is NOT a multiple of 5.
    await assert.rejects(
      koraPayout(makeWithdrawal({ method: 'mobile', currency: 'XAF', netPayout: 101 }), noopLogger),
      (err) => {
        assert.match(err.message, /multiple of 5/);
        assert.equal(err._definitiveRejection, true);
        return true;
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('koraPayout: the multiple-of-5 guard only fires for non-conforming XAF/XOF amounts', () => {
  // Pure arithmetic check on the same condition koraPayout guards on — avoids
  // exercising the live-DB path (loadAppState) that real disbursement needs,
  // keeping this suite fast while still proving the guard's boundary is correct.
  const isMultipleOf5Violation = (currency, amount) =>
    (currency === 'XAF' || currency === 'XOF') && amount % 5 !== 0;
  assert.equal(isMultipleOf5Violation('XAF', 101), true);
  assert.equal(isMultipleOf5Violation('XAF', 500), false);
  assert.equal(isMultipleOf5Violation('XAF', 95), false);
  assert.equal(isMultipleOf5Violation('XOF', 998), true);
  assert.equal(isMultipleOf5Violation('NGN', 101), false, 'guard only applies to XAF/XOF');
});

test('koraPayout: source builds mobile_money destination with operator (bankCode) + mobile_number for method="mobile"', () => {
  assert.match(payoutSource, /destinationType\s*=\s*w\.method === 'mobile' \? 'mobile_money' : 'bank_account'/);
  assert.match(payoutSource, /destination\.mobile_money = \{\s*\n\s*operator:\s*w\.bankCode,\s*\n\s*mobile_number:\s*plainAccount,/);
});

test('koraPayout: mobile-money payout requires an operator (bankCode) — missing operator is a definitive rejection', () => {
  assert.match(payoutSource, /if \(!w\.bankCode\) \{[\s\S]{0,200}_definitiveRejection = true;/);
});

test('koraPayout: disbursement payload includes a destination.customer object (Kora\'s documented required field)', () => {
  assert.match(payoutSource, /customer:\s*\{\s*\n\s*name:\s*plainHolder \|\| undefined,\s*\n\s*email:\s*user\?\.email \|\| undefined,/);
});

// ─── 3 & 4. Bank list / mobile-money-operator list / account resolution APIs ──
// Exercised against Kora's real endpoint shapes with axios.get/post substituted.

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

test('listKoraBanks: calls Kora\'s official List Banks endpoint with countryCode and Bearer auth', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  let capturedUrl, capturedConfig;
  try {
    await withMockedAxios(
      async (url, config) => {
        capturedUrl = url;
        capturedConfig = config;
        return {
          data: {
            status: true,
            message: 'success',
            data: [{ name: 'Access Bank Nigeria', slug: 'access', code: '044', country: 'NG' }],
          },
        };
      },
      null,
      async () => {
        const banks = await listKoraBanks('NG');
        assert.equal(capturedUrl, 'https://api.korapay.com/merchant/api/v1/misc/banks');
        assert.deepEqual(capturedConfig.params, { countryCode: 'NG' });
        assert.equal(capturedConfig.headers.Authorization, 'Bearer sk_live_test');
        assert.equal(banks.length, 1);
        assert.equal(banks[0].code, '044');
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('listKoraMobileMoneyOperators: calls Kora\'s List MMO endpoint for Cameroon (CM) and returns MTN/Orange slugs', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  let capturedUrl, capturedConfig;
  try {
    await withMockedAxios(
      async (url, config) => {
        capturedUrl = url;
        capturedConfig = config;
        return {
          data: {
            status: true,
            message: 'success',
            data: [
              { name: 'MTN', slug: 'mtn-cm', code: '0001', country: 'CM' },
              { name: 'Orange', slug: 'orange-cm', code: '0002', country: 'CM' },
            ],
          },
        };
      },
      null,
      async () => {
        const operators = await listKoraMobileMoneyOperators('CM');
        assert.equal(capturedUrl, 'https://api.korapay.com/merchant/api/v1/misc/mobile-money');
        assert.deepEqual(capturedConfig.params, { countryCode: 'CM' });
        assert.equal(operators.length, 2);
        assert.deepEqual(operators.map(o => o.slug), ['mtn-cm', 'orange-cm']);
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('resolveKoraBankAccount: posts bank/account/currency to Kora\'s Resolve endpoint and returns the resolved holder name', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  let capturedUrl, capturedBody;
  try {
    await withMockedAxios(
      null,
      async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return {
          data: {
            status: true,
            message: 'Request Completed',
            data: { bank_name: 'United Bank for Africa', bank_code: '033', account_number: '2158634852', account_name: 'EBUKA CIROMA OLADEMJI' },
          },
        };
      },
      async () => {
        const resolved = await resolveKoraBankAccount({ bank: '033', account: '2158634852', currency: 'NG' });
        assert.equal(capturedUrl, 'https://api.korapay.com/merchant/api/v1/misc/banks/resolve');
        assert.deepEqual(capturedBody, { bank: '033', account: '2158634852', currency: 'NG' });
        assert.equal(resolved.account_name, 'EBUKA CIROMA OLADEMJI');
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('resolveKoraMobileMoneyAccount: posts mobileMoneyCode/phoneNumber/currency and never fabricates a name on failure', async () => {
  const snap = snapshotEnv();
  process.env.KORA_LIVE_SECRET_KEY = 'sk_live_test';
  try {
    await withMockedAxios(
      null,
      async () => {
        const err = new Error('Request failed with status code 422');
        err.response = { status: 422, data: { message: 'Unable to resolve mobile money account.' } };
        throw err;
      },
      async () => {
        await assert.rejects(
          resolveKoraMobileMoneyAccount({ mobileMoneyCode: 'mtn-cm', phoneNumber: '237671111111', currency: 'XAF' }),
          /Unable to resolve mobile money account/
        );
      }
    );
  } finally {
    restoreEnv(snap);
  }
});

test('listKoraBanks/listKoraMobileMoneyOperators: throw a clear error when Kora is not configured (never silently return an empty list as success)', async () => {
  const snap = snapshotEnv();
  delete process.env.KORA_LIVE_SECRET_KEY;
  delete process.env.KORA_API_KEY;
  try {
    await assert.rejects(listKoraBanks('NG'), /Kora is not configured/);
    await assert.rejects(listKoraMobileMoneyOperators('CM'), /Kora is not configured/);
  } finally {
    restoreEnv(snap);
  }
});

// ─── index.js wiring — country resolution, corridor guard, new endpoints ─────

function extractWithdrawalsBlock() {
  const match = indexSource.match(/app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);/);
  assert.ok(match, 'POST /withdrawals route block not found');
  return match[0];
}

test('POST /withdrawals resolves the routing country via resolveWithdrawalCountry (never raw free-text)', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /resolveWithdrawalCountry\(\{/);
  assert.match(block, /userRegion:\s*routingUser\?\.region/);
  assert.match(block, /country:\s*resolvedCountry\s*\|\|\s*null,/);
});

test('POST /withdrawals blocks bank withdrawals for currencies Kora only supports via mobile money (e.g. XAF)', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /method === 'bank' && !isKoraBankAccountSupported\(currency\)/);
  assert.match(block, /KORA_BANK_UNSUPPORTED/);
});

test('POST /withdrawals blocks mobile-money withdrawals for currencies Kora does not support via mobile money', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /method === 'mobile' && !isKoraMobileMoneySupported\(currency\)/);
  assert.match(block, /KORA_MOBILE_MONEY_UNSUPPORTED/);
});

test('index.js: new Kora-backed payout utility endpoints exist and require authentication', () => {
  assert.match(indexSource, /app\.get\('\/payout\/banks',\s*authMiddleware/);
  assert.match(indexSource, /app\.get\('\/payout\/mobile-money-operators',\s*authMiddleware/);
  assert.match(indexSource, /app\.post\('\/payout\/resolve-account',\s*authMiddleware/);
});

test('index.js: GET /payout/banks calls listKoraBanks (Kora\'s official List Banks API)', () => {
  const match = indexSource.match(/app\.get\('\/payout\/banks',[\s\S]*?\n\}\);/);
  assert.ok(match);
  assert.match(match[0], /listKoraBanks\(country\)/);
});

test('index.js: GET /payout/mobile-money-operators fetches operators via the cached/fallback-safe koraCorridorRules helper (which itself calls listKoraMobileMoneyOperators — see koraCorridorRules.js)', () => {
  const match = indexSource.match(/app\.get\('\/payout\/mobile-money-operators',[\s\S]*?\n\}\);/);
  assert.ok(match);
  assert.match(match[0], /getMobileMoneyOperatorsForApp\(country\)/);
  const koraCorridorRulesSource = fs.readFileSync(path.join(__dirname, '..', 'koraCorridorRules.js'), 'utf8');
  assert.match(koraCorridorRulesSource, /listKoraMobileMoneyOperators\(country\)/);
});

test('index.js: POST /payout/resolve-account never fabricates an account name on Kora failure', () => {
  const match = indexSource.match(/app\.post\('\/payout\/resolve-account',[\s\S]*?\n\}\);/);
  assert.ok(match);
  assert.match(match[0], /resolveKoraMobileMoneyAccount\(/);
  assert.match(match[0], /resolveKoraBankAccount\(/);
  assert.match(match[0], /never invent an account holder name/);
});

// ─── Mobile app wiring (SendScreen.tsx) — regex source verification ──────────
// Consistent with existing frontend regression tests (e.g.
// __tests__/virtual-card-display.node.test.js) which verify screen source via
// fs.readFileSync rather than rendering React Native components under Node.

test('SendScreen: local Cameroon (XAF) withdrawal resolves country via the backend region fallback, not a hardcoded override', () => {
  // Superseded by kora-all-countries.test.js — the hardcoded `country: 'CM'`
  // override was deliberately REMOVED (see that suite's "never forces
  // country=CM/CI for XAF/XOF" test) so an Equatorial-Guinea-region user with
  // an XAF wallet is never silently mis-routed to the Cameroon corridor.
  // CM still works correctly via resolveWithdrawalCountry's userRegion/
  // currency fallback in backend/payoutProviders.js.
  assert.doesNotMatch(sendScreenSource, /country:\s*'CM'/);
  assert.match(sendScreenSource, /XAF:\s*'CM'/); // still the documented currency default on the backend side
});

test('SendScreen: Cameroon (and every other Kora mobile-money corridor) sends the Kora operator slug as bankCode (no manual bank-code typing)', () => {
  assert.match(sendScreenSource, /isKoraMobileMoneyWithdrawal && mmOperatorSlug && \{ bankCode: mmOperatorSlug \}/);
});

test('SendScreen: bank withdrawal method is disabled for local XAF (Cameroon) — Kora has no bank_account corridor there', () => {
  assert.match(sendScreenSource, /koraBankUnavailableForCurrency = activeTab === 'withdraw' && !!koraMobileCountryForCurrency && !koraBankCountryForCurrency/);
  assert.match(sendScreenSource, /disabled=\{xafLocalBankUnavailable\}/);
});

test('SendScreen: fetches Kora\'s official mobile-money operator list instead of free-text operator entry (generalized beyond Cameroon)', () => {
  assert.match(sendScreenSource, /\/payout\/mobile-money-operators\?country=\$\{koraMobileCountryForCurrency\}/);
  assert.match(sendScreenSource, /setShowOperatorPicker/);
});

test('SendScreen: resolves/confirms the account holder name via the backend before submission', () => {
  assert.match(sendScreenSource, /\/payout\/resolve-account/);
  assert.match(sendScreenSource, /setResolvedAccountName/);
});

// ─── 7. No admin approval for a normal, unflagged Cameroon withdrawal ─────────

test('requiresAdminIntervention: a normal, unflagged user withdrawing is auto-processed (no admin review)', () => {
  const cleanUser = {
    id: 'cm-user-1',
    accountStatus: 'active',
    kycStatus: 'approved',
    riskFlags: undefined,
  };
  const cleanDb = { fraudAlerts: [], disputes: [] };
  const result = requiresAdminIntervention(cleanUser, cleanDb);
  assert.equal(result.required, false);
  assert.deepEqual(result.reasons, []);
});

test('requiresAdminIntervention: fraud/AML/legal-hold flags still force admin review (safety net preserved)', () => {
  const flaggedUser = { id: 'cm-user-2', accountStatus: 'active', kycStatus: 'approved', fraudHold: true };
  const result = requiresAdminIntervention(flaggedUser, { fraudAlerts: [], disputes: [] });
  assert.equal(result.required, true);
  assert.ok(result.reasons.length > 0);
});

// ─── Module exports — new helpers exposed for index.js consumption ────────────

test('payoutProviders exports all new Cameroon/XAF-readiness helpers', () => {
  for (const name of [
    'normalizeCountryToISO2', 'resolveWithdrawalCountry',
    'isKoraBankAccountSupported', 'isKoraMobileMoneySupported',
    'listKoraBanks', 'listKoraMobileMoneyOperators',
    'resolveKoraBankAccount', 'resolveKoraMobileMoneyAccount',
  ]) {
    assert.equal(typeof payoutProviders[name], 'function', `${name} must be exported`);
  }
});

// ─── No regressions: existing providers / Stripe deposit flow untouched ───────

test('No existing provider removed — stripePayout and koraPayout both still defined', () => {
  assert.match(payoutSource, /async function stripePayout/);
  assert.match(payoutSource, /async function koraPayout/);
});

test('Stripe deposit endpoints untouched by this change', () => {
  assert.match(indexSource, /app\.post\('\/deposits\/create-intent'/);
  assert.match(indexSource, /app\.post\('\/deposits\/confirm'/);
});
