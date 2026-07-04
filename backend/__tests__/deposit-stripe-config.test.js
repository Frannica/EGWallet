'use strict';

const fs = require('fs');
const path = require('path');
const { minDepositMajor, minDepositMinor } = require('../depositLimits');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const depositScreen = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'screens', 'DepositScreen.tsx'),
  'utf8',
);
const stripeSdk = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'stripe', 'stripeSdk.ts'),
  'utf8',
);

module.exports = function depositStripeConfig(check) {
  check('USD $1 deposit uses 100 minor units', minDepositMajor('USD') === 1 && minDepositMinor('USD') === 100);

  check('XAF 1 FCFA is below minimum (100 minor)', minDepositMajor('XAF') === 100 && minDepositMinor('XAF') === 100 && 1 < minDepositMinor('XAF'));

  check('create-intent uses card-only PaymentIntent (no automatic_payment_methods)', (() => {
    const block = indexSource.match(/app\.post\('\/deposits\/create-intent'[\s\S]*?app\.post\('\/deposits\/confirm'/);
    if (!block) return false;
    return /payment_method_types:\s*\['card'\]/.test(block[0]) &&
      !/automatic_payment_methods:\s*\{\s*enabled:\s*true\s*\}/.test(block[0]);
  })());

  check('create-intent returns error_deposit_minimum instead of generic validation for small XAF',
    /error_deposit_minimum/.test(indexSource) && /minDepositMinor\(currency\)/.test(indexSource));

  check('DepositScreen PaymentSheet disables Link and delayed methods',
    /buildCardOnlyPaymentSheetParams\(/.test(depositScreen) &&
    /allowsDelayedPaymentMethods:\s*false/.test(stripeSdk) &&
    /link:\s*\{\s*display:\s*LinkDisplay\.NEVER\s*\}/.test(stripeSdk) &&
    /paymentMethodOrder:\s*\['card'\]/.test(stripeSdk));

  check('DepositScreen validates currency-aware minimum before API',
    /minDepositMajor\(currency\)/.test(depositScreen) &&
    /formatMinDepositLabel\(currency\)/.test(depositScreen));

  check('DepositScreen skips fake payment UI — Depositar calls handleDeposit',
    /animatePress\(\); handleDeposit\(\)/.test(depositScreen) &&
    !/showPaymentMethodModal/.test(depositScreen) &&
    !/cardNumber/.test(depositScreen));
};
