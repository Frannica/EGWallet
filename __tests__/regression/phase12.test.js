/**
 * Phase 12 regression guards
 *
 * Invariants protected:
 *  A. WalletScreen — All console.log calls in quick actions guarded with __DEV__
 *  B. NotificationsScreen — Error state handled (no crash on network failure)
 *  C. TransactionHistory — Safe null access patterns on renderItem fields
 *  D. AppNavigator — Notifications, Transactions, ReportProblem,
 *                    DisputeTransaction routes all registered
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WALLET   = fs.readFileSync(path.resolve(__dirname, '../../src/screens/WalletScreen.tsx'),          'utf8');
const NOTIFS   = fs.readFileSync(path.resolve(__dirname, '../../src/screens/NotificationsScreen.tsx'),   'utf8');
const TXHIST   = fs.readFileSync(path.resolve(__dirname, '../../src/screens/TransactionHistory.tsx'),    'utf8');
const APPNAV   = fs.readFileSync(path.resolve(__dirname, '../../src/navigation/AppNavigator.tsx'),       'utf8');

module.exports = function phase12(check) {
  // ════════════════════════════════════════════════════════════════════════════
  // A) WalletScreen — console.log guards in quick actions
  // ════════════════════════════════════════════════════════════════════════════

  const walletRawLogs     = (WALLET.match(/console\.log\(/g) || []).length;
  const walletGuardedLogs = (WALLET.match(/if\s*\(__DEV__\)\s*console\.log\(/g) || []).length;
  check(
    '[Wallet] Every console.log call is guarded with __DEV__',
    walletRawLogs > 0 && walletRawLogs === walletGuardedLogs,
  );
  check(
    '[Wallet] Quick action Send has __DEV__ guard',
    WALLET.includes("if (__DEV__) console.log('[Wallet] Quick action: Send')"),
  );
  check(
    '[Wallet] Quick action Request has __DEV__ guard',
    WALLET.includes("if (__DEV__) console.log('[Wallet] Quick action: Request')"),
  );
  check(
    '[Wallet] Quick action Add Money has __DEV__ guard',
    WALLET.includes("if (__DEV__) console.log('[Wallet] Quick action: Add Money')"),
  );
  check(
    '[Wallet] Quick action Card has __DEV__ guard',
    WALLET.includes("if (__DEV__) console.log('[Wallet] Quick action: Card')"),
  );
  check(
    '[Wallet] Quick action AI Support has __DEV__ guard',
    WALLET.includes("if (__DEV__) console.log('[Wallet] Quick action: AI Support')"),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // B) NotificationsScreen — error-safe fetch
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[Notifications] fetchError state declared for network failure handling',
    NOTIFS.includes('fetchError') && NOTIFS.includes('setFetchError'),
  );
  check(
    '[Notifications] markAllRead uses correct PATCH endpoint',
    NOTIFS.includes('/notifications/read-all'),
  );
  check(
    '[Notifications] markOneRead uses PATCH per-notification endpoint',
    NOTIFS.includes('/notifications/') && NOTIFS.includes('/read'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // C) TransactionHistory — safe null access
  // ════════════════════════════════════════════════════════════════════════════

  // Superseded by the localized getStatusLabel() helper (i18n pass), which
  // preserves the same null-safety guarantee via `(status ?? 'unknown')`
  // before any charAt/case-formatting fallback — see getStatusLabel() and
  // its unknown-status fallback branch in TransactionHistory.tsx.
  check(
    '[TransactionHistory] getStatusLabel null-coalesces status before charAt fallback',
    TXHIST.includes("const key = (status ?? 'unknown').toLowerCase()") &&
      TXHIST.includes("(status ?? t('status.unknown')).charAt(0)"),
  );
  check(
    '[TransactionHistory] item.status rendering routed through getStatusLabel (localized, null-safe)',
    TXHIST.includes('{getStatusLabel(item.status)}'),
  );
  check(
    '[TransactionHistory] item.id guarded before rendering ref ID',
    TXHIST.includes('{item.id && ('),
  );
  check(
    '[TransactionHistory] generateAndShareReceipt uses optional chaining on auth.user',
    TXHIST.includes("auth.user?.email"),
  );
  check(
    '[TransactionHistory] walletId fallback — no_wallet error caught',
    TXHIST.includes("'no_wallet'") || TXHIST.includes('"no_wallet"'),
  );

  // ════════════════════════════════════════════════════════════════════════════
  // D) AppNavigator — all required routes registered
  // ════════════════════════════════════════════════════════════════════════════

  check(
    '[AppNavigator] Notifications route registered',
    APPNAV.includes('name="Notifications"'),
  );
  check(
    '[AppNavigator] Transactions route registered',
    APPNAV.includes('name="Transactions"'),
  );
  check(
    '[AppNavigator] ReportProblem route registered',
    APPNAV.includes('name="ReportProblem"'),
  );
  check(
    '[AppNavigator] DisputeTransaction route registered',
    APPNAV.includes('name="DisputeTransaction"'),
  );
};
