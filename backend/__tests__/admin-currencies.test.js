'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  SUPPORTED_CURRENCY_CODES,
  CURRENCY_INFO,
  normalizeWalletBalances,
  currencyFilterOptions,
} = require('../supportedCurrencies');

function parseMobileCurrencyInfoKeys() {
  const currencyTs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'utils', 'currency.ts'),
    'utf8',
  );
  const block = currencyTs.match(/export const CURRENCY_INFO[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'CURRENCY_INFO block not found in src/utils/currency.ts');
  const keys = [...block[1].matchAll(/^\s{2}([A-Z]{3}):\s*\{/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'No currency keys parsed from mobile CURRENCY_INFO');
  return keys.sort();
}

test('egwallet-currencies.json matches mobile CURRENCY_INFO keys', () => {
  const jsonKeys = Object.keys(require('../egwallet-currencies.json')).sort();
  const mobileKeys = parseMobileCurrencyInfoKeys();
  assert.deepEqual(jsonKeys, mobileKeys);
});

test('admin SUPPORTED_CURRENCY_CODES matches mobile CURRENCY_INFO keys', () => {
  const mobileKeys = parseMobileCurrencyInfoKeys();
  const adminKeys = [...SUPPORTED_CURRENCY_CODES].sort();
  assert.deepEqual(adminKeys, mobileKeys);
});

test('every supported currency has name metadata', () => {
  for (const code of SUPPORTED_CURRENCY_CODES) {
    assert.ok(CURRENCY_INFO[code]?.name, `missing name for ${code}`);
  }
});

test('normalizeWalletBalances includes zero balances for all supported currencies', () => {
  const rows = normalizeWalletBalances([{ currency: 'USD', amount: 1000 }]);
  assert.equal(rows.length, SUPPORTED_CURRENCY_CODES.length);
  assert.equal(rows.find((r) => r.currency === 'USD').amount, 1000);
  assert.equal(rows.find((r) => r.currency === 'NGN').amount, 0);
});

test('currencyFilterOptions only lists EGWallet-supported currencies', () => {
  const options = currencyFilterOptions('All');
  const codes = options.filter((o) => o.value).map((o) => o.value);
  assert.deepEqual(codes, SUPPORTED_CURRENCY_CODES);
  assert.equal(options[0].value, '');
});

test('no unsupported world currencies in admin list', () => {
  const extras = ['IRR', 'IQD', 'MMK', 'LKR', 'BYN', 'ALL'];
  for (const code of extras) {
    assert.ok(!SUPPORTED_CURRENCY_CODES.includes(code), `${code} should not be supported`);
  }
});
