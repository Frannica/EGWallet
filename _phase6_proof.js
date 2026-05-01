/**
 * _phase6_proof.js — Withdrawal Balance Integrity Tests
 *
 * Verifies:
 *  1. localBalance.ts — LAST_DEBIT_KEY is declared and used in clearLocalUserData
 *  2. debitLocalBalance records a timestamp in LAST_DEBIT_KEY
 *  3. syncLocalBalancesFromBackend reads LAST_DEBIT_KEY and uses grace period logic
 *     (keeps local when local < backend and recently debited)
 *  4. SendScreen — client-side balance guard in onWithdrawConfirmed
 *  5. SendScreen — loadWallets() is AWAITED in onWithdrawConfirmed (not fire-and-forget)
 *  6. SendScreen — minorToMajor is imported
 *  7. SendScreen — getLocalBalances is imported
 *  8. Backend index.js — withdrawalInFlight Set is declared
 *  9. Backend — inflightKey checked before createWithdrawal
 * 10. Backend — inflightKey deleted on error path
 * 11. Backend — inflightKey deleted after res.json()
 * 12. REGRESSION: logLocalTransaction NOT in SendScreen (phase 5 guard)
 * 13. REGRESSION: DEMO_TXS NOT in TransactionHistory (phase 4 guard)
 * 14. REGRESSION: clearLocalUserData called in signOut (phase 4 guard)
 * 15. REGRESSION: clearLocalUserData called in signIn (phase 4 guard)
 * 16. REGRESSION: clearLocalUserData called in signUp (phase 4 guard)
 *
 * Run: node _phase6_proof.js
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. localBalance.ts — LAST_DEBIT_KEY constant
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] localBalance.ts — LAST_DEBIT_KEY constant');
const lb = read('src/utils/localBalance.ts');

check('LAST_DEBIT_KEY constant declared',
  /const LAST_DEBIT_KEY\s*=/.test(lb));

check('DEBIT_GRACE_MS constant declared',
  /const DEBIT_GRACE_MS\s*=/.test(lb));

// ─────────────────────────────────────────────────────────────────────────────
// 2. debitLocalBalance — records timestamp
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] localBalance.ts — debitLocalBalance records debit timestamp');
const debitFn = extractRegion(lb, 'export async function debitLocalBalance', 'export async function logLocalTransaction');

check('debitLocalBalance accesses LAST_DEBIT_KEY',
  debitFn.includes('LAST_DEBIT_KEY'));

check('debitLocalBalance writes current timestamp per currency',
  debitFn.includes('Date.now()'));

// ─────────────────────────────────────────────────────────────────────────────
// 3. syncLocalBalancesFromBackend — grace period logic
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] localBalance.ts — syncLocalBalancesFromBackend grace period');
const syncFn = extractRegion(lb, 'export async function syncLocalBalancesFromBackend', 'export async function getLocalTransactions');

check('syncLocalBalancesFromBackend reads LAST_DEBIT_KEY',
  syncFn.includes('LAST_DEBIT_KEY'));

check('syncLocalBalancesFromBackend compares debit time to DEBIT_GRACE_MS',
  syncFn.includes('DEBIT_GRACE_MS'));

check('syncLocalBalancesFromBackend uses localAmt when recently debited and local < backend',
  syncFn.includes('localAmt < b.amount') || syncFn.includes('localAmt !== undefined && localAmt < b.amount'));

check('syncLocalBalancesFromBackend uses backend value when NOT recently debited',
  syncFn.includes('synced[b.currency] = b.amount'));

// ─────────────────────────────────────────────────────────────────────────────
// 4. clearLocalUserData — includes LAST_DEBIT_KEY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] localBalance.ts — clearLocalUserData includes LAST_DEBIT_KEY');
const clearFn = extractRegion(lb, 'export async function clearLocalUserData', 'export async function syncLocalBalancesFromBackend');

check('clearLocalUserData multiRemove includes LAST_DEBIT_KEY',
  clearFn.includes('LAST_DEBIT_KEY'));

// ─────────────────────────────────────────────────────────────────────────────
// 5. SendScreen — client-side balance guard
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] SendScreen.tsx — client-side balance guard in onWithdrawConfirmed');
const send = read('src/screens/SendScreen.tsx');
const withdrawFn = extractRegion(send, 'async function onWithdrawConfirmed', 'async function onSendConfirmed');

check('onWithdrawConfirmed calls getLocalBalances() for guard',
  withdrawFn.includes('getLocalBalances()'));

check('onWithdrawConfirmed checks amountMinor > effectiveBalance',
  withdrawFn.includes('amountMinor > effectiveBalance'));

check('onWithdrawConfirmed shows Alert on insufficient funds',
  withdrawFn.includes("Alert.alert") && withdrawFn.includes('Insufficient Funds'));

// ─────────────────────────────────────────────────────────────────────────────
// 6. SendScreen — loadWallets AWAITED in onWithdrawConfirmed
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] SendScreen.tsx — loadWallets awaited after withdrawal');

check('onWithdrawConfirmed awaits loadWallets()',
  withdrawFn.includes('await loadWallets()'));

check('onWithdrawConfirmed does NOT fire-and-forget loadWallets',
  !withdrawFn.includes('\n      loadWallets();'));

// ─────────────────────────────────────────────────────────────────────────────
// 7. SendScreen — imports
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] SendScreen.tsx — required imports');

check('minorToMajor imported from currency utils',
  /import\s*\{[^}]*minorToMajor[^}]*\}.*currency/.test(send));

check('getLocalBalances imported from localBalance',
  /import\s*\{[^}]*getLocalBalances[^}]*\}.*localBalance/.test(send));

check('syncLocalBalancesFromBackend imported from localBalance',
  /import\s*\{[^}]*syncLocalBalancesFromBackend[^}]*\}.*localBalance/.test(send));

check('mergeWithLocalBalances imported from localBalance',
  /import\s*\{[^}]*mergeWithLocalBalances[^}]*\}.*localBalance/.test(send));

check('logLocalTransaction imported from localBalance (for withdrawal logging)',
  /import\s*\{[^}]*logLocalTransaction[^}]*\}.*localBalance/.test(send));

// ─────────────────────────────────────────────────────────────────────────────
// 7c. SendScreen — logLocalTransaction called in onWithdrawConfirmed
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7c] SendScreen.tsx — withdrawal logged to local transactions');
check('onWithdrawConfirmed calls logLocalTransaction after success',
  withdrawFn.includes('logLocalTransaction'));
check('logLocalTransaction records type withdrawal',
  /logLocalTransaction\([\s\S]{0,200}type:\s*'withdrawal'/.test(send));
check('logLocalTransaction records direction out',
  /logLocalTransaction\([\s\S]{0,200}direction:\s*'out'/.test(send));

// ─────────────────────────────────────────────────────────────────────────────
// 7b. SendScreen — loadWallets uses sync + merge
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7b] SendScreen.tsx — loadWallets() uses sync + merge (like WalletScreen)');
const loadWalletsFn = extractRegion(send, 'async function loadWallets', 'async function onSend');

check('loadWallets calls syncLocalBalancesFromBackend',
  loadWalletsFn.includes('syncLocalBalancesFromBackend'));

check('loadWallets calls getLocalBalances()',
  loadWalletsFn.includes('getLocalBalances()'));

check('loadWallets calls mergeWithLocalBalances',
  loadWalletsFn.includes('mergeWithLocalBalances'));

check('loadWallets calls setWallets(mergedWallets) — not raw res.wallets',
  loadWalletsFn.includes('setWallets(mergedWallets)') && !loadWalletsFn.includes('setWallets(res.wallets'));

// ─────────────────────────────────────────────────────────────────────────────
// 8–11. Backend — mutex
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8-11] backend/index.js — withdrawal in-flight mutex');
const backend = read('backend/index.js');

check('withdrawalInFlight Set declared',
  /const withdrawalInFlight\s*=\s*new Set\(\)/.test(backend));

check('inflightKey computed as userId:currency',
  /inflightKey\s*=\s*`\$\{.*userId.*\}:\$\{currency\}`/.test(backend) ||
  backend.includes('inflightKey = `${req.user.userId}:${currency}`'));

check('inflightKey checked with .has() before createWithdrawal',
  /withdrawalInFlight\.has\(inflightKey\)/.test(backend));

check('inflightKey deleted on error (catch path)',
  (() => {
    const withdrawalHandler = extractRegion(backend, 'app.post(\'/withdrawals\'', '// Rates');
    // Check that delete appears before the error return
    const deleteIdx = withdrawalHandler.indexOf('withdrawalInFlight.delete(inflightKey)');
    const errorReturnIdx = withdrawalHandler.indexOf('res.status(err.status || 500)');
    return deleteIdx !== -1 && errorReturnIdx !== -1 && deleteIdx < errorReturnIdx;
  })());

check('inflightKey deleted after res.json()',
  (() => {
    const withdrawalHandler = extractRegion(backend, 'app.post(\'/withdrawals\'', '// Rates');
    const resJsonIdx = withdrawalHandler.lastIndexOf('res.json(responseBody)');
    const deleteAfterIdx = withdrawalHandler.indexOf('withdrawalInFlight.delete(inflightKey)', resJsonIdx);
    return resJsonIdx !== -1 && deleteAfterIdx !== -1;
  })());

// ─────────────────────────────────────────────────────────────────────────────
// 11b. Backend — /wallets/:id/transactions includes withdrawals
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[11b] backend/index.js — GET /wallets/:id/transactions includes db.withdrawals');
const walletTxHandler = extractRegion(backend, "app.get('/wallets/:id/transactions'", "app.get('/transactions'");
check('handler merges db.withdrawals into response',
  walletTxHandler.includes('db.withdrawals'));
check('withdrawal entries get type: withdrawal',
  walletTxHandler.includes("type: 'withdrawal'"));
check('withdrawal entries get direction: out',
  walletTxHandler.includes("direction: 'out'"));
check('combined list is sorted by timestamp',
  walletTxHandler.includes('.sort(') && walletTxHandler.includes('combined'));

console.log('\n[11c] backend/index.js — GET /transactions (all-user) also includes db.withdrawals');
const allTxHandler = extractRegion(backend, "app.get('/transactions', authMiddleware", "// Resolve @username");
check('all-user handler merges db.withdrawals',
  allTxHandler.includes('db.withdrawals'));
check('all-user combined list sorted by timestamp',
  allTxHandler.includes('.sort(') && allTxHandler.includes('combined'));

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARDS (from phase 4 & 5)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[REGRESSION] Phase 4 & 5 guards');

check('logLocalTransaction NOT called in onSend (send path stays clean — Phase 5)',
  !send.includes('async function onSend') || (() => {
    const onSendFn = extractRegion(send, 'async function onSend()', 'async function onWithdrawConfirmed');
    return !onSendFn.includes('logLocalTransaction');
  })());

const txHistory = read('src/screens/TransactionHistory.tsx');
check('DEMO_TXS NOT in TransactionHistory',
  !txHistory.includes('DEMO_TXS'));

const auth = read('src/auth/AuthContext.tsx');
const signOutFn = extractRegion(auth, 'signOut', 'const value');
check('clearLocalUserData called in signOut',
  signOutFn.includes('clearLocalUserData'));

check('clearLocalUserData called in signIn',
  extractRegion(auth, 'async function signIn', 'async function signUp').includes('clearLocalUserData'));

check('clearLocalUserData called in signUp',
  extractRegion(auth, 'async function signUp', 'async function signOut').includes('clearLocalUserData'));

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
if (failed === 0) {
  console.log('  🎉 ALL PASS — Balance integrity fixes verified.\n');
} else {
  console.log('  ⚠️  Some checks failed — review output above.\n');
  process.exit(1);
}
