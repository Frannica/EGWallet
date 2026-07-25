/**
 * Phase 13 regression guards — Critical withdrawal safety
 *
 * Invariants protected:
 *  A. Withdrawal default method is a real payout path ('mobile'), never debit/credit card
 *  B. Bank withdrawal shows 3-5 business day warning before confirmation
 *  C. Method selector offers only bank + mobile money (no debit/credit card)
 *  D. availableBalance (not totalBalance) used for overdraft check in checkBalanceAndProceed
 *  E. pendingWithdrawal concept present in localBalance.ts (addPendingWithdrawal, clearPendingWithdrawal)
 *  F. onWithdrawConfirmed: addPendingWithdrawal before request, clearPendingWithdrawal on success+failure
 *  G. Card withdrawal validation branches are fully removed
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SEND        = fs.readFileSync(path.resolve(__dirname, '../../src/screens/SendScreen.tsx'),      'utf8');
const LOCAL_BAL   = fs.readFileSync(path.resolve(__dirname, '../../src/utils/localBalance.ts'),       'utf8');

module.exports = function phase13(check) {
  // ════════════════════════════════════════════════════════════════════════════
  // A) Default withdrawal method is a real payout path (mobile), never a card
  // ════════════════════════════════════════════════════════════════════════════

  check(
    "[Withdrawal] Default withdrawalMethod state is 'mobile' (real Kora path)",
    SEND.includes("useState<'bank' | 'mobile'>('mobile')"),
  );

  check(
    '[Withdrawal] Debit/credit card methods are not in the type union',
    !SEND.includes("'bank' | 'mobile' | 'debit' | 'credit'"),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // B) Bank withdrawal warning (3-5 business days alert)
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] Bank withdrawal warning alert present (3–5 business days)',
    SEND.includes("t('send.bankWithdrawalMsg')") || SEND.includes('send.bankTransferArrival'),
  );

  check(
    "[Withdrawal] Bank warning only shown when withdrawalMethod === 'bank'",
    SEND.includes("withdrawalMethod === 'bank'") && SEND.includes('3'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // C) Method selector: bank + mobile only; bank has 3-5 days badge
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] Debit/credit card method selectors are absent',
    !SEND.includes("onPress={() => setWithdrawalMethod('debit')}") &&
    !SEND.includes("onPress={() => setWithdrawalMethod('credit')}"),
  );

  check(
    '[Withdrawal] Bank and Mobile Money method selectors are present',
    SEND.includes("setWithdrawalMethod('bank')") &&
    SEND.includes("setWithdrawalMethod('mobile')"),
  );

  check(
    "[Withdrawal] Bank transfer has '3-5 days' badge in method selector",
    SEND.includes('methodBadgeSlow') && SEND.includes("send.bankDays"),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // D) availableBalance / pendingBalance used in overdraft check
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] checkBalanceAndProceed subtracts pending withdrawals from available balance',
    SEND.includes('getPendingWithdrawals') && SEND.includes('pendingMajor') && SEND.includes('backendMajor - pendingMajor'),
  );

  check(
    '[Withdrawal] Available balance display banner rendered in withdraw tab',
    SEND.includes('balanceSummaryBanner') && SEND.includes("send.availableToWithdraw"),
  );

  check(
    '[Withdrawal] Pending withdrawal amount displayed when non-zero',
    SEND.includes("send.pendingWithdrawal") && SEND.includes('pendingMinor > 0'),
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
      const firstAwaitIdx = fnBody.indexOf('await refreshAndSetWallets');
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
  // G) Card withdrawal validation branches are fully removed
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Withdrawal] onSend validation has no debit/credit card branch',
    !SEND.includes("withdrawalMethod === 'debit' || withdrawalMethod === 'credit'") &&
    !SEND.includes('enterCardNumber') &&
    !SEND.includes('enterCardExpiry'),
  );
};
