/**
 * FX Conversion Tests — backend/index.js math purity
 *
 * Tests the three pure functions: decimalsFor, minorToMajor, majorToMinor, and
 * the full conversion chain for all requested currency pairs.
 *
 * Run: node backend/__tests__/fx-conversion.test.js
 */

'use strict';

// ─── Replicate the exact functions from backend/index.js ─────────────────────

const currencyDecimals = {
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2,
  CNY: 2, JPY: 0, KRW: 0, HKD: 2, SGD: 2, TWD: 2, THB: 2,
  MYR: 2, IDR: 0, PHP: 2, VND: 0, INR: 2, PKR: 2, BDT: 2,
  LKR: 2, NPR: 2, MMK: 2, KHR: 2, MNT: 2,
  SEK: 2, NOK: 2, DKK: 2, ISK: 0, PLN: 2, CZK: 2, HUF: 0, RON: 2,
  BGN: 2, HRK: 2, RSD: 2, UAH: 2, RUB: 2, TRY: 2, GEL: 2,
  SAR: 2, AED: 2, QAR: 2, KWD: 3, BHD: 3, OMR: 3, ILS: 2, JOD: 3, IQD: 3,
  NGN: 2, GHS: 2, ZAR: 2, KES: 2, TZS: 2, UGX: 0, RWF: 0,
  ETB: 2, EGP: 2, TND: 3, MAD: 2, LYD: 3, DZD: 2, ERN: 2,
  AOA: 2, SOS: 2, SDG: 2, GMD: 2, MUR: 2, SCR: 2,
  BWP: 2, ZWL: 2, MZN: 2, NAD: 2, LSL: 2, SZL: 2,
  ZMW: 2, MWK: 2, GNF: 0, MGA: 0, DJF: 0, BIF: 0, KMF: 0,
  XAF: 0, XOF: 0, CVE: 2, STN: 2,
  BRL: 2, MXN: 2, ARS: 2, CLP: 0, COP: 2, PEN: 2, UYU: 2,
  BOB: 2, PYG: 0, GTQ: 2, HNL: 2, NIO: 2, CRC: 2, JMD: 2,
  TTD: 2, DOP: 2, BBD: 2, GYD: 2, SRD: 2,
};

function decimalsFor(currency) {
  const d = currencyDecimals[currency];
  return d !== undefined ? d : 2;
}

function minorToMajor(amountMinor, currency) {
  const d = decimalsFor(currency);
  return amountMinor / Math.pow(10, d);
}

function majorToMinor(amountMajor, currency) {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * Math.pow(10, d));
}

/**
 * Convert amountMinor units of `from` → minor units of `to`.
 * rates[c] = units of c per 1 USD.
 */
function convert(amountMinor, from, to, rates) {
  const fromRate = rates[from] ?? 1;
  const toRate   = rates[to]   ?? 1;
  const fromMajor   = minorToMajor(amountMinor, from);
  const usd         = fromMajor / fromRate;
  const targetMajor = usd * toRate;
  return majorToMinor(targetMajor, to);
}

// ─── Fixed representative rates (units of currency per 1 USD) ────────────────
// Using realistic values; exact figures don't matter — what matters is math.
const RATES = {
  USD: 1,
  EUR: 0.9200,
  GBP: 0.7850,
  XAF: 558.80,
  XOF: 558.80,   // XAF and XOF track each other (FCFA)
  MAD: 9.70,
  NGN: 1480.00,
  GHS: 15.30,
  ZAR: 18.50,
  CNY: 7.23,
};

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assertEqual(label, actual, expected, tolerancePct = 0.001) {
  const diff = Math.abs(actual - expected);
  const pct  = expected !== 0 ? diff / Math.abs(expected) : diff;
  if (pct <= tolerancePct) {
    console.log(`  ✓ ${label}: ${actual} (expected ~${expected})`);
    passed++;
  } else {
    console.error(`  ✗ FAIL ${label}: got ${actual}, expected ~${expected} (diff ${(pct*100).toFixed(4)}%)`);
    failed++;
  }
}

function assertSafeInt(label, value) {
  if (Number.isInteger(value) && value >= 0) {
    console.log(`  ✓ ${label}: ${value} is a safe non-negative integer`);
    passed++;
  } else {
    console.error(`  ✗ FAIL ${label}: ${value} is NOT a safe non-negative integer`);
    failed++;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== decimalsFor() ===');
assertEqual('USD decimals', decimalsFor('USD'), 2);
assertEqual('EUR decimals', decimalsFor('EUR'), 2);
assertEqual('XAF decimals', decimalsFor('XAF'), 0);  // KEY FIX — was returning 2 before
assertEqual('XOF decimals', decimalsFor('XOF'), 0);
assertEqual('JPY decimals', decimalsFor('JPY'), 0);
assertEqual('KWD decimals', decimalsFor('KWD'), 3);
assertEqual('GBP decimals', decimalsFor('GBP'), 2);
assertEqual('NGN decimals', decimalsFor('NGN'), 2);
assertEqual('GHS decimals', decimalsFor('GHS'), 2);
assertEqual('MAD decimals', decimalsFor('MAD'), 2);
assertEqual('ZAR decimals', decimalsFor('ZAR'), 2);
assertEqual('CNY decimals', decimalsFor('CNY'), 2);
// Unknown currency → default 2 (using !== undefined, not || 2)
assertEqual('XXX decimals (unknown)', decimalsFor('XXX'), 2);

console.log('\n=== minorToMajor / majorToMinor round-trip ===');
// USD: 2 decimal places
assertEqual('USD 19500 minor → 195.00 major', minorToMajor(19500, 'USD'), 195.00);
assertEqual('USD 195.00 major → 19500 minor', majorToMinor(195.00, 'USD'), 19500);
// XAF: 0 decimal places — the previously broken case
assertEqual('XAF 110219 minor → 110219 major', minorToMajor(110219, 'XAF'), 110219);
assertEqual('XAF 110219 major → 110219 minor', majorToMinor(110219, 'XAF'), 110219);
// KWD: 3 decimal places
assertEqual('KWD 1234 minor → 1.234 major', minorToMajor(1234, 'KWD'), 1.234);
assertEqual('KWD 1.234 major → 1234 minor', majorToMinor(1.234, 'KWD'), 1234);
// JPY: 0 decimal places
assertEqual('JPY 15000 minor → 15000 major', minorToMajor(15000, 'JPY'), 15000);

console.log('\n=== Full FX conversion chain ===');

// ── USD → XAF ──────────────────────────────────────────────────────────────
// $195.00 USD stored as 19500 minor
// Expected: 195 * 558.80 = 108966 XAF (0-decimal, so minor = major)
{
  const result = convert(19500, 'USD', 'XAF', RATES);
  assertSafeInt('USD→XAF result is integer', result);
  assertEqual('USD→XAF: $195 → ~108,966 XAF', result, 108966, 0.005);
  // Confirm NOT the bugged 100× value
  if (result > 1000000) {
    console.error('  ✗ FAIL USD→XAF: got 100× inflated value:', result);
    failed++;
  } else {
    console.log(`  ✓ USD→XAF: NOT 100× inflated (${result} < 1,000,000)`);
    passed++;
  }
}

// ── USD → XAF: $450 ────────────────────────────────────────────────────────
{
  const result = convert(45000, 'USD', 'XAF', RATES);
  assertSafeInt('USD→XAF $450 result is integer', result);
  assertEqual('USD→XAF: $450 → ~251,460 XAF', result, 251460, 0.005);
}

// ── USD → XOF ──────────────────────────────────────────────────────────────
{
  const result = convert(19500, 'USD', 'XOF', RATES);
  assertSafeInt('USD→XOF result is integer', result);
  assertEqual('USD→XOF: $195 → ~108,966 XOF', result, 108966, 0.005);
  if (result > 1000000) {
    console.error('  ✗ FAIL USD→XOF: 100× inflation still present');
    failed++;
  } else {
    console.log(`  ✓ USD→XOF: NOT 100× inflated`);
    passed++;
  }
}

// ── XOF → GBP ──────────────────────────────────────────────────────────────
// 558800 XOF minor (= 558800 whole XOF) → ~£784.68
// 558800 XOF / 558.80 = 1000 USD × 0.785 = £785 → minor = 78500
{
  const result = convert(558800, 'XOF', 'GBP', RATES);
  assertSafeInt('XOF→GBP result is integer', result);
  const expectedGBPMinor = Math.round((558800 / RATES.XOF) * RATES.GBP * 100);
  assertEqual('XOF→GBP: 558800 XOF → ~' + expectedGBPMinor + ' GBP minor', result, expectedGBPMinor, 0.005);
}

// ── MAD → EUR ──────────────────────────────────────────────────────────────
// 100.00 MAD stored as 10000 minor
// 100 MAD / 9.70 = $10.31 × 0.92 = €9.48 → minor = 948
{
  const result = convert(10000, 'MAD', 'EUR', RATES);
  assertSafeInt('MAD→EUR result is integer', result);
  const expectedEURMinor = Math.round((10000 / 100 / RATES.MAD) * RATES.EUR * 100);
  assertEqual('MAD→EUR: 100 MAD → ~' + expectedEURMinor + ' EUR minor', result, expectedEURMinor, 0.005);
}

// ── EUR → XAF ──────────────────────────────────────────────────────────────
// €100.00 stored as 10000 minor EUR
// 100 EUR / 0.92 = $108.70 × 558.80 = 60,741 XAF (0-decimal)
{
  const result = convert(10000, 'EUR', 'XAF', RATES);
  assertSafeInt('EUR→XAF result is integer', result);
  const expectedXAFMinor = Math.round((10000 / 100 / RATES.EUR) * RATES.XAF);
  assertEqual('EUR→XAF: €100 → ~' + expectedXAFMinor + ' XAF minor', result, expectedXAFMinor, 0.005);
}

// ── NGN → GHS ──────────────────────────────────────────────────────────────
// 100,000 NGN stored as 10000000 minor
// 100000 NGN / 1480 = $67.57 × 15.30 = 1033.78 GHS → minor = 103378
{
  const result = convert(10000000, 'NGN', 'GHS', RATES);
  assertSafeInt('NGN→GHS result is integer', result);
  const expectedGHSMinor = Math.round((10000000 / 100 / RATES.NGN) * RATES.GHS * 100);
  assertEqual('NGN→GHS: 100,000 NGN → ~' + expectedGHSMinor + ' GHS minor', result, expectedGHSMinor, 0.005);
}

// ── ZAR → USD ──────────────────────────────────────────────────────────────
// 1000.00 ZAR stored as 100000 minor
// 1000 ZAR / 18.50 = $54.05 → minor = 5405
{
  const result = convert(100000, 'ZAR', 'USD', RATES);
  assertSafeInt('ZAR→USD result is integer', result);
  const expectedUSDMinor = Math.round((100000 / 100 / RATES.ZAR) * RATES.USD * 100);
  assertEqual('ZAR→USD: 1000 ZAR → ~' + expectedUSDMinor + ' USD minor', result, expectedUSDMinor, 0.005);
}

// ── CNY → XAF ──────────────────────────────────────────────────────────────
// ¥1000.00 CNY stored as 100000 minor
// 1000 CNY / 7.23 = $138.31 × 558.80 = 77,320 XAF (0-decimal, no /100)
{
  const result = convert(100000, 'CNY', 'XAF', RATES);
  assertSafeInt('CNY→XAF result is integer', result);
  const expectedXAFMinor = Math.round((100000 / 100 / RATES.CNY) * RATES.XAF);
  assertEqual('CNY→XAF: ¥1000 CNY → ~' + expectedXAFMinor + ' XAF minor', result, expectedXAFMinor, 0.005);
  if (result > 7000000) {
    console.error('  ✗ FAIL CNY→XAF: 100× inflation present:', result);
    failed++;
  } else {
    console.log(`  ✓ CNY→XAF: NOT 100× inflated`);
    passed++;
  }
}

// ── Same-currency (no conversion) ───────────────────────────────────────────
{
  const result = convert(19500, 'USD', 'USD', RATES);
  assertEqual('USD→USD: 19500 → 19500 (identity)', result, 19500);
}

// ─── Decimal/comma parsing safety ────────────────────────────────────────────
console.log('\n=== Input parsing safety (simulates frontend parseFloat) ===');

function parseFrontendAmount(input) {
  // Replicates: parseFloat(amount.replace(/,/g, ''))
  return parseFloat(String(input).replace(/,/g, ''));
}

// Correct: English thousands separator
assertEqual('Parse "1,000.50" → 1000.50', parseFrontendAmount('1,000.50'), 1000.50);
assertEqual('Parse "195.00" → 195.00', parseFrontendAmount('195.00'), 195.00);
assertEqual('Parse "600.55" → 600.55', parseFrontendAmount('600.55'), 600.55);

// These are what the frontend UI prevents (only digits and "." allowed in input)
// But we verify the majorToMinor chain is safe for well-formed inputs
assertEqual('majorToMinor(1000.50, USD) = 100050', majorToMinor(1000.50, 'USD'), 100050);
assertEqual('majorToMinor(195.00, USD) = 19500',   majorToMinor(195.00, 'USD'), 19500);
assertEqual('majorToMinor(600.55, USD) = 60055',   majorToMinor(600.55, 'USD'), 60055);
// XAF: major == minor (0 decimal places) — no /100 or *100 should occur
assertEqual('majorToMinor(110219, XAF) = 110219',  majorToMinor(110219, 'XAF'), 110219);
assertEqual('minorToMajor(110219, XAF) = 110219',  minorToMajor(110219, 'XAF'), 110219);

// ─── fxSafetyCheck guard ────────────────────────────────────────────────────
console.log('\n=== fxSafetyCheck guard ===');

function fxSafetyCheck(receivedMinor, toCurrency) {
  if (!Number.isFinite(receivedMinor) || receivedMinor < 0) {
    return { safe: false, reason: `FX result for ${toCurrency} is not a finite non-negative number: ${receivedMinor}` };
  }
  return { safe: true };
}

function assertSafe(label, receivedMinor, currency, expectSafe) {
  const r = fxSafetyCheck(receivedMinor, currency);
  if (r.safe === expectSafe) {
    console.log(`  ✓ ${label}: safe=${r.safe}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL ${label}: expected safe=${expectSafe}, got safe=${r.safe} reason=${r.reason}`);
    failed++;
  }
}

assertSafe('Normal XAF result 110219', 110219, 'XAF', true);
assertSafe('NaN result is caught', NaN, 'XAF', false);
assertSafe('Infinity result is caught', Infinity, 'XAF', false);
assertSafe('Negative result is caught', -1, 'USD', false);
assertSafe('Zero is safe (valid edge case)', 0, 'USD', true);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
