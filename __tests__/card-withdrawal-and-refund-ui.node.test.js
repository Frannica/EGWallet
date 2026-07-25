'use strict';
/**
 * Frontend source-level checks (check-style module for run-all.js):
 *  1. Debit/credit card withdrawals are gone from SendScreen
 *  2. Refund UI is wired (TransactionHistory + RefundScreen + navigator + i18n)
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const send = fs.readFileSync(path.join(root, 'src', 'screens', 'SendScreen.tsx'), 'utf8');
const history = fs.readFileSync(path.join(root, 'src', 'screens', 'TransactionHistory.tsx'), 'utf8');
const refundScreen = fs.readFileSync(path.join(root, 'src', 'screens', 'RefundScreen.tsx'), 'utf8');
const nav = fs.readFileSync(path.join(root, 'src', 'navigation', 'AppNavigator.tsx'), 'utf8');
const api = fs.readFileSync(path.join(root, 'src', 'api', 'refunds.ts'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'src', 'i18n', 'translations.ts'), 'utf8');

module.exports = function cardWithdrawalAndRefundUi(check) {
  check(
    'SendScreen has no debit/credit withdrawal method options',
    !/setWithdrawalMethod\(['"]debit['"]\)/.test(send) &&
    !/setWithdrawalMethod\(['"]credit['"]\)/.test(send) &&
    !send.includes('withdrawalCardNumber'),
  );

  check(
    'SendScreen default withdrawal method is mobile (real payout path)',
    /useState<'bank'\s*\|\s*'mobile'>\('mobile'\)/.test(send),
  );

  check(
    'TransactionHistory shows Refund only for Stripe deposits with pi_ intent',
    history.includes('isStripeDeposit') &&
    history.includes("navigate('Refund'") &&
    history.includes("stripeIntentId.startsWith('pi_')"),
  );

  check(
    'RefundScreen states original payment method only and supports full/partial',
    refundScreen.includes('refund.destinationNotice') &&
    refundScreen.includes('requestRefund') &&
    refundScreen.includes('amountMode'),
  );

  check(
    'AppNavigator registers Refund screen',
    nav.includes('import RefundScreen') && nav.includes('name="Refund"'),
  );

  check(
    'refunds API never sends a destination card field',
    !/cardNumber|destinationCard|paymentMethodId/.test(api) &&
    api.includes('Idempotency-Key') &&
    api.includes('depositTransactionId'),
  );

  const keys = [
    'refund.screenTitle',
    'refund.button',
    'refund.destinationNotice',
    'refund.submit',
    'refund.confirmMsg',
  ];
  let allPresent = true;
  for (const key of keys) {
    const matches = i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) || [];
    if (matches.length !== 7) allPresent = false;
  }
  check('refund i18n keys exist in all 7 languages', allPresent);
};
