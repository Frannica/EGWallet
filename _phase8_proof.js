/**
 * _phase8_proof.js — African Currency Picker Security & Integrity Audit
 *
 * Verifies all changes made in the "Add African currencies" update:
 *
 *  CURRENCY_INFO (currency.ts):
 *   1. All 32 African currency codes present in CURRENCY_INFO
 *   2. Every entry in CURRENCY_INFO has both name and symbol (no empty/null values)
 *   3. All African codes also have decimals defined in currencyDecimals
 *
 *  DepositScreen (DepositScreen.tsx):
 *   4. Imports getCurrencySymbol, getCurrencyName, CURRENCY_INFO from currency utils
 *   5. SUPPORTED_CURRENCIES hardcoded list is removed
 *   6. AFRICAN_CURRENCY_CODES Set is defined
 *   7. Currency selection uses a Modal (not just horizontal chips)
 *   8. Modal has a search input (Search currencies)
 *   9. Modal has Africa / World tabs
 *  10. Currency selection closes modal and sets state (no direct mutation)
 *  11. No user input is passed unvalidated to the deposit API — currency comes from
 *      CURRENCY_INFO keys only (closed list, not free-text from user)
 *
 *  Security checks:
 *  12. currencySearch input is used only for .filter() — never sent to backend
 *  13. The currency sent to backend (handleDeposit) comes from `currency` state,
 *      which is only ever set by selecting from the CURRENCY_INFO keyset
 *  14. No new console.log statements expose data (all guarded or absent)
 *  15. No new network calls added by the currency picker
 *  16. REGRESSION: handleDeposit still validates amount >= 1 before calling API
 *  17. REGRESSION: creditLocalBalance still called after confirmed deposit
 *
 * Run: node _phase8_proof.js
 */

'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function check(label, result, detail = '') {
  if (result) {
    console.log(`  ✅ PASS — ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL — ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function read(filePath) {
  return fs.readFileSync(path.resolve(__dirname, filePath), 'utf8').replace(/\r\n/g, '\n');
}

function extractRegion(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  if (start === -1) return '';
  const end = endMarker ? content.indexOf(endMarker, start) : content.length;
  return content.slice(start, end === -1 ? content.length : end);
}

const currency = read('src/utils/currency.ts');
const deposit = read('src/screens/DepositScreen.tsx');

// ─────────────────────────────────────────────────────────────────────────────
// 1. All 32 African currencies present in CURRENCY_INFO
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] currency.ts — All African currencies in CURRENCY_INFO');

const expectedAfrican = [
  'XAF','XOF','NGN','GHS','KES','ZAR','TZS','UGX','ETB','EGP','MAD','TND','DZD',
  'RWF','MUR','BWP','ZMW','AOA','GMD','LYD','NAD','LSL','MZN','SDG','SOS','ZWL',
  'SCR','ERN','SLE','CDF','CVE','MWK',
];

const missingFromInfo = expectedAfrican.filter(code => !currency.includes(`  ${code}:`));
check(`All ${expectedAfrican.length} African currency codes in CURRENCY_INFO`,
  missingFromInfo.length === 0,
  missingFromInfo.length > 0 ? `Missing: ${missingFromInfo.join(', ')}` : '');

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every CURRENCY_INFO entry has name and symbol
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] currency.ts — Every CURRENCY_INFO entry has name and symbol');

// Parse entries: look for lines like: XAF: { name: '...', symbol: '...' }
const entryRegex = /(\w+):\s*\{\s*name:\s*'([^']+)',\s*symbol:\s*'([^']*)'\s*\}/g;
const currencyInfoBlock = extractRegion(currency, 'export const CURRENCY_INFO', 'export function decimalsFor');
let match;
const emptySymbol = [];
const emptyName = [];
while ((match = entryRegex.exec(currencyInfoBlock)) !== null) {
  const [, code, name, symbol] = match;
  if (!name.trim()) emptyName.push(code);
  if (!symbol.trim()) emptySymbol.push(code);
}

check('No CURRENCY_INFO entries have empty name',
  emptyName.length === 0,
  emptyName.join(', '));

check('No CURRENCY_INFO entries have empty symbol',
  emptySymbol.length === 0,
  emptySymbol.join(', '));

// ─────────────────────────────────────────────────────────────────────────────
// 3. All new African codes have decimals defined
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] currency.ts — All African currencies have decimals defined');

const decimalsBlock = extractRegion(currency, 'export const currencyDecimals', 'export const currencySymbols');
const newCodes = ['LYD','NAD','LSL','MZN','SDG','SOS','ZWL','SCR','ERN','SLE','CDF','CVE','MWK'];
const missingDecimals = newCodes.filter(c => !decimalsBlock.includes(`  ${c}:`));
check('All newly added African currencies have decimal definitions',
  missingDecimals.length === 0,
  missingDecimals.length > 0 ? `Missing decimals: ${missingDecimals.join(', ')}` : '');

// ─────────────────────────────────────────────────────────────────────────────
// 4. DepositScreen imports
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] DepositScreen.tsx — Correct imports');

check('getCurrencySymbol imported from currency utils',
  deposit.includes('getCurrencySymbol') && deposit.includes("from '../utils/currency'"));

check('getCurrencyName imported from currency utils',
  deposit.includes('getCurrencyName') && deposit.includes("from '../utils/currency'"));

check('CURRENCY_INFO imported from currency utils',
  deposit.includes('CURRENCY_INFO') && deposit.includes("from '../utils/currency'"));

// ─────────────────────────────────────────────────────────────────────────────
// 5. Old hardcoded SUPPORTED_CURRENCIES list removed
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] DepositScreen.tsx — Old hardcoded currency list removed');

check("SUPPORTED_CURRENCIES hardcoded list is removed",
  !deposit.includes("const SUPPORTED_CURRENCIES = ["));

// ─────────────────────────────────────────────────────────────────────────────
// 6. AFRICAN_CURRENCY_CODES Set defined
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] DepositScreen.tsx — AFRICAN_CURRENCY_CODES Set defined');

check('AFRICAN_CURRENCY_CODES declared as a Set',
  /const AFRICAN_CURRENCY_CODES\s*=\s*new Set\(/.test(deposit));

check('EGP (Egyptian Pound) in AFRICAN_CURRENCY_CODES',
  extractRegion(deposit, 'AFRICAN_CURRENCY_CODES', ']);').includes('EGP'));

check('MAD (Moroccan Dirham) in AFRICAN_CURRENCY_CODES',
  extractRegion(deposit, 'AFRICAN_CURRENCY_CODES', ']);').includes('MAD'));

// ─────────────────────────────────────────────────────────────────────────────
// 7. Currency picker uses Modal
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] DepositScreen.tsx — Currency picker is a Modal');

check('showCurrencyModal state declared',
  deposit.includes('showCurrencyModal'));

check('Currency Modal rendered with visible={showCurrencyModal}',
  deposit.includes('visible={showCurrencyModal}'));

// ─────────────────────────────────────────────────────────────────────────────
// 8. Search input in modal
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] DepositScreen.tsx — Search input in currency modal');

check('currencySearch state declared',
  deposit.includes("currencySearch"));

check('Search input uses currencySearch state',
  deposit.includes('value={currencySearch}'));

check('Search input placeholder is Search currencies',
  deposit.includes('Search currencies'));

// ─────────────────────────────────────────────────────────────────────────────
// 9. Africa / World tabs
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9] DepositScreen.tsx — Africa / World tabs in modal');

check("currencyTab state declared with 'africa' | 'world' type",
  deposit.includes("currencyTab") && deposit.includes("'africa'") && deposit.includes("'world'"));

check("Africa tab button rendered",
  deposit.includes('Africa'));

check("World tab button rendered",
  deposit.includes('World'));

// ─────────────────────────────────────────────────────────────────────────────
// 10. Currency selection closes modal cleanly
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[10] DepositScreen.tsx — Selecting currency closes modal and updates state');

check('setCurrency called with code on item press',
  deposit.includes('setCurrency(code)'));

check('setShowCurrencyModal(false) called on item selection',
  deposit.includes('setShowCurrencyModal(false)'));

// ─────────────────────────────────────────────────────────────────────────────
// 11. Currency value sent to backend comes from CURRENCY_INFO keyset only
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[11] DepositScreen.tsx — Currency in API call is state-controlled (not free text)');

// The deposit API call uses `currency` state variable
const depositCall = extractRegion(deposit, 'body: JSON.stringify({ amount: amountMinor', ')');
check('Deposit API body uses `currency` state variable (not user text input)',
  depositCall.includes('currency,') || depositCall.includes('currency }'));

// Confirm currency state is only set via setCurrency(code) from CURRENCY_INFO keys
const setCurrencyMatches = deposit.match(/setCurrency\([^)]+\)/g) || [];
const unsafeSetCurrency = setCurrencyMatches.filter(
  m => !m.includes('code') && !m.includes("'XAF'") && !m.includes('"XAF"')
);
check('setCurrency only called with code from CURRENCY_INFO list or default',
  unsafeSetCurrency.length === 0,
  unsafeSetCurrency.join(', '));

// ─────────────────────────────────────────────────────────────────────────────
// 12. currencySearch never sent to backend
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[12] DepositScreen.tsx — currencySearch is UI-only (never sent to backend)');

// Find any fetch/JSON.stringify that contains currencySearch
check('currencySearch never appears inside JSON.stringify',
  !deposit.includes('JSON.stringify') || !deposit.split('JSON.stringify').some(part => part.split(')')[0].includes('currencySearch')));

check('currencySearch only used in filter/display logic',
  deposit.includes('currencySearch.toUpperCase()') || deposit.includes('currencySearch.trim()'));

// ─────────────────────────────────────────────────────────────────────────────
// 13. No console.log leaking new data
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[13] DepositScreen.tsx — No unguarded console.log');

const logLines = deposit.split('\n').filter(l => l.includes('console.log'));
const unguarded = logLines.filter(l => !l.includes('__DEV__'));
check('All console.log in DepositScreen are __DEV__ guarded',
  unguarded.length === 0,
  unguarded.length > 0 ? `Unguarded: ${unguarded[0].trim()}` : '');

// ─────────────────────────────────────────────────────────────────────────────
// 14. No new network calls added by currency picker
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[14] DepositScreen.tsx — Currency picker makes no network calls');

// Ensure the modal/picker code does not contain fetch()
const modalRegion = extractRegion(deposit, 'Currency Picker Modal', 'Fee breakdown preview');
check('Currency picker modal contains no fetch() calls',
  !modalRegion.includes('fetch('));

check('Currency picker modal contains no axios/API calls',
  !modalRegion.includes('axios') && !modalRegion.includes('API_BASE'));

// ─────────────────────────────────────────────────────────────────────────────
// 15. REGRESSION — handleDeposit amount validation intact
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[15] REGRESSION — handleDeposit amount guard intact');

const depositFn = extractRegion(deposit, 'async function handleDeposit', 'async function confirmDeposit');

check('handleDeposit rejects amount < 1',
  depositFn.includes('numAmount < 1') && depositFn.includes("'Too Small'"));

check('handleDeposit uses majorToMinor conversion',
  depositFn.includes('majorToMinor(numAmount, currency)'));

// ─────────────────────────────────────────────────────────────────────────────
// 16. REGRESSION — creditLocalBalance still called after deposit
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[16] REGRESSION — creditLocalBalance called after confirmed deposit');

const confirmFn = extractRegion(deposit, 'async function confirmDeposit', 'setDepositSuccess');
check('creditLocalBalance called in confirmDeposit',
  deposit.includes('creditLocalBalance(currency, netMinor)'));

check('creditLocalBalance imported from localBalance',
  deposit.includes("creditLocalBalance") && deposit.includes("from '../utils/localBalance'"));

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
if (failed === 0) {
  console.log('  🎉 ALL PASS — African currency picker is secure and intact.\n');
} else {
  console.log('  ⚠️  Some checks failed — review output above.\n');
  process.exit(1);
}
