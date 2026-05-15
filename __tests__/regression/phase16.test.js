/**
 * Phase 16 regression guards — Live FX rate architecture
 *
 * Invariants protected:
 *  A. FX refresh interval is 1 hour (not 6h)
 *  B. FX_STALE_THRESHOLD_MS constant (25h) is defined
 *  C. XAF/XOF re-derived from live EUR rate via CFA franc peg (655.957)
 *  D. ratesStale field included in /fx-quote responses
 *  E. GET /fx-rates/status endpoint exists and returns freshness fields
 *  F. /exchange logs warning on stale rates and includes ratesStale in response
 *  G. Live provider (open.er-api.com) + graceful fallback still present
 *  H. FxQuote TS interface includes ratesUpdatedAt + ratesStale
 *  I. ExchangeScreen shows rate age and stale warning
 *  J. exchange.ratesUpdatedAt + exchange.ratesStale keys in all 7 language blocks
 *  K. fxSafetyCheck + calcFxFee safety guards still intact in /exchange
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const backend      = fs.readFileSync(path.resolve(__dirname, '../../backend/index.js'), 'utf8');
const transactions = fs.readFileSync(path.resolve(__dirname, '../../src/api/transactions.ts'), 'utf8');
const exchangeScr  = fs.readFileSync(path.resolve(__dirname, '../../src/screens/ExchangeScreen.tsx'), 'utf8');
const translations = fs.readFileSync(path.resolve(__dirname, '../../src/i18n/translations.ts'), 'utf8');

const exchangeSection = backend.slice(
  backend.indexOf("app.post('/exchange'"),
  backend.indexOf('// ==================== DEPOSIT / TOP-UP ENDPOINTS')
);

// ─────────────────────────────────────────────────────────────────────────────

module.exports = function phase16(check) {

  // ── A. Refresh interval ───────────────────────────────────────────────────
  check('[LiveFX] FX refresh interval is 1 hour (no longer 6h)',
    !backend.includes('setInterval(fetchLiveRates, 6 * 60 * 60 * 1000)') &&
    backend.includes('setInterval(fetchLiveRates, 60 * 60 * 1000)'));

  // ── B. Staleness constant ─────────────────────────────────────────────────
  check('[LiveFX] FX_STALE_THRESHOLD_MS constant defined',
    backend.includes('FX_STALE_THRESHOLD_MS'));

  check('[LiveFX] FX_STALE_THRESHOLD_MS is 25 hours',
    backend.includes('25 * 60 * 60 * 1000'));

  // ── C. CFA franc EUR peg ──────────────────────────────────────────────────
  check('[LiveFX] XAF re-derived from live EUR rate (655.957 peg)',
    backend.includes('merged.XAF = merged.EUR * 655.957'));

  check('[LiveFX] XOF re-derived from live EUR rate (655.957 peg)',
    backend.includes('merged.XOF = merged.EUR * 655.957'));

  // ── D. ratesStale in /fx-quote ────────────────────────────────────────────
  check('[LiveFX] ratesStale computed and returned in /fx-quote',
    backend.includes('ratesStale: (Date.now() - (db.rates.updatedAt || 0)) > FX_STALE_THRESHOLD_MS'));

  // ── E. GET /fx-rates/status endpoint ─────────────────────────────────────
  check("[LiveFX] GET /fx-rates/status endpoint defined",
    backend.includes("app.get('/fx-rates/status'"));

  check('[LiveFX] /fx-rates/status returns ageSeconds',
    backend.includes("ageSeconds:") && backend.includes('Math.floor(ageMs / 1000)'));

  check('[LiveFX] /fx-rates/status returns ageMinutes',
    backend.includes('ageMinutes:') && backend.includes('Math.floor(ageMs / 60000)'));

  check('[LiveFX] /fx-rates/status returns isStale flag',
    backend.includes('isStale:') && backend.includes('ageMs > FX_STALE_THRESHOLD_MS'));

  check('[LiveFX] /fx-rates/status returns currencyCount',
    backend.includes("currencyCount: Object.keys(db.rates.values || {}).length"));

  // ── F. /exchange staleness handling ──────────────────────────────────────
  check("[LiveFX] /exchange logs warning on stale rates",
    exchangeSection.includes("'[/exchange] Using stale FX rates'"));

  check('[LiveFX] /exchange response includes ratesStale',
    exchangeSection.includes('ratesStale'));

  check('[LiveFX] /exchange response includes ratesUpdatedAt',
    exchangeSection.includes('ratesUpdatedAt'));

  // ── G. Live provider + fallback ──────────────────────────────────────────
  check('[LiveFX] open.er-api.com used as live FX provider',
    backend.includes('open.er-api.com'));

  check('[LiveFX] fetchLiveRates has graceful fallback (catch block)',
    backend.includes('Rate refresh failed — using cached rates'));

  // ── H. FxQuote TypeScript interface ──────────────────────────────────────
  check('[LiveFX] FxQuote interface includes ratesUpdatedAt?: number',
    transactions.includes('ratesUpdatedAt?: number'));

  check('[LiveFX] FxQuote interface includes ratesStale?: boolean',
    transactions.includes('ratesStale?: boolean'));

  // ── I. ExchangeScreen freshness UI ───────────────────────────────────────
  check('[LiveFX] ExchangeScreen has rateAgeText helper',
    exchangeScr.includes('rateAgeText'));

  check('[LiveFX] ExchangeScreen renders stale rates warning',
    exchangeScr.includes('ratesStale'));

  check("[LiveFX] ExchangeScreen uses exchange.ratesUpdatedAt i18n key",
    exchangeScr.includes("t('exchange.ratesUpdatedAt')"));

  // ── J. Translation keys — all 7 languages ────────────────────────────────
  check("[LiveFX] exchange.ratesUpdatedAt key present in EN translations",
    translations.includes("'exchange.ratesUpdatedAt': 'Rates updated'"));

  check("[LiveFX] exchange.ratesStale key present in EN translations",
    translations.includes("'exchange.ratesStale': 'Rates may be outdated"));

  check("[LiveFX] exchange.ratesUpdatedAt key in all 7 language blocks",
    (translations.match(/'exchange\.ratesUpdatedAt'/g) || []).length >= 7);

  check("[LiveFX] exchange.ratesStale key in all 7 language blocks",
    (translations.match(/'exchange\.ratesStale'/g) || []).length >= 7);

  // ── K. Existing safety guards intact ─────────────────────────────────────
  check('[LiveFX] fxSafetyCheck still guards /exchange (no regression)',
    exchangeSection.includes('fxSafetyCheck'));

  check('[LiveFX] calcFxFee (1.15% fee) still active in /exchange',
    exchangeSection.includes('calcFxFee'));

};

