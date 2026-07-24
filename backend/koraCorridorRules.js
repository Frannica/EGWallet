'use strict';
/**
 * koraCorridorRules.js
 *
 * Enforces Kora's real per-corridor payout-safety rules — minimum/maximum
 * amount, phone-number format, bank-account format, and operator/bank
 * whitelist — BEFORE any wallet hold or debit happens in POST /withdrawals.
 *
 * WHY THIS FILE EXISTS: koraPayout() in payoutProviders.js already rejects
 * a handful of these conditions (XAF/XOF multiple-of-5, unsupported
 * method/currency combos), but only at *dispatch* time — i.e. AFTER
 * createWithdrawal() has already moved funds into holdBalance. That is
 * money-safe (the failure path refunds in full — see executePayout's
 * "FAILURE" branch and isDefinitiveProviderRejection), but it needlessly
 * holds real user funds for amounts/formats we can already know are wrong
 * before the request is even accepted. validateKoraWithdrawalPreHold() runs
 * from POST /withdrawals BEFORE the balance mutex / createWithdrawal call so
 * bad requests are rejected with zero fund movement at all.
 *
 * SOURCE OF TRUTH FOR LIMITS: Kora's OWN live `/misc/mobile-money` and
 * `/misc/banks` utility endpoints (see listKoraMobileMoneyOperators /
 * listKoraBanks in payoutProviders.js) — fetched fresh on every distinct
 * country (cached briefly). This module never invents an amount limit.
 * MOBILE_MONEY_SNAPSHOT below is a SAME-DAY VERIFIED fallback — it was
 * produced by actually calling the live mobile-money endpoint against the
 * production Kora account (read-only, zero disbursement calls) on
 * 2026-07-24 — and is used ONLY if Kora's utility API is unreachable at
 * request time AND there is no usable cache, so a transient Kora outage
 * can never silently disable this validation. Re-probe periodically; Kora
 * does not publish a change-notification feed for these values.
 *
 * FAIL CLOSED, ALWAYS: bank codes have no static snapshot (283 NG entries
 * alone — impractical to hardcode and would go stale silently). If the live
 * bank list is unreachable and there is no cache, validateKoraWithdrawalPreHold
 * returns PROVIDER_VALIDATION_UNAVAILABLE and rejects the request BEFORE any
 * wallet hold. An unverified bank code, and an unverified mobile-money
 * operator for a corridor with no snapshot coverage, are NEVER submitted as
 * a guess. The user sees a clear, safely-retryable error and can resubmit
 * once Kora's utility API is reachable again — no funds ever move in the
 * meantime.
 */

const { listKoraBanks, listKoraMobileMoneyOperators, toKoraAmount, ZERO_DECIMAL } = require('./payoutProviders');

// ─── Live-fetch cache (falls back to the same-day verified snapshot) ────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — Kora operator/bank lists change rarely
const _mobileMoneyCache = new Map(); // country -> { fetchedAt, operators, source }
const _bankListCache    = new Map(); // country -> { fetchedAt, banks, source }

const SNAPSHOT_VERIFIED_AT = '2026-07-24';

// Verified live 2026-07-24 via GET /merchant/api/v1/misc/mobile-money?countryCode=<CC>
// (public-key auth, read-only). min/max are Kora's own major-unit payout limits
// per mobile-money operator.
const MOBILE_MONEY_SNAPSHOT = {
  KE: [
    { slug: 'airtel-ke',    name: 'AIRTEL',        code: '0002',  min: 10, max: 150000 },
    { slug: 'equitel-ke',   name: 'EQUITEL',       code: '0003',  min: 10, max: 100000 },
    { slug: 'safaricom-ke', name: 'SAFARICOM',     code: '0001',  min: 10, max: 150000 },
    { slug: 't-kash-ke',    name: 'T-Kash',        code: '63907', min: 50, max: 200000 },
    { slug: 'telcom-ke',    name: 'Telcom Kenya',  code: '97',    min: 50, max: 200000 },
  ],
  GH: [
    { slug: 'airtel-gh',   name: 'AIRTEL',   code: '0005', min: 1, max: 50000 },
    { slug: 'mtn-gh',      name: 'MTN',      code: '0004', min: 1, max: 50000 },
    { slug: 'tigo-gh',     name: 'TIGO',     code: '0009', min: 1, max: 50000 },
    { slug: 'vodafone-gh', name: 'VODAFONE', code: '0006', min: 1, max: 50000 },
  ],
  CI: [
    { slug: 'moov-ci',   name: 'Moov',   code: 'MOOV_CI',   min: 2, max: 2000000 },
    { slug: 'mtn-ci',    name: 'MTN',    code: 'MTN_CI',    min: 2, max: 2000000 },
    { slug: 'orange-ci', name: 'Orange', code: 'ORANGE_CI', min: 2, max: 2000000 },
    { slug: 'wave-ci',   name: 'Wave',   code: 'WAVE_CI',   min: 2, max: 2000000 },
  ],
  CM: [
    { slug: 'mtn-cm',    name: 'MTN',    code: 'MTN_CM',    min: 2, max: 1000000 },
    { slug: 'orange-cm', name: 'Orange', code: 'ORANGE_CM', min: 2, max: 500000 },
  ],
  EG: [
    { slug: 'aman-eg',     name: 'Aman',     code: 'AMAN_EG',     min: 1, max: 30000 },
    { slug: 'etisalat-eg', name: 'Etisalat', code: 'ETISALAT_EG', min: 1, max: 30000 },
    { slug: 'orange-eg',   name: 'Orange',   code: 'ORANGE_EG',   min: 1, max: 30000 },
    { slug: 'vodafone-eg', name: 'Vodafone', code: 'VODAFONE_EG', min: 1, max: 30000 },
  ],
  TZ: [
    { slug: 'airtel-tz',   name: 'Airtel',   code: 'AIRTEL_TZ',   min: 1000, max: 5000000 },
    { slug: 'halopesa-tz', name: 'Halopesa', code: 'HALOPESA_TZ', min: 1000, max: 5000000 },
    { slug: 'tigo-tz',     name: 'Tigo',     code: 'TIGO_TZ',     min: 1000, max: 5000000 },
    { slug: 'vodacom-tz',  name: 'Vodacom',  code: 'VODACOM_TZ',  min: 1000, max: 5000000 },
  ],
};

// Phone-number format: Kora documents mobile-money numbers in full
// international format WITHOUT a leading '+' — every payout/pay-in test
// number in https://developers.korapay.com/docs/testing-your-integration
// follows this exact pattern for each corridor (verified against all listed
// examples for each country, both successful- and failed-payout rows).
const PHONE_FORMAT = {
  KE: { regex: /^254[17]\d{8}$/,  example: '254712345678',  digits: 12, hint: 'country code 254 + 9 digits, no leading 0 or +' },
  GH: { regex: /^233\d{9}$/,      example: '233241234567',  digits: 12, hint: 'country code 233 + 9 digits, no leading 0 or +' },
  CI: { regex: /^225\d{10}$/,     example: '2250512345678', digits: 13, hint: 'country code 225 + 10-digit local number (starting with 0), no +' },
  CM: { regex: /^237\d{9}$/,      example: '237671234567',  digits: 12, hint: 'country code 237 + 9 digits, no leading 0 or +' },
  EG: { regex: /^20\d{10}$/,      example: '201012345678',  digits: 12, hint: 'country code 20 + 10 digits, no leading 0 or +' },
  TZ: { regex: /^255\d{9}$/,      example: '255751234567',  digits: 12, hint: 'country code 255 + 9 digits, no leading 0 or +' },
};

// Bank-account NUMBER FORMAT sanity — these are national banking-format
// standards (e.g. Nigeria's CBN-mandated NUBAN is exactly 10 digits for
// every bank), NOT Kora-published amount limits. Kora's own List Banks API
// does not return per-bank amount limits (confirmed live 2026-07-24 — see
// probe results referenced in the delivery report), so bank_account corridors
// have no fabricated min/max here; Kora's own disburse-time validation is the
// backstop, and a rejection there is already handled as a safe, full refund
// (see isDefinitiveProviderRejection in payoutProviders.js).
const BANK_ACCOUNT_FORMAT = {
  NG: { regex: /^\d{10}$/,   example: '0123456789', description: '10-digit NUBAN account number' },
  KE: { regex: /^\d{5,17}$/, example: '0123456789',  description: '5-17 digit account number' },
  ZA: { regex: /^\d{6,11}$/, example: '123456789',   description: '6-11 digit account number' },
};

async function getMobileMoneyOperators(country) {
  const cached = _mobileMoneyCache.get(country);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  try {
    const live = await listKoraMobileMoneyOperators(country);
    if (Array.isArray(live) && live.length) {
      const entry = { fetchedAt: Date.now(), operators: live, source: 'live' };
      _mobileMoneyCache.set(country, entry);
      return entry;
    }
    throw new Error('Kora returned an empty mobile-money operator list');
  } catch (err) {
    if (cached) return cached; // stale-but-real cache beats a guess
    return {
      fetchedAt: Date.now(),
      operators: MOBILE_MONEY_SNAPSHOT[country] || [],
      source: `static-fallback (verified ${SNAPSHOT_VERIFIED_AT}; live fetch failed: ${err.message})`,
    };
  }
}

async function getBankList(country) {
  const cached = _bankListCache.get(country);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  try {
    const live = await listKoraBanks(country);
    if (Array.isArray(live) && live.length) {
      const entry = { fetchedAt: Date.now(), banks: live, source: 'live' };
      _bankListCache.set(country, entry);
      return entry;
    }
    throw new Error('Kora returned an empty bank list');
  } catch (err) {
    if (cached) return cached;
    // No static fallback for bank codes (283 NG entries alone — impractical
    // and unnecessary to hardcode). banks: null signals "unverifiable" to the
    // caller — validateKoraWithdrawalPreHold treats this as FAIL CLOSED
    // (PROVIDER_VALIDATION_UNAVAILABLE, reject before any hold), never as
    // permission to skip the whitelist check.
    return { fetchedAt: Date.now(), banks: null, source: `unavailable (live fetch failed: ${err.message})` };
  }
}

/**
 * Validates a Kora withdrawal request against real corridor rules BEFORE any
 * wallet hold/debit. Call this from POST /withdrawals immediately after
 * confirming payoutRouter(resolvedCountry) === 'kora' and the method/currency
 * combo is supported, and BEFORE entering withBalanceMutex / createWithdrawal.
 *
 * @param {object} opts
 * @param {string} opts.country     - ISO-2 country (resolvedCountry)
 * @param {string} opts.currency    - ISO currency code (e.g. 'XAF', 'KES')
 * @param {string} opts.method      - 'bank' | 'mobile'
 * @param {number} opts.amountMinor - EGWallet internal minor-unit integer amount
 * @param {string} opts.bankCode    - operator slug (mobile) or bank code (bank)
 * @param {string} opts.accountNumber - phone number (mobile) or account number (bank)
 * @returns {Promise<{ok:true}|{ok:false, code:string, error:string, min?:number, max?:number, source?:string}>}
 */
async function validateKoraWithdrawalPreHold({ country, currency, method, amountMinor, bankCode, accountNumber }) {
  const iso2 = (country || '').trim().toUpperCase();
  const curr = (currency || '').trim().toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL.has(curr);
  const majorAmount = toKoraAmount(amountMinor, curr);
  const acct = (accountNumber || '').trim();
  const code = (bankCode || '').trim();

  if (method === 'mobile') {
    const phoneRule = PHONE_FORMAT[iso2];
    if (phoneRule && !phoneRule.regex.test(acct)) {
      return {
        ok: false,
        code: 'INVALID_PHONE_FORMAT',
        error: `Mobile money number must be ${phoneRule.digits} digits in the format ${phoneRule.example} (${phoneRule.hint}).`,
      };
    }

    if (!code) {
      return { ok: false, code: 'UNSUPPORTED_OPERATOR', error: 'A mobile money operator is required.' };
    }

    const { operators, source } = await getMobileMoneyOperators(iso2);
    if (!Array.isArray(operators) || operators.length === 0) {
      // FAIL CLOSED: no live list, no usable cache, and no verified snapshot
      // for this corridor. We will NEVER submit an unverified operator as a
      // guess — reject before any wallet hold, with a clear, safely-retryable
      // error. The request can simply be resubmitted once Kora is reachable.
      return {
        ok: false,
        code: 'PROVIDER_VALIDATION_UNAVAILABLE',
        error: `We could not verify mobile money operators for ${iso2} right now. Please try again in a few minutes.`,
        source,
      };
    }
    const op = operators.find(o => o.slug === code || o.code === code);
    if (!op) {
      return {
        ok: false,
        code: 'UNSUPPORTED_OPERATOR',
        error: `"${code}" is not a recognized mobile money operator for ${iso2}. Please choose one from the official list.`,
        source,
      };
    }

    if (typeof op.min === 'number' && majorAmount < op.min) {
      return {
        ok: false,
        code: 'BELOW_MINIMUM',
        error: `The minimum withdrawal for ${op.name} is ${op.min} ${curr}. You requested ${majorAmount} ${curr}.`,
        min: op.min, max: op.max, source,
      };
    }
    if (typeof op.max === 'number' && majorAmount > op.max) {
      return {
        ok: false,
        code: 'ABOVE_MAXIMUM',
        error: `The maximum withdrawal for ${op.name} is ${op.max} ${curr}. You requested ${majorAmount} ${curr}.`,
        min: op.min, max: op.max, source,
      };
    }
  } else if (method === 'bank') {
    const acctRule = BANK_ACCOUNT_FORMAT[iso2];
    if (acctRule && !acctRule.regex.test(acct)) {
      return {
        ok: false,
        code: 'INVALID_ACCOUNT_FORMAT',
        error: `Account number must be a ${acctRule.description} (e.g. ${acctRule.example}).`,
      };
    }

    if (!code) {
      return { ok: false, code: 'UNSUPPORTED_BANK', error: 'A bank is required.' };
    }

    const { banks, source } = await getBankList(iso2);
    if (!banks) {
      // FAIL CLOSED: live fetch failed AND there is no usable cache (there is
      // no static snapshot for bank codes — see getBankList's comment). We
      // will NEVER submit an unverified bank code as a fallback and rely on
      // Kora's disburse-time rejection to catch it after funds are already
      // held. Reject here, before any wallet hold, with a clear, safely
      // retryable error.
      return {
        ok: false,
        code: 'PROVIDER_VALIDATION_UNAVAILABLE',
        error: `We could not verify bank details for ${iso2} right now. Please try again in a few minutes.`,
        source,
      };
    }
    const bank = banks.find(b => b.code === code || b.slug === code);
    if (!bank) {
      return {
        ok: false,
        code: 'UNSUPPORTED_BANK',
        error: `"${code}" is not a recognized bank code for ${iso2}. Please choose one from the official list.`,
        source,
      };
    }
  }

  // XAF/XOF: Kora only accepts payout amounts in multiples of 5 major units
  // (https://developers.korapay.com/docs/payout-via-api). Previously only
  // enforced at dispatch time inside koraPayout() — enforcing it here means
  // this class of request never enters holdBalance at all.
  if (isZeroDecimal && majorAmount % 5 !== 0) {
    return {
      ok: false,
      code: 'INVALID_AMOUNT_PRECISION',
      error: `${curr} withdrawal amounts must be a whole multiple of 5 ${curr} (requested ${majorAmount} ${curr}).`,
    };
  }

  return { ok: true };
}

module.exports = {
  validateKoraWithdrawalPreHold,
  getMobileMoneyOperators,
  getBankList,
  PHONE_FORMAT,
  BANK_ACCOUNT_FORMAT,
  MOBILE_MONEY_SNAPSHOT,
  SNAPSHOT_VERIFIED_AT,
  // Exposed for tests — allows clearing the in-memory cache between test cases.
  _test: {
    clearCaches() { _mobileMoneyCache.clear(); _bankListCache.clear(); },
  },
};
