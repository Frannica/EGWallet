'use strict';

const fs = require('fs');
const path = require('path');

const stripeSdk = fs.readFileSync(path.join(__dirname, '..', 'src', 'stripe', 'stripeSdk.ts'), 'utf8');
const depositScreen = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'DepositScreen.tsx'),
  'utf8',
);

module.exports = function paymentSheetCardOnly(check) {
  check('stripeSdk exports centralized card-only PaymentSheet options',
    stripeSdk.includes('CARD_ONLY_PAYMENT_SHEET_OPTIONS') &&
    /allowsDelayedPaymentMethods:\s*false/.test(stripeSdk) &&
    /display:\s*LinkDisplay\.NEVER/.test(stripeSdk) &&
    /paymentMethodOrder:\s*\['card'\]/.test(stripeSdk) &&
    stripeSdk.includes('buildCardOnlyPaymentSheetParams'));

  check('DepositScreen initializes PaymentSheet through card-only helper',
    depositScreen.includes('runDepositPaymentSheetOnce(') &&
    !/link:\s*\{\s*display:\s*LinkDisplay\.NEVER/.test(depositScreen));

  check('DepositScreen auto-presents PaymentSheet (no second pay button)',
    depositScreen.includes('runDepositPaymentSheetOnce(') &&
    !depositScreen.includes('showPaymentMethodModal') &&
    !depositScreen.includes('handleAddDepositMethod'));
};
