/**
 * Phase 11 regression guards
 *
 * Invariants protected:
 *  A. DepositScreen — CVC field removed from add-card modal, no CVC gate
 *  B. SendScreen — Credit card withdrawal method present and fully wired
 *  C. SettingsScreen — All console.log calls guarded with __DEV__
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DEPOSIT  = fs.readFileSync(path.resolve(__dirname, '../../src/screens/DepositScreen.tsx'),  'utf8');
const SEND     = fs.readFileSync(path.resolve(__dirname, '../../src/screens/SendScreen.tsx'),     'utf8');
const SETTINGS = fs.readFileSync(path.resolve(__dirname, '../../src/screens/SettingsScreen.tsx'), 'utf8');

module.exports = function phase11(check) {
  // ════════════════════════════════════════════════════════════════════════════
  // A) DepositScreen — Stripe-only deposit (no fake card modal)
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Deposit] Depositar goes straight to handleDeposit (no payment method modal)',
    DEPOSIT.includes('animatePress(); handleDeposit()') &&
    !DEPOSIT.includes('showPaymentMethodModal'),
  );
  check(
    '[Deposit] No in-app PAN/CVC/bank collection for deposits',
    !DEPOSIT.includes('cardNumber') &&
    !DEPOSIT.includes('cardCvc') &&
    !DEPOSIT.includes('handleAddDepositMethod'),
  );
  check(
    '[Deposit] Stripe PaymentSheet auto-presents after create-intent',
    DEPOSIT.includes('presentPaymentSheet()') &&
    DEPOSIT.includes('buildCardOnlyPaymentSheetParams('),
  );
  check(
    '[Deposit] Card data is NOT sent raw in any fetch body',
    !DEPOSIT.includes('"cvc"') && !DEPOSIT.includes("'cvc'") &&
    !DEPOSIT.includes('"cvv"') && !DEPOSIT.includes("'cvv'"),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // B) SendScreen — Credit card withdrawal
  // ════════════════════════════════════════════════════════════════════════════

  check(
    "[Send] withdrawalMethod type union includes 'credit'",
    SEND.includes("'bank' | 'mobile' | 'debit' | 'credit'"),
  );
  check(
    '[Send] Credit Card picker button present in withdrawal method selector',
    SEND.includes("onPress={() => setWithdrawalMethod('credit')}") &&
    SEND.includes("send.creditCard"),
  );
  check(
    '[Send] Card form renders for both debit and credit',
    SEND.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? ("),
  );
  check(
    "[Send] onWithdrawConfirmed sends 'Credit Card' as bankName for credit method",
    SEND.includes("withdrawalMethod === 'credit' ? 'Credit Card'"),
  );
  check(
    '[Send] onWithdrawConfirmed sends last4 only for credit/debit (never full PAN)',
    SEND.includes('const cardLast4 = withdrawalCardNumber.replace') &&
    SEND.includes('cardLast4') &&
    !SEND.includes('? withdrawalCardNumber'),
  );
  check(
    '[Send] onWithdrawConfirmed sends cardExpiry for credit',
    SEND.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && { cardExpiry"),
  );
  check(
    '[Send] Withdrawal button disabled logic excludes credit from bank/mobile branch',
    SEND.includes("withdrawalMethod !== 'debit' && withdrawalMethod !== 'credit' && (!bankName"),
  );
  check(
    '[Send] Withdrawal button disabled logic includes credit in card branch',
    SEND.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && (!withdrawalCardNumber"),
  );
  check(
    '[Send] No CVC sent in credit card withdrawal path',
    !SEND.includes('"cvc"') && !SEND.includes("'cvc'") &&
    !SEND.includes('"cvv"') && !SEND.includes("'cvv'"),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // C) SettingsScreen — console.log guards
  // ════════════════════════════════════════════════════════════════════════════

  const rawLogs     = (SETTINGS.match(/console\.log\(/g) || []).length;
  const guardedLogs = (SETTINGS.match(/if\s*\(__DEV__\)\s*console\.log\(/g) || []).length;
  check(
    '[Settings] Every console.log call is guarded with __DEV__',
    rawLogs > 0 && rawLogs === guardedLogs,
  );

  const sensitiveGuards = [
    { msg: 'Save Username pressed',   label: 'username save (contains username value)' },
    { msg: 'Preferred currency changed', label: 'currency change' },
    { msg: 'Auto-convert toggled',    label: 'auto-convert toggle' },
    { msg: 'Biometric lock toggled',  label: 'biometric toggle' },
  ];
  sensitiveGuards.forEach(({ msg, label }) => {
    check(
      `[Settings] Production log suppressed — ${label}`,
      SETTINGS.includes(`if (__DEV__) console.log('[Settings] ${msg}`),
    );
  });
};
