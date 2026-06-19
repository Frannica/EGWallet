/**
 * Phase 10 regression guards
 *
 * Invariants protected:
 *  1. Time-based debit grace period (DEBIT_GRACE_MS) is permanently removed
 *  2. syncLocalBalancesFromBackend uses event-driven protection (not time-based)
 *  3. Protection only clears when backend confirms balance ≤ local (debit confirmed)
 *  4. Backend mutex (withdrawalInFlight Set) present in backend to block concurrent withdrawals
 *  5. withdrawalEngine.markWithdrawalFailed is idempotent (refundIssued guard)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOCAL_BALANCE = fs.readFileSync(
  path.resolve(__dirname, '../../src/utils/localBalance.ts'),
  'utf8',
);
const BACKEND = fs.readFileSync(
  path.resolve(__dirname, '../../backend/index.js'),
  'utf8',
);
const WITHDRAWAL_ENGINE = fs.readFileSync(
  path.resolve(__dirname, '../../backend/withdrawalEngine.js'),
  'utf8',
);

module.exports = function phase10(check) {
  // ── 1. DEBIT_GRACE_MS must not exist ──────────────────────────────────────
  check(
    'DEBIT_GRACE_MS constant has been removed from localBalance.ts',
    !LOCAL_BALANCE.includes('DEBIT_GRACE_MS'),
  );

  // ── 2. No time-based expiry check in sync function ────────────────────────
  check(
    'syncLocalBalancesFromBackend does not use Date.now() + grace expiry for balance override',
    !LOCAL_BALANCE.includes('Date.now() - lastDebit') &&
    !LOCAL_BALANCE.includes('lastDebitTime + '),
  );

  // ── 3. Backend overwrites local on every successful sync ─────────────────
  check(
    'syncLocalBalancesFromBackend overwrites local from backend (authoritative)',
    LOCAL_BALANCE.includes('removeItem(LAST_DEBIT_KEY)') &&
    LOCAL_BALANCE.includes('Backend always wins'),
  );

  // ── 4. Backend withBalanceMutex serialises money mutations ───────────────
  check(
    'withBalanceMutex used as concurrency mutex for money operations',
    BACKEND.includes('function withBalanceMutex') &&
    BACKEND.includes('await withBalanceMutex'),
  );
  check(
    'POST /withdrawals runs inside withBalanceMutex (not withdrawalInFlight Set)',
    BACKEND.includes("app.post('/withdrawals'") &&
    !BACKEND.includes('withdrawalInFlight.has(') &&
    !BACKEND.includes('withdrawalInFlight.add(') &&
    (() => {
      const start = BACKEND.indexOf("app.post('/withdrawals'");
      const end = BACKEND.indexOf("app.post('/withdrawals/:id/cancel'", start);
      return BACKEND.slice(start, end > start ? end : start + 12000).includes('withBalanceMutex');
    })(),
  );

  // ── 5. withdrawalEngine refund is idempotent ──────────────────────────────
  check(
    'markWithdrawalFailed is guarded by refundIssued flag (idempotent)',
    WITHDRAWAL_ENGINE.includes('refundIssued'),
  );
  check(
    'withdrawalEngine does not double-refund on repeated calls',
    (WITHDRAWAL_ENGINE.match(/refundIssued/g) || []).length >= 2,
  );
};
