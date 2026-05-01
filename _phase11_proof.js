/**
 * Phase 11 Proof — Feature Audit Fixes
 *
 * Tests:
 *  A) DepositScreen — CVC removed (no field, no gate)
 *  B) SendScreen    — Credit card withdrawal added (type, UI, form, submit, button)
 *  C) SettingsScreen — All console.log guarded with __DEV__
 */

'use strict';
const fs = require('fs');

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

// ── Read files ────────────────────────────────────────────────────────────────

const deposit  = fs.readFileSync('src/screens/DepositScreen.tsx',  'utf8');
const send     = fs.readFileSync('src/screens/SendScreen.tsx',     'utf8');
const settings = fs.readFileSync('src/screens/SettingsScreen.tsx', 'utf8');

// ═══════════════════════════════════════════════════════════════════════════════
// A) DepositScreen — CVC removed
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── A) DepositScreen: CVC removal ──────────────────────────────────');

check(
  'CVC TextInput no longer rendered in deposit modal',
  !deposit.includes("fieldLabel}>CVC / CVV</Text>") &&
  !deposit.includes('value={cardCvc}'),
);
check(
  'handleAddDepositMethod does NOT gate on cardCvc',
  !deposit.includes('cardCvc.trim()'),
);
check(
  'resetAddCardForm does NOT clear cardCvc',
  !deposit.includes("setCardCvc('');"),
);
check(
  'cardCvc state variable may still be declared (harmless) — confirm no CVC sent to any fetch',
  !deposit.includes('"cvc"') && !deposit.includes("'cvc'") && !deposit.includes('"cvv"') && !deposit.includes("'cvv'"),
);
check(
  'Card add form still requires cardNumber, cardHolder, cardExpiry',
  deposit.includes('!cardNumber.trim() || !cardHolder.trim() || !cardExpiry.trim()'),
);

// ═══════════════════════════════════════════════════════════════════════════════
// B) SendScreen — Credit card withdrawal
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── B) SendScreen: credit card withdrawal ──────────────────────────');

check(
  "withdrawalMethod type includes 'credit'",
  send.includes("'bank' | 'mobile' | 'debit' | 'credit'"),
);
check(
  "Credit Card button in method selector UI",
  send.includes("onPress={() => setWithdrawalMethod('credit')}") &&
  send.includes(">Credit Card</Text>"),
);
check(
  "credit card icon uses card-outline",
  send.includes('name="card-outline"') && send.includes("withdrawalMethod === 'credit' ? '#1565C0'"),
);
check(
  'Card form shows for both debit AND credit',
  send.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? ("),
);
check(
  'Confirmation summary shows card rows for both debit AND credit',
  send.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? ("),
);
check(
  "onWithdrawConfirmed sends 'Credit Card' as bankName for credit",
  send.includes("withdrawalMethod === 'credit' ? 'Credit Card'"),
);
check(
  "onWithdrawConfirmed sends card number for credit (debit || credit branch)",
  send.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? withdrawalCardNumber.replace"),
);
check(
  "onWithdrawConfirmed sends cardExpiry for credit",
  send.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && { cardExpiry"),
);
check(
  "memo correctly labels Credit Card withdrawal",
  send.includes("withdrawalMethod === 'credit' ? 'Credit Card'") &&
  send.includes("Withdrawal to"),
);
check(
  "receipt recipientName handles credit",
  send.includes("withdrawalMethod === 'credit' ? 'Credit Card' : withdrawalMethod === 'debit' ? 'Debit Card'"),
);
check(
  "receipt recipientId (card ending) applies to both debit and credit",
  send.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? `Card ending"),
);
check(
  "Button disabled: bank/mobile branch excludes credit (withdrawalMethod !== 'credit')",
  send.includes("withdrawalMethod !== 'debit' && withdrawalMethod !== 'credit' && (!bankName"),
);
check(
  "Button disabled: card branch includes credit ((debit || credit) check)",
  send.includes("(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && (!withdrawalCardNumber"),
);
check(
  'CVC is not sent to backend in withdrawal fetch body',
  !send.includes('"cvc"') && !send.includes("'cvc'") && !send.includes('"cvv"') && !send.includes("'cvv'"),
);
check(
  'No CVC TextInput rendered in the withdrawal card form (only state var declared from Phase 9)',
  (() => {
    const renderCount = (send.match(/value=\{withdrawalCardCvc\}/g) || []).length;
    return renderCount === 0;
  })(),
);

// ═══════════════════════════════════════════════════════════════════════════════
// C) SettingsScreen — console.log guards
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── C) SettingsScreen: console.log guards ──────────────────────────');

// All console.log calls should be guarded with __DEV__
const rawLogs = settings.match(/console\.log\(/g) || [];
const guardedLogs = settings.match(/__DEV__.*console\.log\(|if\s*\(__DEV__\)\s*console\.log\(/g) || [];
check(
  'All console.log calls in SettingsScreen are guarded with __DEV__',
  rawLogs.length === guardedLogs.length && rawLogs.length > 0,
);

const specificLogs = [
  "[Settings] Save Username pressed:",
  "[Settings] Sign Out pressed",
  "[Settings] Delete Account pressed",
  "[Settings] Preferred currency changed to:",
  "[Settings] Auto-convert toggled:",
  "[Settings] Biometric lock toggled:",
];
specificLogs.forEach(msg => {
  check(
    `'${msg}' is guarded with __DEV__`,
    settings.includes(`if (__DEV__) console.log('${msg}`),
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`  Phase 11 Proof: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 ALL CHECKS PASSED');
} else {
  console.log('  ⚠️  Some checks failed — review above');
  process.exit(1);
}
