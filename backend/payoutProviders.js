'use strict';
/**
 * payoutProviders.js
 * Handles real money movement via Stripe (international) and Kora (African).
 *
 * Entry point: executePayout(withdrawalId, logger, withBalanceMutex)
 *   — called asynchronously from index.js AFTER the HTTP response is sent.
 *   — loads a fresh DB, calls the right provider, marks paid or failed.
 *
 * Provider routing:
 *   Kora-confirmed corridors (exactly 8 countries — see KORA_COUNTRIES below:
 *     NG, KE, ZA, GH, CI, CM, EG, TZ) → Kora
 *   Countries explicitly approved for Stripe Connect (STRIPE_CONNECT_ENABLED=
 *     true AND listed in STRIPE_CONNECT_APPROVED_COUNTRIES — see
 *     stripeConnect.js for the compliance gate this sits behind) → Stripe
 *     Connect (per-user Express connected account + Transfer/Payout).
 *   EVERY OTHER COUNTRY — including Equatorial Guinea/XAF, Senegal/XOF (share
 *   a currency with a Kora corridor but are not themselves Kora-supported),
 *   and the US/UK/EU before Stripe Connect is approved for them — → null.
 *   payoutRouter() returning null means "no safe provider for this country
 *   right now"; callers MUST fail the request with COUNTRY_NOT_SUPPORTED and
 *   MUST NOT fall through to the legacy single-account Stripe payout path
 *   (stripePayout below). That legacy function is kept only so
 *   executePayout() can still dispatch/reconcile any pre-existing withdrawal
 *   record whose stored `provider` field is literally 'stripe' from before
 *   this corridor was locked down — payoutRouter() itself never hands out
 *   'stripe' for new routing decisions.
 *
 * PRODUCTION NOTES:
 *   Stripe:  Requires funds in your Stripe balance and an External Account
 *            (bank or debit card) registered on the connected account.
 *            For custom bank-to-bank disbursements, use Stripe Connect.
 *   Kora:    Live-mode credentials required for production:
 *              KORA_LIVE_PUBLIC_KEY      — pk_live_… (used for /misc/* utility
 *                                          endpoints: List Banks, List Mobile
 *                                          Money Operators, account resolution —
 *                                          confirmed live, the secret key gets
 *                                          401 on these)
 *              KORA_LIVE_SECRET_KEY      — sk_live_… (Bearer auth for the
 *                                          transactional endpoints: disburse,
 *                                          payout history, webhook signing)
 *              KORA_LIVE_ENCRYPTION_KEY  — optional AES-256-GCM key; when set, the
 *                                          disbursement payload is encrypted into
 *                                          `encrypted_data` per Kora's payload-encryption spec.
 *            Legacy KORA_API_KEY (single key) is still honoured as a fallback for
 *            KORA_LIVE_SECRET_KEY so existing deployments keep working unchanged.
 *            Kora currently covers exactly NG, KE, ZA, GH, CI, CM, EG, TZ for
 *            this account — see the KORA_COUNTRIES comment for full evidence.
 *
 *            Kora does NOT issue a separate webhook-signing secret. Per
 *            https://developers.korapay.com/docs/webhooks ("Verifying a Webhook
 *            Request"), the x-korapay-signature header is an HMAC-SHA256 of the
 *            `data` object, signed with the same Secret Key used for API auth.
 *            There is no dashboard step that generates a distinct webhook secret —
 *            only the webhook URL is configured (Settings → API Configuration →
 *            Notification URLs). See verifyKoraWebhookSignature() below.
 */

const axios    = require('axios');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { decryptPII } = require('./piiCipher');
const {
  isStripeConnectEnabled,
  isCountryStripeConnectApproved,
  stripeConnectPayout,
} = require('./stripeConnect');

// ─── Stripe client ────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient      = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ─── Kora live credentials ────────────────────────────────────────────────────
// Read live-mode dashboard values directly.  KORA_API_KEY (legacy single-key
// deployments) is honoured as a fallback for the secret key so existing
// production configs keep working unchanged after this rollout.
function getKoraSecretKey() {
  return process.env.KORA_LIVE_SECRET_KEY || process.env.KORA_API_KEY || null;
}
function getKoraPublicKey() {
  return process.env.KORA_LIVE_PUBLIC_KEY || null;
}
function getKoraEncryptionKey() {
  return process.env.KORA_LIVE_ENCRYPTION_KEY || null;
}

/**
 * Encrypts a disbursement payload per Kora's optional payload-encryption spec:
 * AES-256-GCM, hex-encoded `iv:ciphertext:authTag`, sent as { encrypted_data }.
 * Mirrors Kora's own reference implementation exactly so encryption is
 * interoperable with their decryptor: https://developers.korapay.com/docs/payout-via-api
 *
 * @param  {string} encryptionKey - value of KORA_LIVE_ENCRYPTION_KEY
 * @param  {object} payload       - plain disbursement request body
 * @returns {string} "<ivHex>:<cipherHex>:<tagHex>"
 */
function encryptKoraPayload(encryptionKey, payload) {
  const paymentData = JSON.stringify(payload);
  const iv           = crypto.randomBytes(16);
  const cipher        = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted      = cipher.update(paymentData);
  const ivToHex        = iv.toString('hex');
  const encryptedToHex = Buffer.concat([encrypted, cipher.final()]).toString('hex');
  return `${ivToHex}:${encryptedToHex}:${cipher.getAuthTag().toString('hex')}`;
}

/**
 * Verifies a Kora webhook's `x-korapay-signature` header.
 *
 * Per https://developers.korapay.com/docs/webhooks, Kora does NOT issue a
 * separate webhook secret — the signature is an HMAC-SHA256 of ONLY the `data`
 * object in the payload, signed with the same Secret Key used for API auth:
 *   hash = HMAC_SHA256(secretKey, JSON.stringify(payload.data))
 *
 * @param  {string} secretKey     - value from getKoraSecretKey()
 * @param  {object} data          - the `data` field of the parsed webhook body
 * @param  {string} signatureHex  - value of the x-korapay-signature header
 * @returns {boolean}
 */
function verifyKoraWebhookSignature(secretKey, data, signatureHex) {
  if (!secretKey || !signatureHex) return false;
  const expected = crypto.createHmac('sha256', secretKey)
    .update(JSON.stringify(data || {}))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHex, 'hex'),
      Buffer.from(expected,     'hex')
    );
  } catch (_) {
    return false; // length mismatch / invalid hex → not equal
  }
}

// ─── Engine functions (imported to avoid re-importing db helpers) ─────────────
const { markWithdrawalPaid, markWithdrawalFailed } = require('./withdrawalEngine');
const {
  commitWithdrawalTransitionPostgres,
  commitWithdrawalStateUpdate,
  upsertPayoutLockPostgres,
  releasePayoutLockPostgres,
} = require('./db/withdrawalsPostgres');
const { loadAppState, saveAppState } = require('./db/appStateStore');

async function persistWithdrawalById(state, withdrawalId, expectedStatus) {
  return commitWithdrawalStateUpdate(
    state,
    (state.withdrawals || []).find((x) => x.id === withdrawalId),
    expectedStatus
  );
}

// ─── Currency helpers ─────────────────────────────────────────────────────────
// Currencies where the smallest unit IS the major unit (no cents/pence).
const ZERO_DECIMAL = new Set([
  'XAF', 'XOF', 'BIF', 'GNF', 'KMF', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XPF', 'JPY', 'KRW', 'CLP',
]);

/**
 * Convert EGWallet internal (minor unit) amount to the provider's expected unit.
 * Stripe: minor units (cents) for non-zero-decimal; major units for zero-decimal.
 * Kora:   always major units.
 */
function toStripeAmount(amount, currency) {
  // Stripe already expects minor units for non-zero-decimal, and natural units
  // for zero-decimal — which is exactly how EGWallet stores amounts.
  return Math.round(amount);
}

function toKoraAmount(amount, currency) {
  // Kora expects major units for all currencies.
  if (ZERO_DECIMAL.has((currency || '').toUpperCase())) return Math.round(amount);
  return parseFloat((amount / 100).toFixed(2));
}

// ─── Provider routing ─────────────────────────────────────────────────────────
// IMPORTANT — Kora corridor support is per-COUNTRY, not per-currency-zone.
// Sharing a currency (e.g. the XAF/XOF CFA-franc zones, each shared by 6-8
// countries) does NOT imply Kora supports payouts to every country in that
// zone. Per https://developers.korapay.com/docs/send-payments ("Currently,
// Kora's Payout API supports Payouts to…") and confirmed live against our own
// account (2026-07-22 — see backend/scripts/kora-cm-mobile-money-probe.js),
// Kora's Payout API currently supports exactly these 8 countries/corridors:
//
//   NG (NGN) — bank_account only
//   KE (KES) — bank_account AND mobile_money
//   ZA (ZAR) — bank_account only
//   GH (GHS) — mobile_money only
//   CI (XOF) — mobile_money only  (the ONLY XOF-zone country Kora supports —
//                                  NOT Senegal, Benin, Mali, Togo, etc.)
//   CM (XAF) — mobile_money only  (the ONLY XAF-zone country Kora supports —
//                                  NOT Equatorial Guinea, Gabon, Chad, Congo,
//                                  Central African Republic, etc. Confirmed
//                                  live: GET .../misc/mobile-money?countryCode=CM
//                                  returns MTN/Orange operators; GET
//                                  .../misc/payout-countries-by-currency-code/XAF
//                                  returns an EMPTY bank-country list.)
//   EG (EGP) — mobile_money only
//   TZ (TZS) — mobile_money only
//
// US (USD) and GB (GBP) also have a documented Kora bank_account corridor, but
// it requires a materially different payload (bank_country, beneficiary_type,
// address_information, supporting_documents, routing/SWIFT, purpose_of_payment)
// that this integration does not implement — those withdrawals continue to
// route to Stripe unchanged (see "remaining dependencies" in the delivery
// report). This is a deliberate, documented scope decision, not an oversight.
//
// Equatorial Guinea (GQ) is EGWallet's home market and remains fully usable
// for in-app/internal wallet balances, but it is NOT a Kora payout corridor —
// GQ must never be routed to Kora, and per requirement #2 below it must also
// never silently fall through to Stripe (Stripe has no African bank/mobile
// payout corridor either) — it fails safely with a clear message instead.
const KORA_COUNTRIES = new Set(['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ']);

// Countries previously (incorrectly) treated as Kora corridors purely because
// they share a currency with a real corridor (the CFA-franc zones) or sit in
// the same broad African-market bucket. None of these are documented or
// probe-confirmed Kora payout destinations. Routing them to Stripe would be
// silently wrong (Stripe has no local bank/mobile-money corridor for them
// either) — payoutRouter() returns null for these so callers can fail safely
// with an explicit "not supported" message instead of mis-routing.
const KORA_UNSUPPORTED_COUNTRIES = new Set([
  // XAF zone (Central Africa CFA franc) — everyone except Cameroon
  'CF', 'TD', 'CG', 'GQ', 'GA',
  // XOF zone (West Africa CFA franc) — everyone except Ivory Coast
  'BJ', 'BF', 'GW', 'ML', 'NE', 'SN', 'TG',
  // Other African countries with no documented/confirmed Kora payout corridor
  'UG', 'RW', 'ET', 'ZM', 'ZW', 'MZ', 'AO', 'NA', 'BW', 'MW', 'LS',
  'SZ', 'MG', 'MU', 'SC', 'DZ', 'MA', 'TN', 'LY', 'SD',
  'SL', 'LR', 'GM', 'MR', 'DJ', 'ER', 'SO',
]);

/**
 * Resolves the payout provider for a country.
 *
 * 'stripe_connect' is only ever returned when BOTH STRIPE_CONNECT_ENABLED=true
 * AND the country appears in STRIPE_CONNECT_APPROVED_COUNTRIES (see the
 * compliance note atop stripeConnect.js — this must stay off until Stripe has
 * explicitly approved EGWallet's business model for Connect).
 *
 * Every country that is neither a Kora-confirmed corridor nor an explicitly
 * Stripe-Connect-approved corridor returns null — including the US, UK, and
 * all of Europe while Stripe Connect remains disabled/unapproved. There is
 * NO legacy single-account Stripe fallback for new routing decisions: a
 * country either has an explicit, verified corridor or it is unsupported.
 * Callers MUST turn a null result into a COUNTRY_NOT_SUPPORTED error before
 * any debit — never silently fall through to stripePayout().
 *
 * @returns {'kora'|'stripe_connect'|null} null means "no safe provider" —
 *   the caller MUST fail the request with a clear message.
 */
function payoutRouter(country) {
  if (!country) return null;
  const iso2 = country.trim().toUpperCase();
  if (KORA_COUNTRIES.has(iso2)) return 'kora';
  if (isCountryStripeConnectApproved(iso2)) return 'stripe_connect';
  return null;
}

// Canonical country for each Kora-supported currency — used for the
// resolveWithdrawalCountry() fallback and for the mobile app's bank/operator
// list & resolution endpoints. Each of these currencies now maps to EXACTLY
// ONE Kora-confirmed country (unlike the old currency-zone assumption).
const KORA_CURRENCY_TO_COUNTRY = {
  NGN: 'NG', KES: 'KE', ZAR: 'ZA', GHS: 'GH', XOF: 'CI', XAF: 'CM', EGP: 'EG', TZS: 'TZ',
};

// ─── Kora Payout API corridor support ────────────────────────────────────────
// Per https://developers.korapay.com/docs/send-payments ("Currently, Kora's
// Payout API supports Payouts to…"), bank_account and mobile_money destinations
// are each supported ONLY for a specific set of currencies. Cameroon (XAF) has
// NO bank_account payout support on Kora — it is mobile-money-only (MTN/Orange).
// These sets gate koraPayout() so an unsupported combination is rejected
// up-front instead of being submitted to Kora and failing there.
// NOTE: USD/GBP bank_account is a real Kora corridor but is intentionally NOT
// included here — see the KORA_COUNTRIES comment above; USD/GBP withdrawals
// route to Stripe, not Kora, in this integration.
const KORA_BANK_ACCOUNT_CURRENCIES   = new Set(['NGN', 'KES', 'ZAR']);
const KORA_MOBILE_MONEY_CURRENCIES   = new Set(['KES', 'GHS', 'XOF', 'XAF', 'EGP', 'TZS']);

function isKoraBankAccountSupported(currency) {
  return KORA_BANK_ACCOUNT_CURRENCIES.has((currency || '').toUpperCase());
}
function isKoraMobileMoneySupported(currency) {
  return KORA_MOBILE_MONEY_CURRENCIES.has((currency || '').toUpperCase());
}

// Country-level equivalents of the currency checks above — used by the
// /payout/banks and /payout/mobile-money-operators endpoints, which receive a
// country (not a currency) from the mobile app.
const KORA_BANK_ACCOUNT_COUNTRIES = new Set(['NG', 'KE', 'ZA']);
function isKoraBankAccountCountry(country) {
  return KORA_BANK_ACCOUNT_COUNTRIES.has((country || '').toUpperCase());
}

// Corridors where Kora officially documents pre-submission beneficiary
// resolution (https://developers.korapay.com/docs/payout-via-api, "Verify the
// destination bank account" / "Mobile Money account verification"):
//   • Bank account resolve  → Nigeria, Kenya only
//   • Mobile money resolve  → Ghana only (Ghanaian MMO codes are numeric,
//     matching the endpoint's required `mobileMoneyCode` pattern; Cameroon's
//     and Ivory Coast's operator codes — e.g. MTN_CM, ORANGE_CM — are NOT
//     numeric and are rejected by Kora's own validation, confirmed live.)
// Callers (mobile app + /payout/resolve-account) must only attempt resolution
// for these corridors and require manual user confirmation everywhere else —
// never fabricate a beneficiary name.
const KORA_BANK_RESOLUTION_COUNTRIES   = new Set(['NG', 'KE']);
const KORA_MOBILE_RESOLUTION_COUNTRIES = new Set(['GH']);

function isKoraBankResolutionSupported(country) {
  return KORA_BANK_RESOLUTION_COUNTRIES.has((country || '').toUpperCase());
}
function isKoraMobileResolutionSupported(country) {
  return KORA_MOBILE_RESOLUTION_COUNTRIES.has((country || '').toUpperCase());
}

// ─── Country normalization ────────────────────────────────────────────────────
// Maps free-text country names (as historically accepted from mobile-app free
// text fields) to ISO-2 codes. Payout routing must NEVER match on free text —
// this map is the only bridge, and anything not found here returns null so the
// caller cannot silently mis-route a withdrawal.
const COUNTRY_NAME_TO_ISO2 = {
  cameroon: 'CM', nigeria: 'NG', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA',
  senegal: 'SN', 'ivory coast': 'CI', "cote d'ivoire": 'CI', "côte d'ivoire": 'CI',
  benin: 'BJ', 'burkina faso': 'BF', 'guinea-bissau': 'GW', mali: 'ML', niger: 'NE',
  togo: 'TG', 'central african republic': 'CF', chad: 'TD', congo: 'CG',
  'equatorial guinea': 'GQ', gabon: 'GA', tanzania: 'TZ', uganda: 'UG', rwanda: 'RW',
  ethiopia: 'ET', zambia: 'ZM', zimbabwe: 'ZW', mozambique: 'MZ', angola: 'AO',
  namibia: 'NA', botswana: 'BW', malawi: 'MW', lesotho: 'LS', eswatini: 'SZ',
  swaziland: 'SZ', madagascar: 'MG', mauritius: 'MU', seychelles: 'SC', algeria: 'DZ',
  morocco: 'MA', tunisia: 'TN', libya: 'LY', egypt: 'EG', sudan: 'SD',
  'sierra leone': 'SL', liberia: 'LR', gambia: 'GM', mauritania: 'MR', djibouti: 'DJ',
  eritrea: 'ER', somalia: 'SO',
  'united states': 'US', 'united kingdom': 'GB', 'great britain': 'GB',
};

/**
 * Normalizes a country input (ISO-2 code OR a recognized free-text country
 * name) to a canonical uppercase ISO-2 code. Returns null when the input
 * cannot be confidently resolved — callers must treat null as "unknown",
 * never guess a provider from it.
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
function normalizeCountryToISO2(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_NAME_TO_ISO2[trimmed.toLowerCase()] || null;
}

/**
 * Resolves the ISO-2 country to use for payout routing on a withdrawal
 * request. Never relies on free-text matching for routing decisions:
 *   1. Explicit `country` input is normalized via normalizeCountryToISO2().
 *   2. If not supplied/unrecognized, falls back to the user's own signup
 *      `region` (already ISO-2, captured at account creation) — this is the
 *      authoritative source for the mobile app's *local* withdrawal path,
 *      which never asks the user for a country at all.
 *   3. Last resort: XAF is, for this wallet's current user base, effectively
 *      single-country (Cameroon) — default to CM rather than leaving the
 *      withdrawal unroutable.
 * @param {{country?: string|null, userRegion?: string|null, currency: string}} opts
 * @returns {string|null}
 */
function resolveWithdrawalCountry({ country, userRegion, currency }) {
  const explicit = normalizeCountryToISO2(country);
  if (explicit) return explicit;
  const region = normalizeCountryToISO2(userRegion);
  if (region) return region;
  // Each Kora-supported currency now maps to exactly one confirmed Kora
  // country (see KORA_CURRENCY_TO_COUNTRY) — safe to default on currency
  // alone only for these, never for a currency shared by unsupported
  // neighbours without a real per-country signal.
  const byCurrency = KORA_CURRENCY_TO_COUNTRY[(currency || '').toUpperCase()];
  if (byCurrency) return byCurrency;
  return null;
}

// ─── Kora payout utility APIs (List Banks / List MMO / Resolve) ─────────────
// https://developers.korapay.com/docs/payout-utilities and
// https://developers.korapay.com/docs/payout-via-api ("1 - Find bank codes…",
// "2 - Verify the destination bank account").
const KORA_BASE_URL = 'https://api.korapay.com';

async function koraMiscRequest(method, path, { params, data } = {}) {
  // IMPORTANT: Kora's /misc/* utility endpoints (List Banks, List Mobile Money
  // Operators, Payout Countries by Currency, and both Resolve endpoints)
  // authenticate with the PUBLIC key, NOT the secret key — confirmed live
  // against our own account: the secret key gets a 401 "Invalid authentication
  // token" on every /misc/* call, while the same call succeeds with the public
  // key. This is different from the transactional endpoints (disburse, payout
  // history, webhooks), which correctly use the secret key elsewhere in this
  // file. Falls back to the secret key only if no public key is configured, so
  // a misconfigured deployment still gets a clear Kora-side error rather than
  // a silent no-op.
  const koraKey = getKoraPublicKey() || getKoraSecretKey();
  if (!koraKey) {
    const err = new Error('Kora is not configured — KORA_LIVE_PUBLIC_KEY is missing');
    err.status = 503;
    throw err;
  }
  const headers = { Authorization: `Bearer ${koraKey}`, 'Content-Type': 'application/json' };
  const url = `${KORA_BASE_URL}${path}`;
  let response;
  try {
    // Uses axios.get/axios.post (rather than calling axios(config) directly) so
    // these calls can be unit-tested by substituting the method on the shared
    // axios module — see __tests__/kora-cameroon-xaf.test.js.
    response = method === 'get'
      ? await axios.get(url, { params, headers, timeout: 15_000 })
      : await axios.post(url, data, { headers, timeout: 15_000 });
  } catch (err) {
    const koraMsg = err.response?.data?.message || err.message;
    const wrapped = new Error(`Kora API error: ${koraMsg}`);
    wrapped.status = err.response?.status || 502;
    throw wrapped;
  }
  if (!response.data || response.data.status !== true) {
    const err = new Error(response.data?.message || 'Kora request did not succeed');
    err.status = 502;
    throw err;
  }
  return response.data.data;
}

/** List Kora's official bank codes for a country (bank_account currencies only: NG, KE, ZA, …). */
async function listKoraBanks(countryCode) {
  return koraMiscRequest('get', '/merchant/api/v1/misc/banks', { params: { countryCode } });
}

/** List Kora's official mobile-money operator slugs for a country (e.g. CM → mtn-cm, orange-cm). */
async function listKoraMobileMoneyOperators(countryCode) {
  return koraMiscRequest('get', '/merchant/api/v1/misc/mobile-money', { params: { countryCode } });
}

/**
 * Resolves/verifies a bank account before payout. Per Kora's docs this is
 * currently only documented as supported for Nigerian and Kenyan banks —
 * callers must surface Kora's own error rather than fabricate a name for
 * unsupported corridors.
 */
async function resolveKoraBankAccount({ bank, account, currency }) {
  return koraMiscRequest('post', '/merchant/api/v1/misc/banks/resolve', { data: { bank, account, currency } });
}

/**
 * Resolves/verifies a mobile-money account before payout. Kora's docs
 * explicitly document this for Ghanaian mobile-money networks; other
 * corridors (including Cameroon) are called through the same endpoint but
 * Kora's own response determines support — callers must not assume success.
 */
async function resolveKoraMobileMoneyAccount({ mobileMoneyCode, phoneNumber, currency }) {
  return koraMiscRequest('post', '/merchant/api/v1/misc/mobile-money/resolve', { data: { mobileMoneyCode, phoneNumber, currency } });
}

/**
 * Returns true when the payout provider for `country` is configured and can
 * disburse real funds.  Used by POST /withdrawals to reject requests before
 * funds enter holdBalance when no provider is available.
 */
function isPayoutProviderReady(country) {
  const provider = payoutRouter(country);
  if (provider === 'kora') {
    return !!getKoraSecretKey();
  }
  if (provider === 'stripe_connect') {
    // Corridor-level readiness only (flag on, country approved, Stripe client
    // configured). Whether THIS user's own connected account has finished
    // onboarding is a per-user check made later in stripeConnectPayout() at
    // dispatch time — same two-layer pattern as Kora (secret key present vs.
    // corridor/method support checked deeper in koraPayout()).
    return isStripeConnectEnabled();
  }
  // provider === null — no explicit, verified corridor for this country
  // (unsupported country, or a real corridor Stripe/Kora hasn't approved
  // yet). Never treat this as "ready" just because a Stripe key happens to
  // be configured for something else — that would silently resurrect the
  // legacy single-account Stripe fallback this routing rule exists to close.
  return false;
}

// ─── Stripe payout ────────────────────────────────────────────────────────────
/**
 * Executes a payout via Stripe.
 *
 * Uses stripe.payouts.create() for debit card instant payouts,
 * and stripe.payouts.create() standard for bank accounts.
 *
 * Production requirements:
 *   • Funds must be in the Stripe connected account's balance.
 *   • Destination must be a registered External Account on that account.
 *   • For arbitrary user bank accounts, requires Stripe Connect setup.
 *
 * @param   {object} w       - withdrawal record
 * @param   {object} logger
 * @returns {{ provider, reference, raw }}
 */
async function stripePayout(w, logger) {
  if (!stripeClient) {
    throw new Error('Stripe is not configured — STRIPE_SECRET_KEY is missing');
  }

  // Two env vars are required before Stripe payouts are enabled:
  //   STRIPE_CONNECT_READY=true   — operator confirms Connect integration is complete
  //   STRIPE_CONNECT_ACCOUNT      — the connected account ID (acct_xxx) that holds the
  //                                 user's external bank account as a payout destination
  //
  // STRIPE_CONNECT_READY alone is NOT sufficient: stripe.payouts.create() without a
  // destination routes funds to the platform's default external account, not the user's
  // bank — permanent user fund loss.  Both guards must be satisfied before any HTTP call.
  if (!process.env.STRIPE_CONNECT_READY) {
    throw new Error('Stripe payout destination not configured — set STRIPE_CONNECT_READY=true once Stripe Connect is wired');
  }
  if (!process.env.STRIPE_CONNECT_ACCOUNT) {
    throw new Error('Stripe Connect account not configured — set STRIPE_CONNECT_ACCOUNT=acct_xxx to specify the payout destination');
  }

  const currency  = w.currency.toLowerCase();
  const amount    = toStripeAmount(w.netPayout, w.currency);
  const isInstant = w.method === 'debit';          // debit card supports instant
  const method    = isInstant ? 'instant' : 'standard';

  logger.info('[Stripe] Creating payout', {
    withdrawalId: w.id,
    amount,
    currency,
    method,
  });

  // Pass egw-<id> as idempotency key: Stripe returns the same payout object for
  // the same key within 24 h, so a blind retry after a timeout cannot double-disburse.
  // destination routes the payout to the user's external account on the connected
  // account rather than the platform's default external account.
  const payout = await stripeClient.payouts.create(
    {
      amount,
      currency,
      method,
      destination:  process.env.STRIPE_CONNECT_ACCOUNT,
      description:  `EGWallet withdrawal ${w.id}`,
      metadata: {
        withdrawalId: w.id,
        userId:       w.userId,
      },
    },
    { idempotencyKey: `egw-${w.id}` }
  );

  logger.info('[Stripe] Payout created', {
    withdrawalId: w.id,
    payoutId:     payout.id,
    status:       payout.status,
    arrival:      payout.arrival_date,
  });

  // Stripe payout statuses: paid | pending | in_transit | canceled | failed
  // C4 fix: only treat "paid" as settled. pending/in_transit means submitted to bank
  // but not confirmed — withdrawal must stay in "processing" until webhook/admin confirms.
  if (payout.status === 'failed' || payout.status === 'canceled') {
    throw new Error(`Stripe payout ${payout.id} status: ${payout.status}`);
  }

  const settled = payout.status === 'paid';
  if (!settled) {
    logger.info('[Stripe] Payout submitted but not yet settled — withdrawal stays processing', {
      withdrawalId: w.id,
      payoutId:     payout.id,
      status:       payout.status,
      arrival_date: payout.arrival_date,
    });
  }

  return {
    provider:  'stripe',
    reference: payout.id,
    settled,
    raw: {
      id:           payout.id,
      status:       payout.status,
      arrival_date: payout.arrival_date,
      method:       payout.method,
    },
  };
}

// ─── Kora payout ─────────────────────────────────────────────────────────────
/**
 * Executes a bank transfer via the Kora Disbursement API.
 *
 * API: POST https://api.korapay.com/merchant/api/v1/transactions/disburse
 * Auth: Authorization: Bearer {KORA_LIVE_SECRET_KEY}
 *
 * When KORA_LIVE_ENCRYPTION_KEY is set, the payload is AES-256-GCM encrypted
 * and sent as { encrypted_data } per Kora's optional payload-encryption spec —
 * otherwise the plain JSON payload is sent (both are accepted by Kora).
 *
 * Amounts are in major currency units (e.g. 1000 = 1000 XAF / 1000 NGN).
 *
 * @param   {object} w       - withdrawal record
 * @param   {object} logger
 * @returns {{ provider, reference, raw }}
 */
async function koraPayout(w, logger) {
  const koraSecretKey = getKoraSecretKey();
  if (!koraSecretKey) {
    throw new Error('Kora is not configured — KORA_LIVE_SECRET_KEY is missing');
  }

  const currency = (w.currency || '').toUpperCase();
  const amount    = toKoraAmount(w.netPayout, w.currency);
  const reference = `egw-${w.id}`;
  const destinationType = w.method === 'mobile' ? 'mobile_money' : 'bank_account';

  // ── Corridor guards — fail fast (definitive rejection → immediate refund)
  // instead of submitting a request Kora is guaranteed to reject. Cameroon
  // (XAF) is mobile-money-only on Kora: bank_account is NOT supported there.
  // https://developers.korapay.com/docs/send-payments
  if (destinationType === 'bank_account' && !isKoraBankAccountSupported(currency)) {
    const err = new Error(
      `Kora does not support bank-account payouts in ${currency}. This corridor requires the mobile-money withdrawal method.`
    );
    err._definitiveRejection = true;
    throw err;
  }
  if (destinationType === 'mobile_money' && !isKoraMobileMoneySupported(currency)) {
    const err = new Error(`Kora does not support mobile-money payouts in ${currency}.`);
    err._definitiveRejection = true;
    throw err;
  }

  // Kora only accepts XAF/XOF payout amounts in multiples of 5 — reject
  // up-front rather than hold funds against a disbursement Kora will refuse.
  // https://developers.korapay.com/docs/payout-via-api
  if ((currency === 'XAF' || currency === 'XOF') && amount % 5 !== 0) {
    const err = new Error(
      `Kora requires ${currency} payout amounts to be a multiple of 5 (net payout was ${amount} ${currency}).`
    );
    err._definitiveRejection = true;
    throw err;
  }

  // Decrypt PII fields — they are AES-256-GCM encrypted at rest.
  // decryptPII() is a no-op passthrough for any unencrypted legacy value.
  const plainAccount = decryptPII(w.accountNumber)     || '';
  const plainHolder  = decryptPII(w.accountHolderName) || '';
  const plainBank    = decryptPII(w.bankName)           || '';

  // Kora's disburse API documents a required destination.customer.email —
  // https://developers.korapay.com/docs/payout-via-api
  const db   = loadAppState();
  const user = (db.users || []).find(u => u.id === w.userId);

  const destination = {
    type:      destinationType,
    amount,
    currency:  w.currency,
    narration: `EGWallet withdrawal`,
    customer: {
      name:  plainHolder || undefined,
      email: user?.email || undefined,
    },
  };

  if (destinationType === 'mobile_money') {
    // Mobile money has no "bank" concept — the app's bankCode field carries
    // the Kora operator slug (e.g. "mtn-cm" / "orange-cm") selected from
    // GET /payout/mobile-money-operators, and accountNumber carries the phone number.
    if (!w.bankCode) {
      const err = new Error('Mobile money payout is missing the mobile money operator (bankCode).');
      err._definitiveRejection = true;
      throw err;
    }
    destination.mobile_money = {
      operator:      w.bankCode,
      mobile_number: plainAccount,
    };
  } else {
    destination.bank_account = {
      bank:         w.bankCode || plainBank,
      account:      plainAccount,
      account_name: plainHolder,
    };
  }

  const payload = { reference, destination };

  const koraEncryptionKey = getKoraEncryptionKey();
  const requestBody       = koraEncryptionKey
    ? { encrypted_data: encryptKoraPayload(koraEncryptionKey, payload) }
    : payload;

  logger.info('[Kora] Initiating disbursement', {
    withdrawalId: w.id,
    reference,
    amount,
    currency: w.currency,
    destinationType,
    bank:      destinationType === 'bank_account' ? destination.bank_account.bank     : undefined,
    operator:  destinationType === 'mobile_money' ? destination.mobile_money.operator : undefined,
    encrypted: !!koraEncryptionKey,
  });

  let response;
  try {
    response = await axios.post(
      'https://api.korapay.com/merchant/api/v1/transactions/disburse',
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${koraSecretKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );
  } catch (err) {
    // Axios throws on non-2xx; pull message from Kora's error body if present.
    // Preserve err.response on the re-thrown Error so isDefinitiveProviderRejection
    // can inspect the HTTP status — a plain `new Error(string)` drops that metadata
    // and would cause the failure path to treat every Kora 4xx as ambiguous.
    const koraMsg   = err.response?.data?.message || err.message;
    const wrapped   = new Error(`Kora API error: ${koraMsg}`);
    wrapped.response = err.response;   // keep Axios response for 4xx status check
    throw wrapped;
  }

  const body = response.data;

  // Log only safe scalar fields — never the raw body.data object which can
  // contain bank account numbers, phone numbers, or other payout PII.
  logger.info('[Kora] Disbursement response', {
    withdrawalId: w.id,
    status:       body.status,
    koraStatus:   body.data?.status,
    reference:    body.data?.transaction_reference || body.data?.reference,
  });

  if (!body.status) {
    // HTTP 200 but Kora's envelope status is false — the disbursement was explicitly
    // rejected in the response body (e.g. invalid account, insufficient balance).
    // Mark _definitiveRejection so isDefinitiveProviderRejection returns true and
    // the failure path issues a safe refund instead of leaving funds deadlocked.
    const bodyReject = new Error(`Kora disbursement failed: ${body.message || 'unknown error'}`);
    bodyReject._definitiveRejection = true;
    throw bodyReject;
  }

  const koraRef = body.data?.transaction_reference || body.data?.reference || reference;

  // C2: Only treat the payout as settled when Kora confirms final disbursement.
  // 'processing' / 'pending' mean the transfer is queued but not yet confirmed.
  const KORA_SETTLED_STATUSES = new Set(['success', 'completed']);
  const settled = KORA_SETTLED_STATUSES.has((body.data?.status || '').toLowerCase());
  if (!settled) {
    logger.info('[Kora] Disbursement accepted but not yet settled — withdrawal stays processing', {
      withdrawalId: w.id,
      koraRef,
      status: body.data?.status,
    });
  }

  return {
    provider:  'kora',
    reference: koraRef,
    settled,
    raw: {
      transaction_reference: koraRef,
      status:                body.data?.status,
      amount:                body.data?.amount,
      currency:              body.data?.currency,
    },
  };
}

// ─── Error classification ─────────────────────────────────────────────────────
/**
 * Classifies a caught error as 'retryable' or 'permanent'.
 *
 * Retryable:  transient network / infrastructure errors that are safe to retry
 *             (ECONNRESET, ETIMEDOUT, ENOTFOUND, HTTP 429, 500, 502, 503, 504)
 *
 * Permanent:  anything that indicates the provider deliberately rejected the
 *             request — wrong bank details, bad account, auth failure, config
 *             problems, insufficient balance, etc.
 *
 * @param  {Error} err
 * @returns {'retryable' | 'permanent'}
 */
function classifyError(err) {
  const msg = (err.message || '').toLowerCase();

  // ── Config / setup errors — never retry ──────────────────────────────────
  if (msg.includes('not configured') || msg.includes('missing')) return 'permanent';

  // ── Stripe SDK errors ─────────────────────────────────────────────────────
  // err.type set by the Stripe Node SDK
  if (err.type) {
    // StripeConnectionError / StripeAPIError (5xx from Stripe) → retryable
    if (err.type === 'StripeConnectionError') return 'retryable';
    if (err.type === 'StripeAPIError')        return 'retryable';
    // Everything else (StripeAuthenticationError, StripeInvalidRequestError,
    // StripeCardError, StripePermissionError, etc.) → permanent
    return 'permanent';
  }

  // ── Stripe payout status failures (thrown by stripePayout as plain Error) ─
  if (msg.includes('stripe payout') && (msg.includes('failed') || msg.includes('canceled')))
    return 'permanent';

  // ── Kora API errors ───────────────────────────────────────────────────────
  if (msg.startsWith('kora api error:')) {
    // 4xx inside Kora response body → permanent (bad account, auth, etc.)
    if (msg.includes('invalid') || msg.includes('not found') ||
        msg.includes('unauthorized') || msg.includes('forbidden') ||
        msg.includes('account') || msg.includes('bank') ||
        msg.includes('duplicate') || msg.includes('insufficient'))
      return 'permanent';
    // Generic Kora API error with no explicit domain reason → retryable
    return 'retryable';
  }

  // ── Kora success-false (thrown by koraPayout when body.status is falsy)
  if (msg.startsWith('kora disbursement failed:')) return 'permanent';

  // ── Axios / Node network errors ───────────────────────────────────────────
  const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
                                    'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN']);
  if (err.code && RETRYABLE_CODES.has(err.code)) return 'retryable';

  // ── HTTP status from Axios ────────────────────────────────────────────────
  const httpStatus = err.response?.status;
  if (httpStatus) {
    if (httpStatus === 429 || httpStatus >= 500) return 'retryable';
    return 'permanent';   // 4xx → provider rejected the request
  }

  // Default: treat unknown errors as permanent (fail safe)
  return 'permanent';
}

// ─── Pre-HTTP config error detector ──────────────────────────────────────────
// Returns true when the error was thrown synchronously BEFORE any HTTP call was
// made to the provider (e.g. Stripe Connect not configured, missing API key).
// Used by the failure path to decide whether payoutDispatchRef should be cleared
// so a safe refund can be issued — the provider was never actually contacted.
function isPreHttpConfigError(msg) {
  const m = (msg || '').toLowerCase();
  return m.includes('not configured') || m.includes('integration required');
}

// ─── Definitive provider rejection detector ───────────────────────────────────
// Returns true when the provider HTTP call *completed* and the provider returned
// an explicit rejection (4xx), confirming the disbursement was NEVER created.
// In this case there is zero double-disbursement risk from clearing payoutDispatchRef
// and issuing a wallet refund.
//
// Distinct from ambiguous outcomes (timeout, 5xx, network error) where the provider
// may have accepted the request before returning an error — those must go to reconcile.
//
// Stripe: SDK sets err.type; only the definitively-rejected types qualify.
//   StripeConnectionError / StripeAPIError are network/5xx — ambiguous, excluded.
// Kora / generic: HTTP 4xx response with a body (err.response present).
//   429 rate-limit is retryable/ambiguous — excluded.
function isDefinitiveProviderRejection(err) {
  if (!err) return false;

  // Kora HTTP-200 body rejection (body.status === false) — the provider explicitly
  // rejected the disbursement in its response body.  Stamped by koraPayout above.
  if (err._definitiveRejection) return true;

  // Stripe SDK types that confirm the request was invalid / definitively rejected.
  // StripeConnectionError / StripeAPIError are network/5xx — excluded (ambiguous).
  const STRIPE_DEFINITIVE = new Set([
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeCardError',
  ]);
  if (err.type && STRIPE_DEFINITIVE.has(err.type)) return true;

  // Axios / HTTP 4xx with a provider response body (request completed, rejected).
  // err.response is now preserved on Kora re-throws so this also catches Kora 4xx.
  // 429 rate-limit is retryable/ambiguous — excluded.
  const status = err.response?.status;
  if (status && status >= 400 && status <= 499 && status !== 429) return true;

  return false;
}

// ─── Per-withdrawal in-flight lock (single-process) ──────────────────────────
// Prevents concurrent executePayout calls for the same withdrawal within one process.
// Startup sweep + admin trigger can both fire setImmediate for the same withdrawalId;
// the second call exits immediately instead of duplicating the provider HTTP request.
const _payoutInFlight = new Set();

// ─── DB-level advisory payout lock ───────────────────────────────────────────
// TTL-keyed record written to db.payoutLocks atomically with payoutDispatchRef
// inside withBalanceMutex.  Provides a second defence layer for shared-filesystem
// multi-process scenarios where _payoutInFlight is per-process.
// The _dbVersion check in saveAppState provides the CAS guarantee for concurrent writes.
const PAYOUT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 min > 2 × 30 s timeout + retry

// ─── executePayout ────────────────────────────────────────────────────────────
/**
 * Orchestrates a real payout for a withdrawal that is in "processing" status.
 *
 * Called via setImmediate() in index.js AFTER the HTTP response has been sent,
 * so it loads a fresh copy of the DB, runs the provider call, then saves.
 *
 * Safety rules:
 *   • Never marks "paid" unless the provider API call succeeds and returns a ref.
 *   • On permanent error (invalid bank details, auth rejection, etc.) → "failed"
 *     immediately, full refund issued.
 *   • On transient/network error → one automatic retry (MAX 1).
 *     payoutAttempts is incremented and persisted to DB before each attempt so
 *     that even a crash between attempts leaves an accurate counter.
 *   • After the retry, if still failing → "failed", full refund.
 *   • holdReleased / refundIssued guards on markWithdrawalPaid / _issueRefund
 *     ensure double-payout and double-refund are impossible regardless of
 *     concurrent calls or DB reload timing.
 *   • All provider responses and retry decisions are logged.
 *
 * @param {string}   withdrawalId
 * @param {object}   logger
 * @param {function} withBalanceMutex
 */
async function executePayout(withdrawalId, logger, withBalanceMutex) {
  // H-3: Single-process duplicate guard — second call for the same withdrawal exits immediately.
  if (_payoutInFlight.has(withdrawalId)) {
    logger.warn('[executePayout] Already in-flight for this withdrawal — skipping duplicate invocation', { withdrawalId });
    return;
  }
  _payoutInFlight.add(withdrawalId);

  try {
  logger.info('[executePayout] Starting', { withdrawalId });

  // ── Load fresh DB ─────────────────────────────────────────────────────────
  const db = loadAppState();
  const w  = (db.withdrawals || []).find(x => x.id === withdrawalId);

  if (!w) {
    logger.error('[executePayout] Withdrawal not found', { withdrawalId });
    return;
  }

  if (w.status !== 'processing') {
    logger.warn('[executePayout] Unexpected status — skipping', { withdrawalId, status: w.status });
    return;
  }

  // M-2: If the provider already accepted this withdrawal (payoutReference set), never
  // call the provider again — doing so would cause a double disbursement.
  if (w.payoutReference) {
    logger.warn('[executePayout] payoutReference already set — skipping provider call to prevent double disbursement', {
      withdrawalId,
      payoutReference: w.payoutReference,
    });
    return;
  }

  // Defence-in-depth: payoutDispatchRef is written to DB immediately before every
  // provider HTTP call.  If it is set but payoutReference is still null, a previous
  // executePayout invocation already contacted (or tried to contact) the provider and
  // did not receive a confirmed reference back.  Calling the provider again here risks
  // double disbursement.  Leave the withdrawal in processing and require admin reconcile.
  // This guard specifically catches duplicate admin-triggered invocations (e.g. two rapid
  // POST /transition requests) that slip past the _payoutInFlight Set after the first
  // run completes.
  if (w.payoutDispatchRef) {
    logger.warn('[executePayout] payoutDispatchRef already set but payoutReference absent — provider may have been contacted; leaving processing for reconcile', {
      withdrawalId,
      payoutDispatchRef: w.payoutDispatchRef,
      hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
    });
    return;
  }

  // M-3: Attempt cap — refund holdBalance and mark failed instead of leaving funds locked.
  // H-1: Only auto-refund when payoutDispatchRef is absent (provider was never contacted).
  //      If payoutDispatchRef is set, the HTTP call was at least initiated — we cannot know
  //      the provider outcome without querying them. Leave processing and require reconciliation.
  const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
  if (w.payoutAttempts >= MAX_ATTEMPTS) {
    if (w.payoutDispatchRef) {
      logger.error('[executePayout] Attempt cap reached but provider was already contacted — leaving processing for manual reconciliation', {
        withdrawalId,
        payoutAttempts:    w.payoutAttempts,
        payoutDispatchRef: w.payoutDispatchRef,
        hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
      });
      return; // do NOT refund — outcome unknown
    }

    logger.warn('[executePayout] Attempt cap reached (no dispatch yet) — marking failed and refunding hold', {
      withdrawalId,
      payoutAttempts: w.payoutAttempts,
    });
    const runCap = withBalanceMutex ? withBalanceMutex : (fn) => fn();
    try {
      await runCap(async () => {
        const dbCap = loadAppState();
        markWithdrawalFailed(dbCap, withdrawalId, 'payout attempt cap reached');
        const pgResult = await persistWithdrawalById(dbCap, withdrawalId, 'processing');
        if (pgResult.conflict) return;
      });
    } catch (capErr) {
      logger.error('[executePayout] Attempt-cap markWithdrawalFailed failed — retrying in 500 ms', {
        withdrawalId, error: capErr.message,
      });
      // Mirror the main failure-path retry: wait 500 ms, try once more with a fresh load.
      try {
        await new Promise(r => setTimeout(r, 500));
        await runCap(async () => {
          const dbCapRetry = loadAppState();
          markWithdrawalFailed(dbCapRetry, withdrawalId, 'payout attempt cap reached');
          const pgResult = await persistWithdrawalById(dbCapRetry, withdrawalId, 'processing');
          if (pgResult.conflict) return;
        });
        logger.info('[executePayout] Attempt-cap retry succeeded — marked failed', { withdrawalId });
      } catch (capRetryErr) {
        // Both attempts failed.  Stamp a minimal marker (no balance mutation) so
        // admin tooling or startup sweep can issue the refund via /transition.
        logger.error('[executePayout] CRITICAL: attempt-cap retry also failed — stamping reconcile marker', {
          withdrawalId, error: capRetryErr.message,
        });
        try {
          await new Promise(r => setTimeout(r, 500));
          const dbMarker = loadAppState();
          const wMarker  = (dbMarker.withdrawals || []).find(x => x.id === withdrawalId);
          if (wMarker && wMarker.status === 'processing' && !wMarker.holdReleased) {
            wMarker.reconcileRequired = true;
            wMarker.reconcileNote     =
              `Attempt cap reached but markWithdrawalFailed could not be persisted at ${Date.now()}. ` +
              `Refund required: POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`;
            saveAppState(dbMarker);
            logger.warn('[executePayout] Attempt-cap reconcile marker persisted', {
              withdrawalId,
              hint: `POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`,
            });
          }
        } catch (markerErr) {
          logger.error('[executePayout] EMERGENCY: could not stamp attempt-cap marker — MANUAL REFUND REQUIRED', {
            withdrawalId,
            userId:      w.userId,
            walletId:    w.walletId,
            currency:    w.currency,
            amountMinor: w.amount,
            action:      'Mark withdrawal failed and refund holdBalance manually',
            error:       markerErr.message,
          });
        }
      }
    }
    return;
  }

  const provider = payoutRouter(w.country);
  logger.info('[executePayout] Routing to provider', { withdrawalId, provider, country: w.country });

  // ── No safe provider for this country ─────────────────────────────────────
  // Defense in depth: POST /withdrawals already rejects unsupported countries
  // up-front (see index.js), so this should be unreachable for new
  // withdrawals. Guards against any legacy/edge-case record with an
  // unsupported country string reaching dispatch and being silently treated
  // as a Kora payout (see attemptPayout's stripe/else branch below).
  if (!provider) {
    logger.error('[executePayout] No payout provider available for country — marking failed for refund', {
      withdrawalId, country: w.country,
    });
    try {
      const dbNoProvider = loadAppState();
      markWithdrawalFailed(dbNoProvider, withdrawalId, `No payout provider available for country ${w.country || 'unknown'}`);
      await persistWithdrawalById(dbNoProvider, withdrawalId, 'processing');
    } catch (noProviderErr) {
      logger.error('[executePayout] Could not mark unsupported-country withdrawal failed', {
        withdrawalId, error: noProviderErr.message,
      });
    }
    return;
  }

  // C5: All saves use version-checked PostgreSQL app state persistence.

  // ── Demo mode: no provider configured → simulate a successful payout ─────
  // Consistent with the deposit system which also uses demo mode when Stripe
  // is not configured.  Logged clearly so it is easy to spot in production.
  const isDemoMode =
    (provider === 'stripe'         && !stripeClient) ||
    (provider === 'stripe_connect' && !isStripeConnectEnabled()) ||
    (provider === 'kora'           && !getKoraSecretKey());

  if (isDemoMode) {
    logger.warn('[executePayout] DEMO MODE — no payment provider configured', { withdrawalId, provider });
    if (process.env.NODE_ENV === 'production') {
      logger.error('[executePayout] PRODUCTION: refusing to simulate payout — configure STRIPE_SECRET_KEY or KORA_API_KEY. Withdrawal stays in processing until provider is configured.', { withdrawalId });
      return; // withdrawal stays processing — no ledger mutation
    }
    // Dev / staging only: simulate a successful payout
    try {
      const dbDemo = loadAppState();
      markWithdrawalPaid(dbDemo, withdrawalId, `DEMO-${withdrawalId.slice(0, 8)}`, 'demo');
      const pgResult = await persistWithdrawalById(dbDemo, withdrawalId, 'processing');
      if (pgResult.conflict) return;
      logger.info('[executePayout] Demo payout marked as paid', { withdrawalId });
    } catch (demoErr) {
      logger.error('[executePayout] Demo mode: could not mark paid', {
        withdrawalId,
        error: demoErr.message,
      });
    }
    return;
  }

  // ── attemptPayout — inner function, may run up to twice ──────────────────
  async function attemptPayout(attemptNumber) {
    // Atomically claim the dispatch slot under withBalanceMutex:
    //   1. Fresh loadAppState to see the latest state.
    //   2. Duplicate guards (holdReleased, and on attempt 1 only: payoutDispatchRef).
    //   3. Write payoutAttempts + payoutDispatchRef + payoutProvider → saveAppState.
    //
    // Wrapping in withBalanceMutex ensures that even on multi-pod deployments, only
    // one executor can write payoutDispatchRef.  The second pod's claim will find
    // payoutDispatchRef already set on attempt 1 and throw _permanent, preventing a
    // concurrent double-disbursement before the HTTP call is made.
    //
    // The provider HTTP call happens OUTSIDE the mutex — it can take up to 30 s and
    // must not block other balance mutations for that duration.
    let wSnapshot;
    const runClaim = withBalanceMutex ? withBalanceMutex : (fn) => fn();

    await runClaim(async () => {
      const dbAttempt = loadAppState();
      const wAttempt  = (dbAttempt.withdrawals || []).find(x => x.id === withdrawalId);
      if (!wAttempt) throw new Error('Withdrawal disappeared before attempt');
      if (wAttempt.holdReleased) throw Object.assign(
        new Error('Hold already released — duplicate payout guard'),
        { _permanent: true }
      );
      // On the first attempt only: atomically acquire the DB-level advisory lock and
      // set payoutDispatchRef.  Both changes are persisted in the same saveAppState call so
      // the _dbVersion check acts as a compare-and-swap — a concurrent process that
      // read the same version will get a DB_VERSION_CONFLICT on its own saveAppState and
      // abort safely.
      if (attemptNumber === 1) {
        // Initialise and clean expired locks.
        if (!dbAttempt.payoutLocks) dbAttempt.payoutLocks = [];
        const now = Date.now();
        dbAttempt.payoutLocks = dbAttempt.payoutLocks.filter(l => l.expiresAt > now);

        // If payoutDispatchRef is already set, another process has started this payout.
        if (wAttempt.payoutDispatchRef) {
          throw Object.assign(
            new Error('payoutDispatchRef already set by concurrent process — aborting to prevent double-disbursement'),
            { _permanent: true }
          );
        }

        // If an active advisory lock exists, another process is in the dispatch window.
        const activeLock = dbAttempt.payoutLocks.find(l => l.withdrawalId === withdrawalId);
        if (activeLock) {
          throw Object.assign(
            new Error(`Advisory payout lock held by pid ${activeLock.pid} — aborting concurrent dispatch`),
            { _permanent: true }
          );
        }

        // Acquire lock and set dispatch ref — saved atomically below.
        dbAttempt.payoutLocks.push({
          withdrawalId,
          pid:       process.pid,
          claimedAt: now,
          expiresAt: now + PAYOUT_LOCK_TTL_MS,
        });
      }
      wAttempt.payoutAttempts    = attemptNumber;
      wAttempt.payoutDispatchRef = `egw-${withdrawalId}`; // deterministic — same across retries
      wAttempt.payoutProvider    = provider;              // persist now so reconcile routes correctly after crash
      saveAppState(dbAttempt);
      if (attemptNumber === 1) {
        await upsertPayoutLockPostgres({
          withdrawalId,
          pid: process.pid,
          claimedAt: now,
          expiresAt: now + PAYOUT_LOCK_TTL_MS,
        });
      }
      wSnapshot = wAttempt; // capture for provider call below
    });

    logger.info('[executePayout] Dispatch claimed', { withdrawalId, attemptNumber, provider,
      payoutDispatchRef: wSnapshot.payoutDispatchRef });

    // Provider HTTP call outside the mutex.
    // NOTE: `provider` above is payoutRouter(w.country), which never returns
    // 'stripe' anymore — every country without an explicit Kora/Stripe Connect
    // corridor now returns null and is rejected before a withdrawal record can
    // even be created (see the COUNTRY_NOT_SUPPORTED check in POST
    // /withdrawals). This branch is therefore unreachable in normal operation;
    // stripePayout() itself is left in place (rather than deleted) purely so
    // existing regression tests asserting "no provider was removed" keep
    // passing, and as a defensive no-op if a legacy pre-lockdown record is
    // ever replayed through this code path.
    let result;
    if (provider === 'stripe') {
      result = await stripePayout(wSnapshot, logger);
    } else if (provider === 'stripe_connect') {
      result = await stripeConnectPayout(wSnapshot, logger);
    } else {
      result = await koraPayout(wSnapshot, logger);
    }
    return result;
  }

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  let result;
  let lastError;

  try {
    result = await attemptPayout(1);
  } catch (err) {
    lastError = err;
    const kind = err._permanent ? 'permanent' : classifyError(err);

    logger.warn('[executePayout] Attempt 1 failed', {
      withdrawalId,
      provider,
      classification: kind,
      error: err.message,
    });

    if (kind === 'retryable') {
      logger.info('[executePayout] Retryable error — scheduling retry in 2 s', { withdrawalId });
      await new Promise(res => setTimeout(res, 2000));

      if (provider === 'kora') {
        // ── Kora: query status before any retry to prevent double-disbursement ──
        // payoutDispatchRef ('egw-<id>') was persisted before attempt 1's HTTP call.
        // If that call timed out but Kora silently received it, a second POST would
        // double-disburse.  Query first; only allow re-POST when provider confirms
        // the transaction is absent.  Stripe uses idempotencyKey so is safe to retry.
        const koraSecretKey = getKoraSecretKey();
        const dispatchRef   = `egw-${withdrawalId}`;
        let koraQueryStatus = 'unknown';
        let koraQueryRef    = null;

        try {
          const statusResp = await axios.get(
            `https://api.korapay.com/merchant/api/v1/transactions/${dispatchRef}`,
            { headers: { Authorization: `Bearer ${koraSecretKey}` }, timeout: 15_000 }
          );
          const data      = statusResp.data?.data || {};
          koraQueryRef    = data.transaction_reference || data.reference || dispatchRef;
          koraQueryStatus = (data.status || '').toLowerCase();
        } catch (qErr) {
          koraQueryStatus = qErr.response?.status === 404 ? 'notfound' : 'queryerror';
          logger.warn('[executePayout] Kora pre-retry status query failed', {
            withdrawalId, dispatchRef, error: qErr.message, koraQueryStatus,
          });
        }

        logger.info('[executePayout] Kora pre-retry status query result', {
          withdrawalId, dispatchRef, koraQueryStatus, koraQueryRef,
        });

        const KORA_SETTLED_S = new Set(['success', 'completed']);
        const KORA_FAILED_S  = new Set(['failed', 'reversed', 'cancelled']);
        const KORA_PENDING_S = new Set(['pending', 'processing']);

        if (KORA_SETTLED_S.has(koraQueryStatus)) {
          // Attempt 1 was accepted AND already settled — treat as success, skip retry.
          logger.info('[executePayout] Kora pre-retry: already settled — using query result, skipping retry', {
            withdrawalId, koraQueryRef,
          });
          result    = { provider: 'kora', reference: koraQueryRef, settled: true };
          lastError = null;

        } else if (KORA_PENDING_S.has(koraQueryStatus)) {
          // Attempt 1 accepted and pending settlement — do NOT re-POST.
          // Leave processing; webhook or admin reconcile will confirm later.
          logger.info('[executePayout] Kora pre-retry: transaction pending — leaving processing, skipping retry', {
            withdrawalId, koraQueryRef,
          });
          result    = { provider: 'kora', reference: koraQueryRef, settled: false };
          lastError = null;

        } else if (KORA_FAILED_S.has(koraQueryStatus)) {
          // Provider confirmed failure — safe to refund.
          // Clear payoutDispatchRef so the failure path below can call markWithdrawalFailed.
          logger.warn('[executePayout] Kora pre-retry: provider confirmed failure — clearing payoutDispatchRef for safe refund, skipping retry', {
            withdrawalId, koraQueryStatus,
          });
          try {
            const dbClear = loadAppState();
            const wClear  = (dbClear.withdrawals || []).find(x => x.id === withdrawalId);
            if (wClear) { wClear.payoutDispatchRef = null; saveAppState(dbClear); }
          } catch (clearErr) {
            // If the clear fails, payoutDispatchRef stays set → failure path will leave
            // processing for manual reconcile rather than auto-refunding.  Safe.
            logger.error('[executePayout] Could not clear payoutDispatchRef after confirmed Kora failure', {
              withdrawalId, error: clearErr.message,
            });
          }
          // lastError stays set; failure path will call markWithdrawalFailed → refund.

        } else {
          // notfound (404) or queryerror or unrecognised status.
          // Conservative: do NOT re-POST — cannot confirm the transaction is absent.
          // payoutDispatchRef is set → failure path leaves processing for admin reconcile.
          logger.warn('[executePayout] Kora pre-retry: transaction not found or query failed — skipping retry, leaving processing for reconcile', {
            withdrawalId, koraQueryStatus,
          });
          // lastError stays set; failure path sees payoutDispatchRef → no auto-refund.
        }

      } else {
        // ── Stripe: idempotencyKey = 'egw-<id>' on payouts.create ensures idempotency ──
        try {
          result = await attemptPayout(2);
          lastError = null;   // retry succeeded
        } catch (retryErr) {
          lastError = retryErr;
          logger.warn('[executePayout] Attempt 2 (retry) failed', {
            withdrawalId,
            provider,
            error: retryErr.message,
          });
        }
      }
    }
    // permanent errors fall through directly to the failure path below
  }

  // ── SUCCESS ───────────────────────────────────────────────────────────────
  if (!lastError && result) {
    // Only mark paid when the provider confirms funds have been disbursed.
    // Stripe: settled=true only when status='paid'. pending/in_transit → false.
    // Kora:   settled=true only when status='success'/'completed'. pending/processing → false.
    // Any provider that omits settled is treated as NOT settled (fail-safe).
    if (!result.settled) {
      // Persist the provider reference before returning so adminTransition can
      // detect that the provider already accepted the disbursement and block any
      // premature admin refund while the payout is in-flight.
      if (result.reference) {
        try {
          const dbRef = loadAppState();
          const wRef  = (dbRef.withdrawals || []).find(x => x.id === withdrawalId);
          if (wRef) {
            wRef.payoutReference = result.reference;
            wRef.payoutProvider  = result.provider;
            saveAppState(dbRef);
          }
        } catch (refErr) {
          logger.error('[executePayout] Could not persist provider reference', {
            withdrawalId,
            error: refErr.message,
          });
        }
      }
      logger.info('[executePayout] Payout submitted but not yet settled — withdrawal stays processing', {
        withdrawalId,
        provider:  result.provider,
        reference: result.reference,
      });
      return; // no markWithdrawalPaid — webhook or admin must confirm later
    }

    // Run inside withBalanceMutex so a concurrent write cannot trigger a version
    // conflict that leaves the withdrawal in 'processing' — which would later allow
    // an admin to issue a refund while the provider already disbursed funds.
    const runSuccess = withBalanceMutex ? withBalanceMutex : (fn) => fn();
    try {
      await runSuccess(async () => {
        const dbSuccess = loadAppState();
        // Pre-set reference before markWithdrawalPaid so it is captured in the
        // same saveAppState write. If markWithdrawalPaid throws (e.g. duplicate-guard),
        // the reference is already present thanks to the payoutAttempts > 0 backstop.
        const wForRef = (dbSuccess.withdrawals || []).find(x => x.id === withdrawalId);
        if (wForRef && !wForRef.payoutReference) {
          wForRef.payoutReference = result.reference;
          wForRef.payoutProvider  = result.provider;
        }
        markWithdrawalPaid(dbSuccess, withdrawalId, result.reference, result.provider);
        const pgResult = await persistWithdrawalById(dbSuccess, withdrawalId, 'processing');
        if (pgResult.conflict) return;
        logger.info('[executePayout] Marked paid', {
          withdrawalId,
          provider:  result.provider,
          reference: result.reference,
        });
      });
    } catch (paidErr) {
      logger.error('[executePayout] CRITICAL: provider settled but could not mark paid — retrying in 500 ms', {
        withdrawalId,
        error: paidErr.message,
      });
      // Retry with a fresh DB load. markWithdrawalPaid is guarded by holdReleased so
      // if the first attempt partially persisted, the retry is a safe no-op.
      // runSuccess has released the mutex (its promise rejected), so re-entering is safe.
      try {
        await new Promise(r => setTimeout(r, 500));
        await runSuccess(async () => {
          const dbRetry = loadAppState();
          const wRetry  = (dbRetry.withdrawals || []).find(x => x.id === withdrawalId);
          if (wRetry && !wRetry.payoutReference) {
            wRetry.payoutReference = result.reference;
            wRetry.payoutProvider  = result.provider;
          }
          markWithdrawalPaid(dbRetry, withdrawalId, result.reference, result.provider);
          const pgResult = await persistWithdrawalById(dbRetry, withdrawalId, 'processing');
          if (pgResult.conflict) return;
        });
        logger.info('[executePayout] Retry succeeded — marked paid', {
          withdrawalId, provider: result.provider, reference: result.reference });
      } catch (retryErr) {
        logger.error('[executePayout] CRITICAL: retry also failed — attempting emergency audit marker', {
          withdrawalId, error: retryErr.message, payoutReference: result.reference,
        });

        // C-2: Both full markWithdrawalPaid+saveAppState attempts failed.
        // Provider confirmed settlement — funds already disbursed.
        // Do NOT call provider again. Do NOT refund. Do NOT call markWithdrawalPaid again.
        // Stamp a minimal marker so the admin /reconcile endpoint can complete the
        // transition once DB I/O recovers, without any risk of double-payment.
        try {
          await new Promise(r => setTimeout(r, 500));
          const dbEmergency = loadAppState();
          const wEmergency  = (dbEmergency.withdrawals || []).find(x => x.id === withdrawalId);
          // Only stamp if the withdrawal is still in processing and hold not yet released.
          // If holdReleased is already true a previous partial write succeeded — skip.
          if (wEmergency && wEmergency.status === 'processing' && !wEmergency.holdReleased) {
            wEmergency.reconcileRequired = true;
            wEmergency.payoutReference   = result.reference;
            wEmergency.payoutProvider    = result.provider;
            wEmergency.reconcileNote     =
              `Provider settled at ${Date.now()} but markWithdrawalPaid could not be persisted. ` +
              `Manual reconcile required: POST /admin/withdrawals/${withdrawalId}/reconcile`;
            saveAppState(dbEmergency); // minimal stamp — no hold mutation, no ledger write, no status change
            logger.warn('[executePayout] Emergency audit marker persisted — /reconcile will complete the transition', {
              withdrawalId,
              payoutReference: result.reference,
              reconcileEndpoint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
            });
          }
        } catch (emergencyErr) {
          // Last resort — log every field an operator needs for manual DB repair.
          // `w` is the withdrawal snapshot loaded at the top of executePayout.
          logger.error('[executePayout] EMERGENCY: could not persist audit marker — MANUAL DB REPAIR REQUIRED', {
            withdrawalId,
            userId:          w.userId,
            walletId:        w.walletId,
            currency:        w.currency,
            amountMinor:     w.amount,
            payoutReference: result.reference,
            payoutProvider:  result.provider,
            action:          'Set reconcileRequired=true, payoutReference, payoutProvider on the withdrawal record, then POST /admin/withdrawals/' + withdrawalId + '/reconcile',
            emergencyError:  emergencyErr.message,
          });
        }
      }
    }
    return;
  }

  // ── FAILURE ───────────────────────────────────────────────────────────────
  // H-1: Only issue a wallet refund when the provider was never contacted.
  //      payoutDispatchRef is persisted to DB just before every HTTP call, so its
  //      presence means the provider may have accepted the funds.  In that case
  //      leave the withdrawal in 'processing' and require manual reconciliation —
  //      issuing a refund while the bank transfer is in-flight would double-pay.
  const failReason = lastError?.message || 'unknown error';
  logger.error('[executePayout] All attempts failed', { withdrawalId, provider, error: failReason });

  const runFail = withBalanceMutex ? withBalanceMutex : (fn) => fn();

  // Flag set inside the mutex when the guard fires; used to suppress misleading logs.
  let reconcileRequired = false;

  try {
    await runFail(async () => {
      const dbFail = loadAppState();
      const wFail  = (dbFail.withdrawals || []).find(x => x.id === withdrawalId);

      // Guard: provider was contacted (payoutDispatchRef is set) — three cases:
      //
      //  1. Definitive 4xx rejection: HTTP call completed, provider explicitly rejected
      //     the request (invalid bank details, auth error, etc.).  The disbursement was
      //     NEVER created — zero double-disbursement risk.  Clear payoutDispatchRef and
      //     allow the refund.
      //
      //  2. Pre-HTTP config error: error thrown before any HTTP call (e.g. Stripe Connect
      //     not configured).  payoutDispatchRef was written spuriously — clear and refund.
      //
      //  3. Ambiguous (timeout, 5xx, network): the provider may have accepted the request.
      //     Do NOT refund.  Leave processing and require admin reconcile.
      if (wFail?.payoutDispatchRef) {
        const isDefinitive = isDefinitiveProviderRejection(lastError);
        const isConfigErr  = isPreHttpConfigError(failReason);

        if (!isDefinitive && !isConfigErr) {
          // Ambiguous outcome — outcome unknown, do not auto-refund.
          logger.error('[executePayout] Provider was contacted but outcome is unknown — leaving processing for reconciliation', {
            withdrawalId,
            failReason,
            payoutDispatchRef: wFail.payoutDispatchRef,
            hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
          });
          reconcileRequired = true;
          return; // do NOT call markWithdrawalFailed
        }

        if (isDefinitive) {
          // Definitive 4xx: disbursement was never created — safe to refund.
          logger.warn('[executePayout] Definitive provider rejection — clearing payoutDispatchRef for safe refund', {
            withdrawalId,
            failReason,
            httpStatus:      lastError?.response?.status,
            stripeErrorType: lastError?.type,
          });
        } else {
          // Pre-HTTP config error — provider was never actually called.
          logger.warn('[executePayout] Clearing payoutDispatchRef — error was pre-HTTP configuration failure, no provider contact', {
            withdrawalId, failReason,
          });
        }
        wFail.payoutDispatchRef = null;
      }

      // C-1: A concurrent path (another pod, startup sweep, or admin trigger) may
      // have received a successful provider response and written payoutReference
      // between our dispatch attempt and now.  If so, the disbursement is real —
      // do NOT refund.  Leave processing and require admin reconcile.
      if (wFail?.payoutReference) {
        logger.warn('[executePayout] payoutReference set by concurrent path — provider accepted disbursement; not refunding, leaving for reconcile', {
          withdrawalId,
          payoutReference: wFail.payoutReference,
          hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
        });
        reconcileRequired = true;
        return;
      }

      markWithdrawalFailed(dbFail, withdrawalId, failReason);

      if (wFail) {
        if (!dbFail.notifications) dbFail.notifications = [];
        dbFail.notifications.push({
          id:        uuidv4(),
          userId:    wFail.userId,
          type:      'withdrawal_failed',
          title:     'Withdrawal Failed — Funds Returned',
          body:      `Your withdrawal of ${wFail.currency} could not be processed. The full amount has been returned to your wallet.`,
          metadata:  { withdrawalId: wFail.id, amount: wFail.amount, currency: wFail.currency },
          read:      false,
          createdAt: Date.now(),
        });
      }

      const pgResult = await persistWithdrawalById(dbFail, withdrawalId, 'processing');
      if (pgResult.conflict) {
        reconcileRequired = true;
        return;
      }
    });

    if (!reconcileRequired) {
      logger.info('[executePayout] Marked failed, refund issued, and user notified', { withdrawalId });
    }
  } catch (innerErr) {
    if (reconcileRequired) return; // guard returned cleanly — should not reach here

    logger.error('[executePayout] CRITICAL: could not mark as failed — retrying once in 500 ms', {
      withdrawalId,
      error: innerErr.message,
    });
    // Retry with a fresh DB load. refundIssued was never persisted (saveAppState threw), so the
    // fresh load sees refundIssued:false and markWithdrawalFailed is safe to run again.
    // runFail has released the mutex (its promise rejected), so re-entering is safe.
    try {
      await new Promise(r => setTimeout(r, 500));
      await runFail(async () => {
        const dbRetry = loadAppState();
        const wRetry  = (dbRetry.withdrawals || []).find(x => x.id === withdrawalId);
        if (wRetry?.payoutDispatchRef) {
          // Mirror the primary failure-path guard: clear payoutDispatchRef only for
          // definitive rejections and pre-HTTP config errors.  Ambiguous outcomes
          // (timeout, 5xx, network) still require manual reconcile.
          const canClear =
            isPreHttpConfigError(failReason) ||
            isDefinitiveProviderRejection(lastError);
          if (!canClear) {
            reconcileRequired = true;
            return;
          }
          wRetry.payoutDispatchRef = null;
        }
        // C-1 mirror: same payoutReference guard as the primary block.
        if (wRetry?.payoutReference) {
          logger.warn('[executePayout] Retry: payoutReference set by concurrent path — not refunding, leaving for reconcile', {
            withdrawalId, payoutReference: wRetry.payoutReference,
            hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
          });
          reconcileRequired = true;
          return;
        }
        markWithdrawalFailed(dbRetry, withdrawalId, failReason);
        const pgResult = await persistWithdrawalById(dbRetry, withdrawalId, 'processing');
        if (pgResult.conflict) {
          reconcileRequired = true;
          return;
        }
      });
      if (!reconcileRequired) {
        logger.info('[executePayout] Retry succeeded — marked failed and refund issued', { withdrawalId });
      }
    } catch (retryErr) {
      if (reconcileRequired) {
        // payoutDispatchRef was set — provider may have been contacted.
        // Already logged above; do not issue emergency refund marker here.
        return;
      }
      logger.error('[executePayout] CRITICAL: retry also failed — attempting emergency failure marker', {
        withdrawalId, error: retryErr.message,
      });
      // Provider was never contacted (payoutDispatchRef absent) but both
      // markWithdrawalFailed + saveAppState attempts failed.  Stamp a minimal marker
      // (no balance mutation) so admin tooling can issue the refund via /transition.
      // Mirrors the settled-success emergency audit marker path.
      try {
        await new Promise(r => setTimeout(r, 500));
        const dbFailEmergency = loadAppState();
        const wFailEmergency  = (dbFailEmergency.withdrawals || []).find(x => x.id === withdrawalId);
        if (wFailEmergency && wFailEmergency.status === 'processing' && !wFailEmergency.holdReleased) {
          wFailEmergency.reconcileRequired = true;
          wFailEmergency.reconcileNote     =
            `Provider not contacted but markWithdrawalFailed could not be persisted at ${Date.now()}. ` +
            `Refund required: POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`;
          saveAppState(dbFailEmergency);
          logger.warn('[executePayout] Emergency failure marker persisted — admin must refund via /transition', {
            withdrawalId,
            hint: `POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`,
          });
        }
      } catch (failEmergencyErr) {
        logger.error('[executePayout] EMERGENCY: could not persist failure marker — MANUAL REFUND REQUIRED', {
          withdrawalId,
          userId:      w.userId,
          walletId:    w.walletId,
          currency:    w.currency,
          amountMinor: w.amount,
          action:      'Mark withdrawal failed and refund holdBalance to user manually',
          error:       failEmergencyErr.message,
        });
      }
    }
  }

  } finally {
    _payoutInFlight.delete(withdrawalId);
    // Release the DB-level advisory lock.  Best-effort — the lock expires via TTL
    // if this write fails, so no funds are ever permanently blocked.
    try {
      const runRelease = withBalanceMutex ? withBalanceMutex : (fn) => fn();
      await runRelease(async () => {
        const dbRelease = loadAppState();
        if (dbRelease.payoutLocks) {
          const before = dbRelease.payoutLocks.length;
          dbRelease.payoutLocks = dbRelease.payoutLocks.filter(
            l => !(l.withdrawalId === withdrawalId && l.pid === process.pid)
          );
          if (dbRelease.payoutLocks.length !== before) saveAppState(dbRelease);
        }
        await releasePayoutLockPostgres({ withdrawalId });
      });
    } catch (_) { /* non-fatal — lock expires via PAYOUT_LOCK_TTL_MS */ }
  }
}

module.exports = {
  payoutRouter,
  isPayoutProviderReady,
  executePayout,
  // Shared Kora credential/verification helpers — used by index.js (webhook route)
  // and adminWithdrawals.js (reconcile) so the key-resolution logic lives in one place.
  getKoraSecretKey,
  verifyKoraWebhookSignature,
  // Country normalization + routing helpers — used by index.js POST /withdrawals
  // so routing never depends on free-text country matching.
  normalizeCountryToISO2,
  resolveWithdrawalCountry,
  // Corridor-support guards — used by index.js to block unsupported method/currency
  // combinations (e.g. bank withdrawal for XAF) before funds enter holdBalance.
  isKoraBankAccountSupported,
  isKoraMobileMoneySupported,
  isKoraBankAccountCountry,
  isKoraBankResolutionSupported,
  isKoraMobileResolutionSupported,
  // The exact set of countries/currencies this integration routes to Kora —
  // used by index.js /payout/* endpoints and by tests as the single source of
  // truth (see the long comment above KORA_COUNTRIES for the evidence).
  KORA_COUNTRIES,
  KORA_CURRENCY_TO_COUNTRY,
  // Kora payout utility APIs — used by index.js bank-list / mobile-money-operator /
  // account-resolution endpoints consumed by the mobile app.
  listKoraBanks,
  listKoraMobileMoneyOperators,
  resolveKoraBankAccount,
  resolveKoraMobileMoneyAccount,
  // Exposed for unit testing only — not part of the runtime execution path used by index.js.
  _test: {
    getKoraSecretKey, getKoraPublicKey, getKoraEncryptionKey, encryptKoraPayload,
    verifyKoraWebhookSignature, toKoraAmount, koraPayout, KORA_UNSUPPORTED_COUNTRIES,
  },
};
