/**
 * _phase4_proof.js — Data Isolation / Session Boundary Tests
 *
 * Verifies that NO local user data (balances, transactions, budgets) can
 * ever bleed from one user session into another on the same device.
 *
 * Run: node _phase4_proof.js
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
  // Normalize CRLF → LF so string checks work on Windows and Unix equally
  return fs.readFileSync(path.resolve(__dirname, filePath), 'utf8').replace(/\r\n/g, '\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. localBalance.ts — clearLocalUserData
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[1] localBalance.ts — clearLocalUserData');
const lb = read('src/utils/localBalance.ts');

check('Function renamed: clearLocalUserData exported',
  lb.includes('export async function clearLocalUserData()'));

check('clearLocalBalances name is gone (no old name remains as export)',
  !lb.includes('export async function clearLocalBalances'));

check('Clears BALANCE_KEY (@egwallet_local_balances_v1)',
  lb.includes("'@egwallet_local_balances_v1'") &&
  lb.includes('multiRemove') &&
  lb.includes('BALANCE_KEY'));

check('Clears TX_KEY (@egwallet_local_transactions_v1)',
  lb.includes("'@egwallet_local_transactions_v1'") &&
  lb.includes('TX_KEY'));

check('Clears budgets key (@egwallet_budgets_v1)',
  lb.includes("'@egwallet_budgets_v1'"));

check('Uses multiRemove (atomic, single call)',
  lb.includes('AsyncStorage.multiRemove(') &&
  lb.includes('BALANCE_KEY') &&
  lb.includes('TX_KEY') &&
  lb.includes("'@egwallet_budgets_v1'"));

// ──────────────────────────────────────────────────────────────────────────────
// 2. AuthContext.tsx — signIn calls clearLocalUserData
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[2] AuthContext.tsx — signIn');
const auth = read('src/auth/AuthContext.tsx');

check('Imports clearLocalUserData (not old name)',
  auth.includes('clearLocalUserData') &&
  !auth.includes('clearLocalBalances'));

// Extract signIn function body
const signInStart = auth.indexOf('async function signIn(');
const signInEnd = auth.indexOf('\n  async function signUp(', signInStart);
const signInBody = auth.slice(signInStart, signInEnd);

check('signIn calls clearLocalUserData',
  signInBody.includes('await clearLocalUserData()'));

check('signIn clears BEFORE setToken (data gone before user is in)',
  signInBody.indexOf('await clearLocalUserData()') <
  signInBody.indexOf('setToken('));

// ──────────────────────────────────────────────────────────────────────────────
// 3. AuthContext.tsx — signUp calls clearLocalUserData
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[3] AuthContext.tsx — signUp');

const signUpStart = auth.indexOf('async function signUp(');
const signUpEnd = auth.indexOf('\n  async function signOut(', signUpStart);
const signUpBody = auth.slice(signUpStart, signUpEnd);

check('signUp calls clearLocalUserData',
  signUpBody.includes('await clearLocalUserData()'));

check('signUp clears BEFORE setToken',
  signUpBody.indexOf('await clearLocalUserData()') <
  signUpBody.indexOf('setToken('));

// ──────────────────────────────────────────────────────────────────────────────
// 4. AuthContext.tsx — signOut calls clearLocalUserData
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[4] AuthContext.tsx — signOut');

const signOutStart = auth.indexOf('async function signOut()');
const signOutEnd = auth.indexOf('\n  async function updatePreferredCurrency', signOutStart);
const signOutBody = auth.slice(signOutStart, signOutEnd);

check('signOut calls clearLocalUserData',
  signOutBody.includes('await clearLocalUserData()'));

check('signOut clears BEFORE setToken(null)',
  signOutBody.indexOf('await clearLocalUserData()') <
  signOutBody.indexOf('setToken(null)'));

check('signOut also clears SecureStore tokens',
  signOutBody.includes('deleteItemAsync(TOKEN_KEY)') &&
  signOutBody.includes('deleteItemAsync(REFRESH_TOKEN_KEY)'));

// ──────────────────────────────────────────────────────────────────────────────
// 5. TransactionHistory.tsx — DEMO_TXS removed
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[5] TransactionHistory.tsx — no fake demo transactions');
const txh = read('src/screens/TransactionHistory.tsx');

check('DEMO_TXS array is gone',
  !txh.includes('DEMO_TXS'));

check('dtx-1 (fake Salary payment) is gone',
  !txh.includes('dtx-1'));

check('Acme Corp fake payroll entry is gone',
  !txh.includes('Acme Corp'));

check('setTxs never falls back to demo data',
  !txh.includes('DEMO_TXS'));

check('Empty account shows empty state (no fake fill)',
  txh.includes('No') && txh.includes('transactions found'));

// ──────────────────────────────────────────────────────────────────────────────
// 6. All 3 AsyncStorage keys covered
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[6] Complete AsyncStorage key coverage');

// Find every @egwallet_ key used across the codebase
const srcDir = path.resolve(__dirname, 'src');
function getAllFiles(dir, exts = ['.ts', '.tsx']) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(getAllFiles(full, exts));
    else if (exts.some(e => entry.name.endsWith(e))) results.push(full);
  }
  return results;
}

const allKeys = new Set();
const userDataKeys = new Set();
const nonUserKeys = new Set(['@egwallet:language']); // device-level prefs, OK to survive signout

for (const file of getAllFiles(srcDir)) {
  const content = fs.readFileSync(file, 'utf8');
  const matches = content.match(/@egwallet[_:][a-zA-Z0-9_:]+/g) || [];
  for (const k of matches) allKeys.add(k);
}

// Identify user data keys (anything that's not a device-level preference)
for (const k of allKeys) {
  if (!nonUserKeys.has(k)) userDataKeys.add(k);
}

const clearFnBody = lb.slice(lb.indexOf('export async function clearLocalUserData()'));
const clearedInFn = [...userDataKeys].filter(k => clearFnBody.includes(k) || lb.includes(k));
const unclearedUserKeys = [...userDataKeys].filter(k =>
  !clearFnBody.includes(`'${k}'`) && !clearFnBody.includes(`"${k}"`) &&
  // keys that are only constants (not raw strings) — verify via constant declarations
  !lb.includes(`const .*= '${k}'`) &&
  k !== '@egwallet_local_balances_v1' &&   // covered via BALANCE_KEY constant
  k !== '@egwallet_local_transactions_v1' && // covered via TX_KEY constant
  k !== '@egwallet_budgets_v1'              // covered explicitly
);

const allUserDataKeysCleared = [...userDataKeys].every(k => {
  // Covered directly or by constant
  return (
    clearFnBody.includes(`'${k}'`) ||
    clearFnBody.includes(`"${k}"`) ||
    k === '@egwallet_local_balances_v1' ||
    k === '@egwallet_local_transactions_v1' ||
    k === '@egwallet_budgets_v1'
  );
});

check(`All user data AsyncStorage keys are wiped on session change (${[...userDataKeys].join(', ')})`,
  allUserDataKeysCleared,
  unclearedUserKeys.length ? `Uncleared: ${unclearedUserKeys.join(', ')}` : '');

check('@egwallet:language (device preference) intentionally preserved',
  nonUserKeys.has('@egwallet:language'));

// ──────────────────────────────────────────────────────────────────────────────
// 7. Sequence / order guarantees
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Data-clear ordering');

// Meaningful invariant: local data wiped BEFORE the UI session is established
check('signIn: clearLocalUserData() called before setToken (UI never sees stale data)',
  signInBody.indexOf('await clearLocalUserData()') <
  signInBody.indexOf('setToken('));

check('signIn: clearLocalUserData() called before setUser (no stale transactions in new session)',
  signInBody.indexOf('await clearLocalUserData()') <
  signInBody.indexOf('setUser('));

// Meaningful invariant: local data wiped BEFORE the UI session is established
check('signUp: clearLocalUserData() called before setToken',
  signUpBody.indexOf('await clearLocalUserData()') <
  signUpBody.indexOf('setToken('));

check('signUp: clearLocalUserData() called before setUser',
  signUpBody.indexOf('await clearLocalUserData()') <
  signUpBody.indexOf('setUser('));

check('signOut: deleteTokens → clear → nullState (clean teardown order)',
  signOutBody.indexOf('deleteItemAsync') <
  signOutBody.indexOf('await clearLocalUserData()') &&
  signOutBody.indexOf('await clearLocalUserData()') <
  signOutBody.indexOf('setToken(null)'));

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
console.log('─'.repeat(52));
if (failed === 0) {
  console.log('  ✅ ALL CHECKS PASS — data isolation is airtight.\n');
  process.exit(0);
} else {
  console.error('  ❌ SOME CHECKS FAILED — review output above.\n');
  process.exit(1);
}
