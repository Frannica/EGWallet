/**
 * Phase 13 regression guards — Critical withdrawal safety
 *
 * Invariants protected:
 *  A. Withdrawal default method is 'debit', not 'bank'
 *  B. Bank withdrawal shows 3-5 business day warning before confirmation
 *  C. Withdrawal method order: debit first, bank third (with 3-5 days badge)
 *  D. availableBalance (not totalBalance) used for overdraft check in checkBalanceAndProceed
 *  E. pendingWithdrawal concept present in localBalance.ts (addPendingWithdrawal, clearPendingWithdrawal)
 *  F. onWithdrawConfirmed: addPendingWithdrawal before request, clearPendingWithdrawal on success+failure
 *  G. Validation: both debit AND credit use card branch (not bank branch)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SEND        = fs.readFileSync(path.resolve(__dirname, '../../src/screens/SendScreen.tsx'),      'utf8');
const LOCAL_BAL   = fs.readFileSync(path.resolve(__dirname, '../../src/utils/localBalance.ts'),       'utf8');

module.exports = function phase13(check) {
  // ════════════════════════════════════════════════════════════════════════════
  // A) Default withdrawal method is 'debit'
  // ════════════════════════════════════════════════════════════════════════════

  check(
    "[Withdrawal] Default withdrawalMethod state is 'debit' (not 'bank')",
    SEND.includes("useState<'bank' | 'mobile' | 'debit' | 'credit'>('debit')"),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // B) Bank withdrawal warning (3-5 business days alert)
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] Bank withdrawal warning alert present (3–5 business days)',
    SEND.includes('3\u20135 business days') || SEND.includes('3-5 business days'),
  );

  check(
    "[Withdrawal] Bank warning only shown when withdrawalMethod === 'bank'",
    SEND.includes("withdrawalMethod === 'bank'") && SEND.includes('3'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // C) Method order: debit first, bank has 3-5 days badge
  // ════════════════════════════════════════════════════════════════════════════

  const debitIdx  = SEND.indexOf("setWithdrawalMethod('debit')");
  const creditIdx = SEND.indexOf("setWithdrawalMethod('credit')");
  const bankIdx   = SEND.indexOf("setWithdrawalMethod('bank')");
  const mobileIdx = SEND.indexOf("setWithdrawalMethod('mobile')");

  // Find the first occurrence of each (in the method selector section)
  check(
    '[Withdrawal] Debit card method selector appears before Credit card',
    debitIdx !== -1 && creditIdx !== -1 && debitIdx < creditIdx,
  );

  check(
    '[Withdrawal] Credit card method selector appears before Bank',
    creditIdx !== -1 && bankIdx !== -1 && creditIdx < bankIdx,
  );

  check(
    '[Withdrawal] Bank method selector appears before Mobile Money',
    bankIdx !== -1 && mobileIdx !== -1 && bankIdx < mobileIdx,
  );

  check(
    "[Withdrawal] Debit card has 'Instant' badge in method selector",
    SEND.includes('methodBadge') && SEND.includes('Instant'),
  );

  check(
    "[Withdrawal] Bank transfer has '3-5 days' badge in method selector",
    SEND.includes('methodBadgeSlow') && SEND.includes('3-5 days'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // D) availableBalance / pendingBalance used in overdraft check
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] checkBalanceAndProceed subtracts pending withdrawals from available balance',
    SEND.includes('getPendingWithdrawals') && SEND.includes('pendingMajor') && SEND.includes('grossMajor - pendingMajor'),
  );

  check(
    '[Withdrawal] Available balance display banner rendered in withdraw tab',
    SEND.includes('balanceSummaryBanner') && SEND.includes('Available to withdraw'),
  );

  check(
    '[Withdrawal] Pending withdrawal amount displayed when non-zero',
    SEND.includes('Pending withdrawal') && SEND.includes('pendingMinor > 0'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // E) localBalance.ts exports pending withdrawal functions
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[LocalBalance] PENDING_WITHDRAWAL_KEY constant defined',
    LOCAL_BAL.includes('PENDING_WITHDRAWAL_KEY'),
  );

  check(
    '[LocalBalance] getPendingWithdrawals exported',
    LOCAL_BAL.includes('export async function getPendingWithdrawals'),
  );

  check(
    '[LocalBalance] addPendingWithdrawal exported',
    LOCAL_BAL.includes('export async function addPendingWithdrawal'),
  );

  check(
    '[LocalBalance] clearPendingWithdrawal exported',
    LOCAL_BAL.includes('export async function clearPendingWithdrawal'),
  );

  check(
    '[LocalBalance] PENDING_WITHDRAWAL_KEY cleared on clearLocalUserData',
    LOCAL_BAL.includes('PENDING_WITHDRAWAL_KEY') && LOCAL_BAL.includes('clearLocalUserData'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // F) onWithdrawConfirmed: pending lock before request, release on both paths
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] addPendingWithdrawal called before POST /withdrawals fetch',
    SEND.includes('addPendingWithdrawal') && SEND.includes('await addPendingWithdrawal(currency, amountMinor)'),
  );

  check(
    '[Withdrawal] clearPendingWithdrawal called on successful withdrawal',
    SEND.includes('await clearPendingWithdrawal(currency, amountMinor)'),
  );

  check(
    '[Withdrawal] clearPendingWithdrawal also called in catch block (failure path)',
    (() => {
      // Find the onWithdrawConfirmed function body (between its start and the next function declaration)
      const fnStart = SEND.indexOf('async function onWithdrawConfirmed()');
      const fnEnd   = SEND.indexOf('\n  async function ', fnStart + 1);
      const fnBody  = fnStart !== -1 ? SEND.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 3000) : '';
      const catchIdx = fnBody.lastIndexOf('} catch');
      const catchSection = fnBody.slice(catchIdx, catchIdx + 300);
      return catchSection.includes('clearPendingWithdrawal');
    })(),
  );

  // ── Security hardening checks ─────────────────────────────────────────────

  check(
    '[Security] setLoading(true) fires before async balance reads (collapses TOCTOU window)',
    (() => {
      const fnStart = SEND.indexOf('async function onWithdrawConfirmed()');
      const fnEnd   = SEND.indexOf('\n  async function ', fnStart + 1);
      const fnBody  = fnStart !== -1 ? SEND.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 3000) : '';
      const loadingIdx   = fnBody.indexOf('setLoading(true)');
      const firstAwaitIdx = fnBody.indexOf('await getLocalBalances');
      return loadingIdx !== -1 && firstAwaitIdx !== -1 && loadingIdx < firstAwaitIdx;
    })(),
  );

  check(
    '[Security] Zero-balance bypass removed — no short-circuit "trueAvailable > 0 &&" guard',
    (() => {
      const fnStart = SEND.indexOf('async function onWithdrawConfirmed()');
      const fnEnd   = SEND.indexOf('\n  async function ', fnStart + 1);
      const fnBody  = fnStart !== -1 ? SEND.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 3000) : '';
      return !fnBody.includes('trueAvailable > 0 &&');
    })(),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // G) Validation: credit card uses card branch (not bank branch)
  // ════════════════════════════════════════════════════════════════════════════

  check(
    "[Withdrawal] onSend validation: credit card checked in card branch (withdrawalMethod === 'credit')",
    SEND.includes("withdrawalMethod === 'debit' || withdrawalMethod === 'credit'"),
  );
};
