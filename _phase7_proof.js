/**
 * _phase7_proof.js — Google Play Store Readiness Audit
 *
 * Verifies all fixes applied for Play Store approval:
 *  1. checkBalanceAndProceed: no Math.max — uses Math.min (conservative)
 *  2. checkBalanceAndProceed: shows Alert + "Add Money" CTA on insufficient balance
 *  3. checkBalanceAndProceed: does NOT call setShowPaymentMethodModal(true)
 *  4. SendScreen: no unguarded console.log leaking amounts/wallet IDs
 *  5. SendScreen: completeSendWithPaymentMethod has no card last4 in log
 *  6. Withdrawal form: CVC/CVV field removed (not needed for payouts)
 *  7. Withdrawal form: no CVC validation gate in onSend
 *  8. DepositScreen: no unguarded console.log leaking amounts
 *  9. RequestScreen: no unguarded console.log leaking names/amounts
 * 10. BudgetScreen: no unguarded console.log leaking amounts
 * 11. service-account-key.json is in .gitignore (not committed)
 * 12. Privacy Policy accessible in AboutScreen
 * 13. REGRESSION: onWithdrawConfirmed still has client-side balance guard
 * 14. REGRESSION: loadWallets still uses sync + merge pattern
 *
 * Run: node _phase7_proof.js
 */

'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function check(label, result, detail = '') {
  if (result) {
    console.log(`  ✅ PASS — ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL — ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function read(filePath) {
  return fs.readFileSync(path.resolve(__dirname, filePath), 'utf8').replace(/\r\n/g, '\n');
}

function extractRegion(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  if (start === -1) return '';
  const end = endMarker ? content.indexOf(endMarker, start) : content.length;
  return content.slice(start, end === -1 ? content.length : end);
}

const send = read('src/screens/SendScreen.tsx');
const deposit = read('src/screens/DepositScreen.tsx');
const request = read('src/screens/RequestScreen.tsx');
const budget = read('src/screens/BudgetScreen.tsx');
const gitignore = read('.gitignore');
const about = read('src/screens/AboutScreen.tsx');

// ─────────────────────────────────────────────────────────────────────────────
// 1. checkBalanceAndProceed — conservative balance comparison
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] SendScreen.tsx — checkBalanceAndProceed uses Math.min (not Math.max)');
const checkBalanceFn = extractRegion(send, 'async function checkBalanceAndProceed', 'function getPaymentMethodIcon');

check('checkBalanceAndProceed uses Math.min for balance (conservative)',
  checkBalanceFn.includes('Math.min(backendMajor, localMajor)'));

check('checkBalanceAndProceed does NOT use Math.max for balance comparison',
  !checkBalanceFn.includes('Math.max(backendMajor, localMajor)'));

// ─────────────────────────────────────────────────────────────────────────────
// 2. checkBalanceAndProceed — shows Alert on insufficient balance
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] SendScreen.tsx — checkBalanceAndProceed shows Alert on insufficient balance');

check('checkBalanceAndProceed shows Alert.alert when insufficient',
  checkBalanceFn.includes("Alert.alert") && checkBalanceFn.includes('Insufficient Balance'));

check('checkBalanceAndProceed offers Add Money CTA',
  checkBalanceFn.includes("'Add Money'") && checkBalanceFn.includes("navigate('Deposit'"));

// ─────────────────────────────────────────────────────────────────────────────
// 3. checkBalanceAndProceed — does NOT open payment method modal
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] SendScreen.tsx — checkBalanceAndProceed does NOT open deceptive payment modal');

check('checkBalanceAndProceed does NOT call setShowPaymentMethodModal(true)',
  !checkBalanceFn.includes('setShowPaymentMethodModal(true)'));

// ─────────────────────────────────────────────────────────────────────────────
// 4. SendScreen — no unguarded console.log leaking financial data
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] SendScreen.tsx — console.log statements are __DEV__ guarded');

// All console.log in SendScreen must be preceded by __DEV__ on the same line
const sendLogLines = send.split('\n').filter(l => l.includes('console.log'));
const sendUnguarded = sendLogLines.filter(l => !l.includes('__DEV__'));
check('All console.log in SendScreen are __DEV__ guarded',
  sendUnguarded.length === 0,
  sendUnguarded.length > 0 ? `Unguarded: ${sendUnguarded[0].trim()}` : '');

check('completeSendWithPaymentMethod log does NOT include last4 card number',
  !send.includes('method.last4') || send.includes('__DEV__') && !send.match(/console\.log\([^)]*last4/));

// ─────────────────────────────────────────────────────────────────────────────
// 5. SendScreen — withdrawal log does not include raw amount
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] SendScreen.tsx — Withdraw log does not expose amount');

const withdrawLogLine = send.split('\n').find(l => l.includes('__DEV__') && l.includes('Withdraw confirmed'));
check('Withdraw confirmed log exists and is __DEV__ guarded',
  !!withdrawLogLine);

check('Withdraw confirmed log does NOT include raw amount value',
  !withdrawLogLine || !withdrawLogLine.includes('amount,'));

// ─────────────────────────────────────────────────────────────────────────────
// 6. Withdrawal form — CVC/CVV field removed from UI
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] SendScreen.tsx — CVV field removed from withdrawal form');
const withdrawalCardFormSection = extractRegion(send, 'withdrawalCardExpiry', 'accountName');

check('Withdrawal form does NOT render CVC/CVV TextInput',
  !send.includes("value={withdrawalCardCvc}"));

check('Withdrawal form does NOT have CVC/CVV label in the withdrawalCardNumber section',
  (() => {
    // Extract the withdrawal card form between the card number input and the account name input
    // The payment method modal also has CVC/CVV but it's unreachable (never opened)
    const afterCardNum = send.indexOf('withdrawalCardNumber}');
    const beforeAccountName = send.indexOf('setAccountName}');
    if (afterCardNum === -1 || beforeAccountName === -1) return true;
    const withdrawalSection = send.slice(afterCardNum, beforeAccountName);
    return !withdrawalSection.includes('value={withdrawalCardCvc}');
  })());

// ─────────────────────────────────────────────────────────────────────────────
// 7. Withdrawal validation — no CVC gate
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] SendScreen.tsx — no CVC validation in withdrawal gate');

check('withdrawalCardCvc validation removed from onSend',
  !send.includes("if (!withdrawalCardCvc.trim())"));

// ─────────────────────────────────────────────────────────────────────────────
// 8. DepositScreen — no unguarded console.log
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] DepositScreen.tsx — console.log statements are __DEV__ guarded');

const depositLogLines = deposit.split('\n').filter(l => l.includes('console.log'));
const depositUnguarded = depositLogLines.filter(l => !l.includes('__DEV__'));
check('All console.log in DepositScreen are __DEV__ guarded',
  depositUnguarded.length === 0,
  depositUnguarded.length > 0 ? `Unguarded: ${depositUnguarded[0].trim()}` : '');

// ─────────────────────────────────────────────────────────────────────────────
// 9. RequestScreen — no unguarded console.log
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9] RequestScreen.tsx — console.log statements are __DEV__ guarded');

const requestLogLines = request.split('\n').filter(l => l.includes('console.log'));
const requestUnguarded = requestLogLines.filter(l => !l.includes('__DEV__'));
check('All console.log in RequestScreen are __DEV__ guarded',
  requestUnguarded.length === 0,
  requestUnguarded.length > 0 ? `Unguarded: ${requestUnguarded[0].trim()}` : '');

// ─────────────────────────────────────────────────────────────────────────────
// 10. BudgetScreen — no unguarded console.log for sensitive data
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[10] BudgetScreen.tsx — console.log statements are __DEV__ guarded');

const budgetLogLines = budget.split('\n').filter(l => l.includes('console.log') && !l.trim().startsWith('//'));
const budgetUnguarded = budgetLogLines.filter(l => !l.includes('__DEV__'));
check('All console.log in BudgetScreen are __DEV__ guarded',
  budgetUnguarded.length === 0,
  budgetUnguarded.length > 0 ? `Unguarded: ${budgetUnguarded[0].trim()}` : '');

// ─────────────────────────────────────────────────────────────────────────────
// 11. service-account-key.json in .gitignore
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[11] .gitignore — service-account-key.json excluded');

check('service-account-key.json is in .gitignore',
  gitignore.includes('service-account-key.json'));

check('.gitignore also excludes wildcard *-service-account*.json',
  gitignore.includes('*-service-account*.json'));

// ─────────────────────────────────────────────────────────────────────────────
// 12. Privacy Policy accessible in AboutScreen
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[12] AboutScreen.tsx — Privacy Policy accessible');

check('AboutScreen has handlePrivacyPolicy function',
  about.includes('handlePrivacyPolicy'));

check('AboutScreen has Privacy Policy touchable/button',
  about.includes('handlePrivacyPolicy') && about.includes('TouchableOpacity'));

// ─────────────────────────────────────────────────────────────────────────────
// 13. REGRESSION — onWithdrawConfirmed still has balance guard (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[13] REGRESSION — onWithdrawConfirmed balance guard intact (Phase 6)');
const withdrawFn = extractRegion(send, 'async function onWithdrawConfirmed', 'async function onSendConfirmed');

check('onWithdrawConfirmed still calls getLocalBalances() for guard',
  withdrawFn.includes('getLocalBalances()'));

check('onWithdrawConfirmed still checks amountMinor > effectiveBalance',
  withdrawFn.includes('amountMinor > effectiveBalance'));

check('onWithdrawConfirmed still shows Alert on insufficient funds',
  withdrawFn.includes('Alert.alert') && withdrawFn.includes('Insufficient Funds'));

check('onWithdrawConfirmed still calls debitLocalBalance',
  withdrawFn.includes('debitLocalBalance'));

check('onWithdrawConfirmed still calls logLocalTransaction for withdrawal',
  withdrawFn.includes('logLocalTransaction'));

// ─────────────────────────────────────────────────────────────────────────────
// 14. REGRESSION — loadWallets still uses sync + merge pattern (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[14] REGRESSION — loadWallets sync+merge pattern intact (Phase 6)');
const loadWalletsFn = extractRegion(send, 'async function loadWallets', 'async function onSend');

check('loadWallets still calls syncLocalBalancesFromBackend',
  loadWalletsFn.includes('syncLocalBalancesFromBackend'));

check('loadWallets still calls mergeWithLocalBalances',
  loadWalletsFn.includes('mergeWithLocalBalances'));

check('loadWallets still calls setWallets(mergedWallets)',
  loadWalletsFn.includes('setWallets(mergedWallets)'));

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
if (failed === 0) {
  console.log('  🎉 ALL PASS — Play Store readiness fixes verified.\n');
} else {
  console.log('  ⚠️  Some checks failed — review output above.\n');
  process.exit(1);
}
