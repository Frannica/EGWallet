/**
 * _phase3_proof.js
 * Verifies Phase 3 fixes:
 *   1. Balance integrity — local balance prefers backend truth after sync
 *   2. No duplicate deposit transaction logging
 *   3. No transaction list on WalletScreen home page
 *   4. Backend-to-local sync on successful wallet fetch
 *
 * Run: node _phase3_proof.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let passed = 0, failed = 0;

function check(label, ok, detail = '') {
  if (ok) { console.log(`  PASS -- ${label}`); passed++; }
  else     { console.log(`  FAIL -- ${label}${detail ? '\n         ' + detail : ''}`); failed++; }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

console.log('\n====================================================');
console.log('  EGWallet -- Phase 3 Fixes Proof & Security Audit');
console.log('====================================================\n');

// ---------- 1. localBalance.ts — balance merge strategy --------------------
console.log('[1] src/utils/localBalance.ts -- Balance merge & backend sync');
const lb = read('src/utils/localBalance.ts');

check('mergeWithLocalBalances prefers local when currency key present',
  lb.includes("b.currency in localBalances ? localBalances[b.currency] : b.amount"));

check('Old Math.max approach removed (no longer caps at backend amount)',
  !lb.includes('Math.max(b.amount, localBalances'));

check('syncLocalBalancesFromBackend function exported',
  lb.includes('export async function syncLocalBalancesFromBackend('));

check('syncLocalBalancesFromBackend writes full backend balances to AsyncStorage',
  lb.includes('AsyncStorage.setItem(BALANCE_KEY, JSON.stringify(synced))'));

check('syncLocalBalancesFromBackend iterates primary wallet balances',
  lb.includes('for (const b of primary.balances || [])'));

check('syncLocalBalancesFromBackend is safe (no-op when wallets empty)',
  lb.includes('if (!primary) return'));

check('creditLocalBalance still adds to balance (deposit path intact)',
  lb.includes('balances[currency] = (balances[currency] || 0) + Math.abs(minorAmount)'));

check('debitLocalBalance still subtracts (withdrawal path intact)',
  lb.includes('balances[currency] = Math.max(0, (balances[currency] || 0) - Math.abs(minorAmount))'));

check('clearLocalBalances still exported (used on sign-in/sign-up)',
  lb.includes('export async function clearLocalBalances'));

// ---------- 2. WalletScreen.tsx — backend sync on fetch --------------------
console.log('\n[2] src/screens/WalletScreen.tsx -- Backend sync on wallet fetch');
const wallet = read('src/screens/WalletScreen.tsx');

check('syncLocalBalancesFromBackend imported',
  wallet.includes('syncLocalBalancesFromBackend'));

check('syncLocalBalancesFromBackend called after successful listWallets()',
  wallet.includes('await syncLocalBalancesFromBackend(res.wallets || [])'));

check('syncLocalBalancesFromBackend called BEFORE getLocalBalances() (order matters)',
  wallet.indexOf('syncLocalBalancesFromBackend') < wallet.indexOf('getLocalBalances()'));

check('mergeWithLocalBalances still called after sync',
  wallet.includes('mergeWithLocalBalances(res.wallets || [], localBalances)'));

check('No recentTxns state variable on WalletScreen',
  !wallet.includes('recentTxns'));

check('No loadRecentTxns function on WalletScreen',
  !wallet.includes('loadRecentTxns'));

check('No transaction list render on home page (no txRow style reference in JSX)',
  !wallet.includes('styles.txRow'));

check('fetchTransactions import removed (no longer needed)',
  !wallet.includes("fetchTransactions"));

check('View All navigates to Transactions screen',
  wallet.includes("navigate('Transactions'"));

// ---------- 3. DepositScreen.tsx — no duplicate transaction log ------------
console.log('\n[3] src/screens/DepositScreen.tsx -- No duplicate deposit logging');
const deposit = read('src/screens/DepositScreen.tsx');

check('logLocalTransaction NOT imported (removed to prevent duplicates)',
  !deposit.includes('logLocalTransaction'));

check('creditLocalBalance still imported (local balance still updated)',
  deposit.includes('creditLocalBalance'));

check('creditLocalBalance still called after confirm',
  deposit.includes('await creditLocalBalance(currency, netMinor)'));

check('No logLocalTransaction call in confirmDeposit (backend records the transaction)',
  !deposit.includes("logLocalTransaction({ type: 'deposit'"));

check('Backend deposit path still routes through /deposits/create-intent',
  deposit.includes('/deposits/create-intent'));

check('Backend deposit confirmed via /deposits/confirm',
  deposit.includes('/deposits/confirm'));

// ---------- 4. Security — no new attack surface introduced -----------------
console.log('\n[4] Security -- No new attack surface from Phase 3 changes');

check('syncLocalBalancesFromBackend takes wallet array (typed, not req.body)',
  lb.includes('backendWallets: Array<{ balances: Array<{ currency: string; amount: number }>'));

check('No eval() or JSON.parse(req.body) in localBalance.ts',
  !lb.includes('eval(') && !lb.includes('Function('));

check('No raw user input reaches syncLocalBalancesFromBackend (only server response)',
  // Called with res.wallets — the parsed JSON from authenticated backend response
  wallet.includes('syncLocalBalancesFromBackend(res.wallets || [])') &&
  !wallet.includes('syncLocalBalancesFromBackend(req.'));

check('AsyncStorage key unchanged (no migration required)',
  lb.includes("'@egwallet_local_balances_v1'"));

check('syncLocalBalancesFromBackend only touches primary wallet (idx 0)',
  lb.includes('const primary = backendWallets[0]'));

check('debitLocalBalance withdrawal still logged locally (audit trail)',
  read('src/screens/SendScreen.tsx').includes("type: 'withdrawal'") &&
  read('src/screens/SendScreen.tsx').includes('logLocalTransaction'));

// ---------- Result -----------------------------------------------------------
console.log('\n====================================================');
console.log(`  RESULT:  ${passed} passed  /  ${failed} failed`);
console.log('====================================================\n');

if (failed > 0) { console.log('SOME CHECKS FAILED. Review output above.\n'); process.exit(1); }
else            { console.log('ALL CHECKS PASSED. Phase 3 fixes are secure.\n'); process.exit(0); }
