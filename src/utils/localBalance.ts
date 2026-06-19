/**
 * localBalance — Persistent local wallet balance via AsyncStorage.
 *
 * Backend balances are authoritative. syncLocalBalancesFromBackend() overwrites
 * local cache on every successful fetch. Local debits are not used to override
 * backend values — only pending-withdrawal holds affect available-balance UI.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const BALANCE_KEY = '@egwallet_local_balances_v1';
const TX_KEY = '@egwallet_local_transactions_v1';
const LAST_DEBIT_KEY = '@egwallet_last_debit_v1';
const PENDING_WITHDRAWAL_KEY = '@egwallet_pending_withdrawal_v1';

/** Map of ISO currency code → amount in **minor units** (e.g. cents). */
export type LocalBalances = Record<string, number>;

export type LocalTransaction = {
  id: string;
  type: 'deposit' | 'withdrawal' | 'send' | 'receive' | 'payment_request' | 'qr_payment';
  direction: 'in' | 'out';
  amount: number; // minor units
  currency: string;
  status: 'completed';
  timestamp: number;
  memo?: string;
};

export async function getLocalBalances(): Promise<LocalBalances> {
  try {
    const raw = await AsyncStorage.getItem(BALANCE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Add `minorAmount` to the local balance for `currency`. */
export async function creditLocalBalance(
  currency: string,
  minorAmount: number
): Promise<LocalBalances> {
  const balances = await getLocalBalances();
  balances[currency] = (balances[currency] || 0) + Math.abs(minorAmount);
  await AsyncStorage.setItem(BALANCE_KEY, JSON.stringify(balances));
  return balances;
}

/** Subtract `minorAmount` from the local balance for `currency` (min 0). */
export async function debitLocalBalance(
  currency: string,
  minorAmount: number
): Promise<LocalBalances> {
  const balances = await getLocalBalances();
  balances[currency] = Math.max(0, (balances[currency] || 0) - Math.abs(minorAmount));
  await AsyncStorage.setItem(BALANCE_KEY, JSON.stringify(balances));
  return balances;
}

/** Get the locally tracked pending withdrawal amounts (in minor units, per currency). */
export async function getPendingWithdrawals(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_WITHDRAWAL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Mark an amount as "pending withdrawal" for the given currency.
 * Called BEFORE the POST /withdrawals request is sent, so the UI
 * can immediately show the reduced available balance.
 */
export async function addPendingWithdrawal(
  currency: string,
  minorAmount: number
): Promise<void> {
  try {
    const pending = await getPendingWithdrawals();
    pending[currency] = (pending[currency] || 0) + Math.abs(minorAmount);
    await AsyncStorage.setItem(PENDING_WITHDRAWAL_KEY, JSON.stringify(pending));
  } catch { /* non-critical */ }
}

/**
 * Clear (or reduce) a pending withdrawal once the backend has confirmed
 * or rejected the request.
 */
export async function clearPendingWithdrawal(
  currency: string,
  minorAmount: number
): Promise<void> {
  try {
    const pending = await getPendingWithdrawals();
    pending[currency] = Math.max(0, (pending[currency] || 0) - Math.abs(minorAmount));
    if (pending[currency] === 0) delete pending[currency];
    await AsyncStorage.setItem(PENDING_WITHDRAWAL_KEY, JSON.stringify(pending));
  } catch { /* non-critical */ }
}

/** Log a transaction to the local history (max 100 entries). */
export async function logLocalTransaction(
  tx: Omit<LocalTransaction, 'id' | 'status' | 'timestamp'>
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(TX_KEY);
    const existing: LocalTransaction[] = raw ? JSON.parse(raw) : [];
    existing.unshift({
      ...tx,
      id: `local-${Date.now()}`,
      status: 'completed',
      timestamp: Date.now(),
    });
    await AsyncStorage.setItem(TX_KEY, JSON.stringify(existing.slice(0, 100)));
  } catch {
    // ignore storage errors
  }
}

/** Clear all local balances and transaction history (call on sign-in/sign-up to start fresh). */
export async function clearLocalUserData(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([
      BALANCE_KEY,
      TX_KEY,
      '@egwallet_budgets_v1',
      LAST_DEBIT_KEY,
      PENDING_WITHDRAWAL_KEY,
    ]);
  } catch {
    // ignore
  }
}

/**
 * Sync local balances from the backend-authoritative values.
 * Backend always wins — overwrites local cache and clears stale debit protection.
 */
export async function syncLocalBalancesFromBackend(
  backendWallets: Array<{ balances: Array<{ currency: string; amount: number }> }>
): Promise<void> {
  try {
    const primary = backendWallets[0];
    if (!primary) return;

    const synced: LocalBalances = {};
    for (const b of primary.balances || []) {
      const n = Number(b.amount);
      synced[b.currency] = Number.isFinite(n) ? Math.round(n) : 0;
    }

    await AsyncStorage.setItem(BALANCE_KEY, JSON.stringify(synced));
    // Clear legacy debit-protection timestamps — backend is authoritative.
    await AsyncStorage.removeItem(LAST_DEBIT_KEY);
  } catch {
    // ignore storage errors — local sync is best-effort
  }
}

/** Retrieve locally logged transactions (newest first). */
export async function getLocalTransactions(): Promise<LocalTransaction[]> {
  try {
    const raw = await AsyncStorage.getItem(TX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Merge local balances into a backend wallet array.
 * Backend amounts are used directly; local only adds currencies absent from backend
 * (e.g. deposit not yet reflected server-side).
 */
export function mergeWithLocalBalances(
  wallets: any[],
  localBalances: LocalBalances
): any[] {
  if (!wallets.length) return wallets;

  return wallets.map((wallet, idx) => {
    if (idx !== 0) return wallet;
    const existing: Record<string, number> = {};
    const mergedBalances = (wallet.balances || []).map((b: any) => {
      existing[b.currency] = 1;
      return { ...b, amount: b.amount };
    });
    Object.entries(localBalances).forEach(([cur, amt]) => {
      if (!existing[cur] && amt > 0) {
        mergedBalances.push({ currency: cur, amount: amt });
      }
    });
    return { ...wallet, balances: mergedBalances };
  });
}
