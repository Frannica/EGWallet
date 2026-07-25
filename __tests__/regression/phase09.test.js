/**
 * Phase 09 regression guards (updated for card-withdrawal removal)
 *
 * Original invariants (CVC never collected / never sent) still hold.
 * Additionally: debit/credit card withdrawal options and the dead
 * "pay with card" payment-method modal are fully removed — EGWallet has
 * no capability to push funds to an arbitrary user-entered card.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SEND = fs.readFileSync(
  path.resolve(__dirname, '../../src/screens/SendScreen.tsx'),
  'utf8',
);

module.exports = function phase09(check) {
  check(
    'Send button disabled condition does not gate on !withdrawalCardCvc',
    !SEND.includes('!withdrawalCardCvc'),
  );

  check(
    'CVC / CVV TextInput is not rendered in SendScreen',
    !SEND.includes('CVC / CVV') && !SEND.includes('withdrawalCardCvc'),
  );

  check(
    'CVC value not included in any fetch/JSON body in SendScreen',
    !SEND.includes('"cvc"') && !SEND.includes("'cvc'") &&
    !SEND.includes('"cvv"') && !SEND.includes("'cvv'"),
  );

  check(
    'Debit/credit card withdrawal methods are removed from SendScreen',
    !SEND.includes("setWithdrawalMethod('debit')") &&
    !SEND.includes("setWithdrawalMethod('credit')") &&
    !SEND.includes('withdrawalCardNumber'),
  );

  check(
    'Withdrawal method type is only bank | mobile',
    SEND.includes("useState<'bank' | 'mobile'>('mobile')") ||
    SEND.includes('useState<\'bank\' | \'mobile\'>(\'mobile\')'),
  );

  check(
    'Dead pay-with-card payment-method modal is removed',
    !SEND.includes('showPaymentMethodModal') &&
    !SEND.includes('completeSendWithPaymentMethod') &&
    !SEND.includes("type: 'debit' | 'credit' | 'bank'"),
  );
};
