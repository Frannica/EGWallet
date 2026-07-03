'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { minDepositMajor, minDepositMinor } = require('../depositLimits');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const depositScreen = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'screens', 'DepositScreen.tsx'),
  'utf8',
);

test('USD $1 deposit uses 100 minor units', () => {
  assert.equal(minDepositMajor('USD'), 1);
  assert.equal(minDepositMinor('USD'), 100);
});

test('XAF 1 FCFA is below minimum (100 minor)', () => {
  assert.equal(minDepositMajor('XAF'), 100);
  assert.equal(minDepositMinor('XAF'), 100);
  assert.ok(1 < minDepositMinor('XAF'));
});

test('create-intent uses card-only PaymentIntent (no automatic_payment_methods)', () => {
  const block = indexSource.match(/app\.post\('\/deposits\/create-intent'[\s\S]*?app\.post\('\/deposits\/confirm'/);
  assert.ok(block, 'create-intent route block found');
  assert.match(block[0], /payment_method_types:\s*\['card'\]/);
  assert.doesNotMatch(block[0], /automatic_payment_methods:\s*\{\s*enabled:\s*true\s*\}/);
});

test('create-intent returns error_deposit_minimum instead of generic validation for small XAF', () => {
  assert.match(indexSource, /error_deposit_minimum/);
  assert.match(indexSource, /minDepositMinor\(currency\)/);
});

test('DepositScreen PaymentSheet disables Link and delayed methods', () => {
  assert.match(depositScreen, /allowsDelayedPaymentMethods:\s*false/);
  assert.match(depositScreen, /link:\s*\{\s*display:\s*LinkDisplay\.NEVER\s*\}/);
  assert.match(depositScreen, /paymentMethodOrder:\s*\['card'\]/);
});

test('DepositScreen validates currency-aware minimum before API', () => {
  assert.match(depositScreen, /minDepositMajor\(currency\)/);
  assert.match(depositScreen, /formatMinDepositLabel\(currency\)/);
});
