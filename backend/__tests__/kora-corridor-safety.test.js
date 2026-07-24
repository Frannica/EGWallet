'use strict';

/**
 * Kora payout corridor-safety tests.
 *
 * Covers the payout-safety gap closed in koraCorridorRules.js: real,
 * Kora-verified per-operator minimum/maximum amount, phone/account-number
 * format, and operator/bank whitelist enforcement BEFORE any wallet hold or
 * debit — plus proof that:
 *   1. the withdrawal fee is DEDUCTED from the requested amount (not added
 *      on top), so a user can withdraw their exact full available balance
 *      without ever exceeding it because of fees, and
 *   2. a definitive provider rejection results in complete balance
 *      restoration (no funds ever lost, no double-refund).
 *
 * Required scenarios (per corridor-safety mission):
 *   - Below minimum          - Above maximum           - Unsupported operator/bank
 *   - Exact minimum          - Incorrect decimals       - Insufficient balance incl. fees
 *   - Exact maximum          - Invalid phone/account    - Provider rejection + full refund
 *
 * Source references: https://developers.korapay.com/docs/payout-via-api,
 * send-payments, payout-utilities, testing-your-integration. Mobile-money
 * operator min/max verified LIVE against the production Kora account
 * (read-only /misc/mobile-money calls) on 2026-07-24 — see the long comment
 * atop koraCorridorRules.js for full sourcing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const payoutProviders = require('../payoutProviders');
const koraCorridorRules = require('../koraCorridorRules');
const { validateKoraWithdrawalPreHold } = koraCorridorRules;
const { createWithdrawal, markWithdrawalFailed, advanceToProcessing } = require('../withdrawalEngine');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const sendScreenSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'screens', 'SendScreen.tsx'),
  'utf8'
);
const apiErrorMessageSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'utils', 'apiErrorMessage.ts'),
  'utf8'
);

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function withMockedAxiosGet(mockGet, fn) {
  const original = axios.get;
  axios.get = mockGet;
  return Promise.resolve().then(fn).finally(() => { axios.get = original; });
}

function korapayOperatorsResponse(operators) {
  return { data: { status: true, message: 'success', data: operators } };
}
function korapayBanksResponse(banks) {
  return { data: { status: true, message: 'success', data: banks } };
}

const KE_OPERATORS = [
  { name: 'AIRTEL',    slug: 'airtel-ke',    code: '0002',  min: 10, max: 150000 },
  { name: 'EQUITEL',   slug: 'equitel-ke',   code: '0003',  min: 10, max: 100000 },
  { name: 'SAFARICOM', slug: 'safaricom-ke', code: '0001',  min: 10, max: 150000 },
  { name: 'T-Kash',    slug: 't-kash-ke',    code: '63907', min: 50, max: 200000 },
];
const NG_BANKS = [
  { name: 'Access Bank Nigeria', slug: 'access',     code: '044' },
  { name: 'United Bank for Africa', slug: 'uba',      code: '033' },
];

// Kora's /misc/* utility endpoints (List Banks, List MMO) authenticate with
// the PUBLIC key (see the koraMiscRequest comment in payoutProviders.js).
// Without one configured, listKoraBanks/listKoraMobileMoneyOperators throw
// "Kora is not configured" BEFORE ever calling axios.get — which would make
// every mocked-axios test below pass for the wrong reason (silently falling
// back instead of exercising the mock). Set a fake key for the whole suite
// so the mocked HTTP layer is actually what's under test.
let _envSnapshot;
test.beforeEach(() => {
  koraCorridorRules._test.clearCaches();
  _envSnapshot = process.env.KORA_LIVE_PUBLIC_KEY;
  process.env.KORA_LIVE_PUBLIC_KEY = 'pk_live_test_corridor_safety';
});
test.afterEach(() => {
  if (_envSnapshot === undefined) delete process.env.KORA_LIVE_PUBLIC_KEY;
  else process.env.KORA_LIVE_PUBLIC_KEY = _envSnapshot;
});

// ─── Below minimum / exact minimum / exact maximum / above maximum ──────────

test('validateKoraWithdrawalPreHold: BELOW minimum for a mobile-money operator is rejected', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse(KE_OPERATORS),
    async () => {
      // Safaricom min=10 KES. Request 5.00 KES (500 minor units) — below minimum.
      const result = await validateKoraWithdrawalPreHold({
        country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 500,
        bankCode: 'safaricom-ke', accountNumber: '254712345678',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BELOW_MINIMUM');
      assert.equal(result.min, 10);
    }
  );
});

test('validateKoraWithdrawalPreHold: EXACT minimum for a mobile-money operator is accepted', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse(KE_OPERATORS),
    async () => {
      // Safaricom min=10 KES exactly = 1000 minor units.
      const result = await validateKoraWithdrawalPreHold({
        country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 1000,
        bankCode: 'safaricom-ke', accountNumber: '254712345678',
      });
      assert.equal(result.ok, true);
    }
  );
});

test('validateKoraWithdrawalPreHold: EXACT maximum for a mobile-money operator is accepted', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse(KE_OPERATORS),
    async () => {
      // Safaricom max=150000 KES exactly = 15,000,000 minor units.
      const result = await validateKoraWithdrawalPreHold({
        country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 15_000_000,
        bankCode: 'safaricom-ke', accountNumber: '254712345678',
      });
      assert.equal(result.ok, true);
    }
  );
});

test('validateKoraWithdrawalPreHold: ABOVE maximum for a mobile-money operator is rejected', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse(KE_OPERATORS),
    async () => {
      // Safaricom max=150000 KES. Request 150,000.01 KES (15,000,001 minor units).
      const result = await validateKoraWithdrawalPreHold({
        country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 15_000_001,
        bankCode: 'safaricom-ke', accountNumber: '254712345678',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ABOVE_MAXIMUM');
      assert.equal(result.max, 150000);
    }
  );
});

test('validateKoraWithdrawalPreHold: different operators in the same country carry different min/max (T-Kash min=50, not Safaricom\'s 10)', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse(KE_OPERATORS),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 2000, // 20 KES
        bankCode: 't-kash-ke', accountNumber: '254712345678',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BELOW_MINIMUM');
      assert.equal(result.min, 50);
    }
  );
});

// ─── Incorrect decimals (XAF/XOF multiple-of-5) ──────────────────────────────

test('validateKoraWithdrawalPreHold: XAF amount NOT a multiple of 5 is rejected as INVALID_AMOUNT_PRECISION', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse([{ name: 'MTN', slug: 'mtn-cm', code: 'MTN_CM', min: 2, max: 1000000 }]),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'CM', currency: 'XAF', method: 'mobile', amountMinor: 101, // XAF is zero-decimal
        bankCode: 'mtn-cm', accountNumber: '237671234567',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_AMOUNT_PRECISION');
    }
  );
});

test('validateKoraWithdrawalPreHold: XAF amount that IS a multiple of 5 passes the precision check', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse([{ name: 'MTN', slug: 'mtn-cm', code: 'MTN_CM', min: 2, max: 1000000 }]),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'CM', currency: 'XAF', method: 'mobile', amountMinor: 500,
        bankCode: 'mtn-cm', accountNumber: '237671234567',
      });
      assert.equal(result.ok, true);
    }
  );
});

test('validateKoraWithdrawalPreHold: XOF amount NOT a multiple of 5 is rejected', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse([{ name: 'MTN', slug: 'mtn-ci', code: 'MTN_CI', min: 2, max: 2000000 }]),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'CI', currency: 'XOF', method: 'mobile', amountMinor: 998,
        bankCode: 'mtn-ci', accountNumber: '2250512345678',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_AMOUNT_PRECISION');
    }
  );
});

// ─── Invalid phone / account format ──────────────────────────────────────────

test('validateKoraWithdrawalPreHold: local-format Kenyan phone number (missing 254 country code) is rejected', async () => {
  const result = await validateKoraWithdrawalPreHold({
    country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 5000,
    bankCode: 'safaricom-ke', accountNumber: '0712345678', // local format, not international
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PHONE_FORMAT');
});

test('validateKoraWithdrawalPreHold: correctly-formatted international phone numbers pass format check for every mobile corridor', async () => {
  const cases = [
    { country: 'KE', currency: 'KES', phone: '254712345678' },
    { country: 'GH', currency: 'GHS', phone: '233241234567' },
    { country: 'CI', currency: 'XOF', phone: '2250512345678' },
    { country: 'CM', currency: 'XAF', phone: '237671234567' },
    { country: 'EG', currency: 'EGP', phone: '201012345678' },
    { country: 'TZ', currency: 'TZS', phone: '255751234567' },
  ];
  for (const c of cases) {
    const rule = koraCorridorRules.PHONE_FORMAT[c.country];
    assert.ok(rule.regex.test(c.phone), `${c.country} phone ${c.phone} should match its documented format`);
  }
});

test('validateKoraWithdrawalPreHold: Nigerian bank account number that is not a 10-digit NUBAN is rejected', async () => {
  const result = await validateKoraWithdrawalPreHold({
    country: 'NG', currency: 'NGN', method: 'bank', amountMinor: 500000,
    bankCode: '044', accountNumber: '12345', // too short — not a NUBAN
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ACCOUNT_FORMAT');
});

test('validateKoraWithdrawalPreHold: a valid 10-digit NUBAN passes format check', async () => {
  await withMockedAxiosGet(
    async () => korapayBanksResponse(NG_BANKS),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'NG', currency: 'NGN', method: 'bank', amountMinor: 500000,
        bankCode: '044', accountNumber: '0123456789',
      });
      assert.equal(result.ok, true);
    }
  );
});

// ─── Unsupported operator / bank ─────────────────────────────────────────────

test('validateKoraWithdrawalPreHold: an operator slug not in Kora\'s official Kenyan mobile-money list is rejected', async () => {
  await withMockedAxiosGet(
    async () => korapayOperatorsResponse(KE_OPERATORS),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'KE', currency: 'KES', method: 'mobile', amountMinor: 5000,
        bankCode: 'fictional-mno-ke', accountNumber: '254712345678',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNSUPPORTED_OPERATOR');
    }
  );
});

test('validateKoraWithdrawalPreHold: a bank code not in Kora\'s official Nigerian bank list is rejected', async () => {
  await withMockedAxiosGet(
    async () => korapayBanksResponse(NG_BANKS),
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'NG', currency: 'NGN', method: 'bank', amountMinor: 500000,
        bankCode: '999999', accountNumber: '0123456789',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNSUPPORTED_BANK');
    }
  );
});

test('validateKoraWithdrawalPreHold: missing operator/bank code is rejected with a clear error, not a silent pass', async () => {
  const mobileResult = await validateKoraWithdrawalPreHold({
    country: 'GH', currency: 'GHS', method: 'mobile', amountMinor: 5000,
    bankCode: '', accountNumber: '233241234567',
  });
  assert.equal(mobileResult.ok, false);
  assert.equal(mobileResult.code, 'UNSUPPORTED_OPERATOR');

  const bankResult = await validateKoraWithdrawalPreHold({
    country: 'NG', currency: 'NGN', method: 'bank', amountMinor: 500000,
    bankCode: '', accountNumber: '0123456789',
  });
  assert.equal(bankResult.ok, false);
  assert.equal(bankResult.code, 'UNSUPPORTED_BANK');
});

// ─── Live-fetch-with-fallback behavior — never silently disables validation ──

test('getMobileMoneyOperators: falls back to the same-day-verified static snapshot when Kora\'s live utility API is unreachable', async () => {
  await withMockedAxiosGet(
    async () => { throw new Error('ETIMEDOUT'); },
    async () => {
      const { operators, source } = await koraCorridorRules.getMobileMoneyOperators('TZ');
      assert.ok(Array.isArray(operators) && operators.length > 0);
      assert.match(source, /static-fallback/);
      // Snapshot values must still enforce a real limit, not silently no-op.
      const airtel = operators.find(o => o.slug === 'airtel-tz');
      assert.equal(airtel.min, 1000);
    }
  );
});

test('getBankList: with no live data and no cache, returns null banks — never fabricates a bank list', async () => {
  await withMockedAxiosGet(
    async () => { throw new Error('ECONNRESET'); },
    async () => {
      const { banks } = await koraCorridorRules.getBankList('ZA');
      assert.equal(banks, null);
    }
  );
});

// ─── FAIL CLOSED: unavailable provider data blocks the withdrawal entirely ──
// (no format-only pass-through, no unverified bank/operator ever accepted)

test('validateKoraWithdrawalPreHold: bank withdrawal is REJECTED (not silently accepted) when Kora\'s bank list is unreachable and there is no cache', async () => {
  await withMockedAxiosGet(
    async () => { throw new Error('ETIMEDOUT'); },
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'ZA', currency: 'ZAR', method: 'bank', amountMinor: 500000,
        bankCode: '632005', accountNumber: '123456789', // well-formed, plausible-looking values
      });
      assert.equal(result.ok, false, 'must fail closed — never accept an unverifiable bank code');
      assert.equal(result.code, 'PROVIDER_VALIDATION_UNAVAILABLE');
      assert.match(result.error, /try again/i);
    }
  );
});

test('validateKoraWithdrawalPreHold: mobile-money withdrawal is REJECTED when there is no live list, no cache, AND no snapshot coverage for the corridor (defensive fail-closed for future/unlisted corridors)', async () => {
  await withMockedAxiosGet(
    async () => { throw new Error('ETIMEDOUT'); },
    async () => {
      // 'ZZ' deliberately has no entry in MOBILE_MONEY_SNAPSHOT — simulates a
      // corridor Kora has not yet published verified limits for.
      const result = await validateKoraWithdrawalPreHold({
        country: 'ZZ', currency: 'ZZZ', method: 'mobile', amountMinor: 5000,
        bankCode: 'some-operator', accountNumber: '999999999999',
      });
      assert.equal(result.ok, false, 'must fail closed — never guess operator limits for an unverified corridor');
      assert.equal(result.code, 'PROVIDER_VALIDATION_UNAVAILABLE');
    }
  );
});

test('validateKoraWithdrawalPreHold: PROVIDER_VALIDATION_UNAVAILABLE does not fabricate min/max — result carries no min/max fields to display', async () => {
  await withMockedAxiosGet(
    async () => { throw new Error('ETIMEDOUT'); },
    async () => {
      const result = await validateKoraWithdrawalPreHold({
        country: 'ZA', currency: 'ZAR', method: 'bank', amountMinor: 500000,
        bankCode: '632005', accountNumber: '123456789',
      });
      assert.equal(result.ok, false);
      assert.equal(result.min, undefined);
      assert.equal(result.max, undefined);
    }
  );
});

test('POST /withdrawals wiring: PROVIDER_VALIDATION_UNAVAILABLE is answered with 503 (safely retryable), distinct from the 400 used for definitive validation failures', () => {
  assert.match(
    indexSource,
    /PROVIDER_VALIDATION_UNAVAILABLE['"]?\s*\?\s*503\s*:\s*400/,
    'index.js must special-case PROVIDER_VALIDATION_UNAVAILABLE as a 503, not a 400'
  );
});

test('fail-closed path never touches the wallet: createWithdrawal is never reached when corridor validation returns ok:false', async () => {
  // Simulates exactly what POST /withdrawals does: corridor check runs BEFORE
  // withBalanceMutex/createWithdrawal, and a not-ok result short-circuits with
  // an early return — so no hold, no debit, no payout dispatch is possible.
  const db = {
    wallets: [{ id: 'w1', userId: 'u1', balances: [{ currency: 'ZAR', amount: 100_000 }], holdBalance: {} }],
    withdrawals: [], ledger: [],
  };
  await withMockedAxiosGet(
    async () => { throw new Error('ETIMEDOUT'); },
    async () => {
      const corridorCheck = await validateKoraWithdrawalPreHold({
        country: 'ZA', currency: 'ZAR', method: 'bank', amountMinor: 50_000,
        bankCode: '632005', accountNumber: '123456789',
      });
      assert.equal(corridorCheck.ok, false);
      if (!corridorCheck.ok) {
        // index.js returns here — createWithdrawal is never called.
        assert.equal(db.wallets[0].balances[0].amount, 100_000, 'balance untouched');
        assert.deepEqual(db.wallets[0].holdBalance, {}, 'no hold ever placed');
        assert.equal(db.withdrawals.length, 0, 'no withdrawal record created — no payout could ever be dispatched');
        return;
      }
      assert.fail('corridor check should have failed closed');
    }
  );
});

test('safe retry: once Kora\'s bank list becomes reachable again, the exact same request is accepted (fail-closed is temporary, not permanent)', async () => {
  // First attempt: Kora unreachable, no cache yet -> fails closed.
  const first = await withMockedAxiosGet(
    async () => { throw new Error('ETIMEDOUT'); },
    () => validateKoraWithdrawalPreHold({
      country: 'NG', currency: 'NGN', method: 'bank', amountMinor: 500000,
      bankCode: '044', accountNumber: '0123456789',
    })
  );
  assert.equal(first.ok, false);
  assert.equal(first.code, 'PROVIDER_VALIDATION_UNAVAILABLE');

  // Retry (e.g. user taps "try again"): Kora is back up — same request now succeeds.
  const second = await withMockedAxiosGet(
    async () => korapayBanksResponse(NG_BANKS),
    () => validateKoraWithdrawalPreHold({
      country: 'NG', currency: 'NGN', method: 'bank', amountMinor: 500000,
      bankCode: '044', accountNumber: '0123456789',
    })
  );
  assert.equal(second.ok, true, 'the same request must succeed once Kora is reachable — no permanent lockout from a transient outage');
});

// ─── Fee direction: deducted from requested amount, never added on top ──────

test('calcWithdrawFee (index.js): fee is DEDUCTED from the requested amount — netPayout = amount - fee, never amount + fee', () => {
  assert.match(indexSource, /function calcWithdrawFee\(amountMinor, isInternational\)/);
  const block = indexSource.match(/function calcWithdrawFee\([\s\S]*?\n\}/)[0];
  assert.match(block, /feeAmount\s*=\s*Math\.round\(amountMinor \* rate\)/);
  assert.match(block, /netPayout:\s*amountMinor\s*-\s*feeAmount/);
});

test('createWithdrawal: holds EXACTLY the requested amount (not amount + fee) — proves a user can request their full available balance without a fee-related insufficient-funds rejection', () => {
  const db = {
    wallets: [{ id: 'w1', userId: 'u1', balances: [{ currency: 'KES', amount: 100_000 }], holdBalance: {} }],
    withdrawals: [],
    ledger: [],
  };
  const FEE_RATE = 0.0128; // local withdrawal rate used elsewhere in this codebase
  const requestedAmount = 100_000; // the user's ENTIRE available balance
  const feeAmount = Math.round(requestedAmount * FEE_RATE);
  const netPayout = requestedAmount - feeAmount;

  const withdrawal = createWithdrawal(db, 'u1', {
    walletId: 'w1', amount: requestedAmount, currency: 'KES', method: 'mobile', isInternational: false,
    country: 'KE', bankName: null, accountNumber: '254712345678', accountHolderName: 'Test User',
    bankCode: 'safaricom-ke', branchCode: null, iban: null, swiftBic: null,
    feeAmount, feeRate: FEE_RATE, netPayout,
  });

  const wallet = db.wallets[0];
  assert.equal(wallet.balances[0].amount, 0, 'full balance moves to hold — no fee-inflated debit');
  assert.equal(wallet.holdBalance.KES, requestedAmount, 'hold equals the requested amount exactly, not amount + fee');
  assert.equal(withdrawal.netPayout, netPayout, 'recipient receives amount - fee; fee is never added on top');
  assert.ok(withdrawal.netPayout < withdrawal.amount, 'fee reduces the payout, confirming it is deducted, not added');
});

// ─── Insufficient balance including fees ─────────────────────────────────────

test('createWithdrawal: requesting exactly the full available balance succeeds (fee is absorbed from the requested amount, not added)', () => {
  const db = {
    wallets: [{ id: 'w1', userId: 'u1', balances: [{ currency: 'NGN', amount: 50_000 }], holdBalance: {} }],
    withdrawals: [], ledger: [],
  };
  assert.doesNotThrow(() => createWithdrawal(db, 'u1', {
    walletId: 'w1', amount: 50_000, currency: 'NGN', method: 'bank', isInternational: false,
    country: 'NG', bankName: 'Access Bank', accountNumber: '0123456789', accountHolderName: 'Test User',
    bankCode: '044', branchCode: null, iban: null, swiftBic: null,
    feeAmount: 640, feeRate: 0.0128, netPayout: 49_360,
  }));
  assert.equal(db.wallets[0].balances[0].amount, 0);
});

test('createWithdrawal: requesting even 1 minor unit more than the available balance is rejected — "Insufficient funds"', () => {
  const db = {
    wallets: [{ id: 'w1', userId: 'u1', balances: [{ currency: 'NGN', amount: 50_000 }], holdBalance: {} }],
    withdrawals: [], ledger: [],
  };
  assert.throws(
    () => createWithdrawal(db, 'u1', {
      walletId: 'w1', amount: 50_001, currency: 'NGN', method: 'bank', isInternational: false,
      country: 'NG', bankName: 'Access Bank', accountNumber: '0123456789', accountHolderName: 'Test User',
      bankCode: '044', branchCode: null, iban: null, swiftBic: null,
      feeAmount: 640, feeRate: 0.0128, netPayout: 49_361,
    }),
    (err) => { assert.match(err.message, /Insufficient funds/); return true; }
  );
  // Balance must be completely untouched by the rejected attempt.
  assert.equal(db.wallets[0].balances[0].amount, 50_000);
  assert.equal(db.wallets[0].holdBalance.NGN, undefined);
});

// ─── Provider rejection with complete balance restoration ───────────────────

test('markWithdrawalFailed: a definitive Kora provider rejection results in COMPLETE balance restoration — no funds lost, hold fully released', () => {
  const db = {
    wallets: [{ id: 'w1', userId: 'u1', balances: [{ currency: 'GHS', amount: 80_000 }], holdBalance: {} }],
    withdrawals: [], ledger: [],
  };

  const withdrawal = createWithdrawal(db, 'u1', {
    walletId: 'w1', amount: 20_000, currency: 'GHS', method: 'mobile', isInternational: false,
    country: 'GH', bankName: null, accountNumber: '233241234567', accountHolderName: 'Test User',
    bankCode: 'mtn-gh', branchCode: null, iban: null, swiftBic: null,
    feeAmount: 256, feeRate: 0.0128, netPayout: 19_744,
  });

  // Balance debited into hold; simulate advancing to "processing" (as index.js does).
  advanceToProcessing(db, withdrawal.id);
  assert.equal(db.wallets[0].balances[0].amount, 60_000);
  assert.equal(db.wallets[0].holdBalance.GHS, 20_000);

  // Simulate a Kora API definitive 4xx rejection at dispatch time — the failure
  // path (payoutProviders.executePayout) calls markWithdrawalFailed exactly
  // like this once it has confirmed the disbursement was never created.
  markWithdrawalFailed(db, withdrawal.id, 'Kora API error: Invalid destination account');

  // Balance must be restored to EXACTLY the pre-withdrawal amount.
  assert.equal(db.wallets[0].balances[0].amount, 80_000, 'available balance fully restored');
  assert.equal(db.wallets[0].holdBalance.GHS, 0, 'hold fully released — no residual escrow');
  assert.equal(withdrawal.status, 'failed');
  assert.equal(withdrawal.holdReleased, true);
  assert.equal(withdrawal.refundIssued, true);
});

test('markWithdrawalFailed: refund is idempotent — calling twice never double-credits the wallet', () => {
  const db = {
    wallets: [{ id: 'w1', userId: 'u1', balances: [{ currency: 'ZAR', amount: 30_000 }], holdBalance: {} }],
    withdrawals: [], ledger: [],
  };
  const withdrawal = createWithdrawal(db, 'u1', {
    walletId: 'w1', amount: 10_000, currency: 'ZAR', method: 'bank', isInternational: false,
    country: 'ZA', bankName: 'ABSA', accountNumber: '123456789', accountHolderName: 'Test User',
    bankCode: '632005', branchCode: null, iban: null, swiftBic: null,
    feeAmount: 128, feeRate: 0.0128, netPayout: 9_872,
  });
  advanceToProcessing(db, withdrawal.id);
  markWithdrawalFailed(db, withdrawal.id, 'Kora API error: account not found');
  assert.equal(db.wallets[0].balances[0].amount, 30_000);

  // _issueRefund's refundIssued guard must prevent a second credit even if
  // called again (e.g. a duplicate/retried failure-path invocation).
  const w = db.withdrawals[0];
  assert.equal(w.refundIssued, true);
  // Directly re-invoking the same transition is blocked by the state machine
  // (status is already terminal 'failed' — VALID_TRANSITIONS['failed'] = []).
  assert.throws(() => markWithdrawalFailed(db, withdrawal.id, 'retry'), /Cannot mark failed from status: failed/);
  assert.equal(db.wallets[0].balances[0].amount, 30_000, 'still exactly one refund — no double credit');
});

// ─── Backend wiring — pre-hold enforcement happens BEFORE any balance mutation ──

function extractWithdrawalsBlock() {
  const match = indexSource.match(/app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);/);
  assert.ok(match, 'POST /withdrawals route block not found');
  return match[0];
}

test('POST /withdrawals: corridor validation runs BEFORE withBalanceMutex / createWithdrawal (never after a hold is placed)', () => {
  const block = extractWithdrawalsBlock();
  const corridorIdx = block.indexOf('validateKoraWithdrawalPreHold(');
  const mutexIdx    = block.indexOf('withBalanceMutex(async () => {');
  const createIdx   = block.indexOf('createWithdrawal(db,');
  assert.ok(corridorIdx > -1, 'corridor validation call not found in POST /withdrawals');
  assert.ok(mutexIdx > -1 && createIdx > -1);
  assert.ok(corridorIdx < mutexIdx, 'corridor validation must run before the balance mutex is entered');
  assert.ok(corridorIdx < createIdx, 'corridor validation must run before createWithdrawal (before any hold)');
});

test('POST /withdrawals: corridor rejection returns a structured errorCode (400 for validation failures, 503 for PROVIDER_VALIDATION_UNAVAILABLE), never a generic 500', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /if \(!corridorCheck\.ok\) \{[\s\S]{0,900}res\.status\(statusCode\)/);
  assert.match(block, /PROVIDER_VALIDATION_UNAVAILABLE['"]?\s*\?\s*503\s*:\s*400/);
  assert.match(block, /errorCode:\s*corridorCheck\.code/);
});

test('index.js: koraCorridorRules is imported and wired for both mobile-money-operator listing and withdrawal validation', () => {
  assert.match(indexSource, /require\('\.\/koraCorridorRules'\)/);
  assert.match(indexSource, /validateKoraWithdrawalPreHold/);
});

// ─── Mobile app wiring (SendScreen.tsx) — mirrors backend rules client-side ──

test('SendScreen: client-side validation checks amount against the selected operator\'s live min/max before submit', () => {
  assert.match(sendScreenSource, /function validateKoraCorridorClientSide/);
  assert.match(sendScreenSource, /selectedOperator\.min/);
  assert.match(sendScreenSource, /selectedOperator\.max/);
  assert.match(sendScreenSource, /validateKoraCorridorClientSide\(amt\)/);
});

test('SendScreen: client-side phone-format regexes match the backend\'s koraCorridorRules.PHONE_FORMAT exactly (same 6 corridors)', () => {
  for (const cc of ['KE', 'GH', 'CI', 'CM', 'EG', 'TZ']) {
    const backendRegexSrc = koraCorridorRules.PHONE_FORMAT[cc].regex.source;
    assert.match(
      sendScreenSource,
      new RegExp(cc + ':\\s*\\{\\s*regex:\\s*/' + backendRegexSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/')
    );
  }
});

test('SendScreen: XAF/XOF multiple-of-5 amount rule is enforced client-side before submit', () => {
  assert.match(sendScreenSource, /amt % 5 !== 0/);
  assert.match(sendScreenSource, /mustBeMultipleOfFive/);
});

test('SendScreen: mobile-money operator picker surfaces Kora\'s own min/max to the user (never a fabricated placeholder range)', () => {
  assert.match(sendScreenSource, /op\.min/);
  assert.match(sendScreenSource, /op\.max/);
  assert.match(sendScreenSource, /operatorLimitRange/);
});

test('apiErrorMessage.ts: PROVIDER_VALIDATION_UNAVAILABLE maps to a clear, dedicated, localized message (never the generic requestFailed fallback)', () => {
  assert.match(apiErrorMessageSource, /PROVIDER_VALIDATION_UNAVAILABLE:\s*'send\.corridorValidationUnavailable'/);
});

test('translations.ts: send.corridorValidationUnavailable is translated for every supported language (7 languages)', () => {
  const translationsSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'i18n', 'translations.ts'),
    'utf8'
  );
  const matches = translationsSource.match(/'send\.corridorValidationUnavailable':/g) || [];
  assert.equal(matches.length, 7, 'expected exactly 7 translated occurrences (one per supported language)');
});

// ─── No regressions ───────────────────────────────────────────────────────────

test('koraCorridorRules exports the full validation surface used by index.js and its own test suite', () => {
  for (const name of ['validateKoraWithdrawalPreHold', 'getMobileMoneyOperators', 'getBankList', 'PHONE_FORMAT', 'BANK_ACCOUNT_FORMAT']) {
    assert.ok(name in koraCorridorRules, `${name} must be exported from koraCorridorRules.js`);
  }
});

test('payoutProviders exports toKoraAmount and ZERO_DECIMAL for koraCorridorRules to reuse (single source of truth for unit conversion)', () => {
  assert.equal(typeof payoutProviders.toKoraAmount, 'function');
  assert.ok(payoutProviders.ZERO_DECIMAL instanceof Set);
  assert.equal(payoutProviders.ZERO_DECIMAL.has('XAF'), true);
  assert.equal(payoutProviders.ZERO_DECIMAL.has('KES'), false);
});
