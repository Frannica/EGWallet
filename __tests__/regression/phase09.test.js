/**
 * Phase 09 regression guards
 *
 * Invariants protected:
 *  1. Debit card SEND button is not permanently disabled due to CVC gate
 *  2. CVC / CVV field is removed from the SendScreen payment-method modal
 *  3. No CVC data is ever sent to any backend endpoint from SendScreen
 *  4. Credit card type exists in PaymentMethod union (used for transfers)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SEND = fs.readFileSync(
  path.resolve(__dirname, '../../src/screens/SendScreen.tsx'),
  'utf8',
);

module.exports = function phase09(check) {
  // ── 1. Send button disabled condition must NOT include !withdrawalCardCvc ──
  // The button's disabled prop/style should not gate on withdrawalCardCvc being truthy.
  check(
    'Send button disabled condition does not gate on !withdrawalCardCvc',
    !SEND.includes('!withdrawalCardCvc'),
  );

  // ── 2. CVC TextInput no longer rendered in payment-method add modal ────────
  check(
    'CVC / CVV TextInput is not rendered in SendScreen payment-method modal',
    !SEND.includes("fieldLabel}>CVC / CVV</Text>"),
  );

  // ── 3. No raw CVC value sent to any backend fetch body ────────────────────
  check(
    'CVC value not included in any fetch/JSON body in SendScreen',
    !SEND.includes('"cvc"') && !SEND.includes("'cvc'") &&
    !SEND.includes('"cvv"') && !SEND.includes("'cvv'"),
  );
  check(
    'withdrawalCardCvc state is not rendered as a TextInput value',
    !(SEND.match(/value=\{withdrawalCardCvc\}/g) || []).length,
  );

  // ── 4. Card type union includes 'credit' for transfers ────────────────────
  check(
    "PaymentMethod type includes 'credit' for transfer payment methods",
    SEND.includes("type: 'debit' | 'credit' | 'bank'"),
  );
};
