'use strict';

const fs = require('fs');
const path = require('path');

const depositScreen = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'DepositScreen.tsx'),
  'utf8',
);
const stripeSdk = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'stripe', 'stripeSdk.ts'),
  'utf8',
);

module.exports = function depositFlowDirectStripe(check) {
  check(
    '[Deposit] Depositar button calls handleDeposit directly (no payment method modal)',
    /onPress=\{\(\) => \{ animatePress\(\); handleDeposit\(\); \}\}/.test(depositScreen),
  );

  check(
    '[Deposit] No fake in-app payment method modal or saved-card picker',
    !depositScreen.includes('showPaymentMethodModal') &&
    !depositScreen.includes('handleAddDepositMethod') &&
    !depositScreen.includes('savedPaymentMethods'),
  );

  check(
    '[Deposit] No PAN/CVC/bank fields collected in-app (Stripe PaymentSheet only)',
    !depositScreen.includes('cardNumber') &&
    !depositScreen.includes('cardCvc') &&
    !depositScreen.includes('bankAccountNum') &&
    !depositScreen.includes("t('deposit.cardNumber')"),
  );

  check(
    '[Deposit] PaymentSheet init + auto-present in one flow',
    depositScreen.includes('runDepositPaymentSheetOnce(') &&
    depositScreen.includes('startedForSecretRef'),
  );

  check(
    '[Deposit] PaymentSheet cancel clears stripe intent (no stuck spinner state)',
    depositScreen.includes('onCancel={clearStripeFlow}') &&
    depositScreen.includes('function clearStripeFlow()'),
  );

  check(
    '[Deposit] Card-only PaymentSheet options centralized in stripeSdk',
    /LinkDisplay\.NEVER/.test(stripeSdk) &&
    /allowsDelayedPaymentMethods:\s*false/.test(stripeSdk) &&
    /paymentMethodOrder:\s*\['card'\]/.test(stripeSdk),
  );
};
