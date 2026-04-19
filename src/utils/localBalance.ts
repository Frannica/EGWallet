/**
 * localBalance — Persistent local wallet balance via AsyncStorage.
 *
 * Railway backend runs old code that lacks /deposits and /withdrawals
 * endpoints, so all balance changes are stored locally and merged on top of
 * whatever the backend returns.  Once the backend is redeployed we take the
 * max(backend, local) per currency so nothing breaks.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const BALANCE_KEY = '@egwallet_local_balances_v1';
const TX_KEY = '@egwallet_local_transactions_v1';
const LAST_DEBIT_KEY = '@egwallet_last_debit_v1';

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
  // Record debit timestamp so syncLocalBalancesFromBackend won't overwrite this
  // with a stale (higher) backend value during the grace window.
  try {
    const raw = await AsyncStorage.getItem(LAST_DEBIT_KEY);
    const times: Record<string, number> = raw ? JSON.parse(raw) : {};
    times[currency] = Date.now();
    await AsyncStorage.setItem(LAST_DEBIT_KEY, JSON.stringify(times));
  } catch { /* non-critical */ }
  return balances;
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
    ]);
  } catch {
    // ignore
  }
}

/**
 * Sync local balances from the backend-authoritative values.
 *
 * Debit-protection: once a currency has been locally debited, we NEVER let
 * the backend raise that currency's local balance until the backend confirms
 * the debit by returning a value ≤ our local amount.  This prevents a
 * backend restart (ephemeral filesystem) from silently restoring a stale
 * pre-withdrawal balance and allowing overdrafts.
 *
 * Protection clears automatically once the backend catches up (returns ≤ local),
 * or when the user signs out (clearLocalUserData).
 *
 * Currencies the user has never debited locally are trusted from the backend
 * (covers received payments, admin credits, etc.).
 */
export async function syncLocalBalancesFromBackend(
  backendWallets: Array<{ balances: Array<{ currency: string; amount: number }> }>
): Promise<void> {
  try {
    const primary = backendWallets[0];
    if (!primary) return;

    const [rawLocal, rawDebitTimes] = await Promise.all([
      AsyncStorage.getItem(BALANCE_KEY),
      AsyncStorage.getItem(LAST_DEBIT_KEY),
    ]);
    const localBals: LocalBalances = rawLocal ? JSON.parse(rawLocal) : {};
    const debitTimes: Record<string, number> = rawDebitTimes ? JSON.parse(rawDebitTimes) : {};
    let debitTimesChanged = false;

    const synced: LocalBalances = {};
    for (const b of primary.balances || []) {
      const hasDebitRecord = !!debitTimes[b.currency];
      const localAmt = localBals[b.currency];

      if (hasDebitRecord && localAmt !== undefined) {
        if (b.amount <= localAmt) {
          // Backend confirmed the debit (returned same or lower) — trust it
          // and clear the debit protection so future receives can flow through.
          synced[b.currency] = b.amount;
          delete debitTimes[b.currency];
          debitTimesChanged = true;
        } else {
          // Backend is reporting MORE than our local balance.
          // This means the backend is stale (e.g. Railway restart reset db.json).
          // NEVER let the backend raise the balance — keep local (lower) value.
          synced[b.currency] = localAmt;
        }
      } else {
        // No prior local debit for this currency — trust backend.
        // Covers: fresh install, first load, received payments, admin credits.
        synced[b.currency] = b.amount;
      }
    }

    await AsyncStorage.setItem(BALANCE_KEY, JSON.stringify(synced));
    if (debitTimesChanged) {
      await AsyncStorage.setItem(LAST_DEBIT_KEY, JSON.stringify(debitTimes));
    }
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
 * Local balance is preferred when present because it reflects optimistic
 * UI updates (deposits/withdrawals) made since the last backend sync.
 * Backend sync via syncLocalBalancesFromBackend() keeps local truthful
 * on every successful fetch, preventing permanent drift.
 */
export function mergeWithLocalBalances(
  wallets: any[],
  localBalances: LocalBalances
): any[] {
  if (!wallets.length) return wallets;

  return wallets.map((wallet, idx) => {
    if (idx !== 0) return wallet; // only touch the primary wallet
    const existing: Record<string, number> = {};
    const mergedBalances = (wallet.balances || []).map((b: any) => {
      existing[b.currency] = 1;
      // Prefer local balance when present — local is always updated immediately on deposit/withdrawal
      // so it reflects the latest state even before backend re-fetch completes.
      const amount = b.currency in localBalances ? localBalances[b.currency] : b.amount;
      return { ...b, amount };
    });
    // Add currencies that exist locally but not in backend wallet
    Object.entries(localBalances).forEach(([cur, amt]) => {
      if (!existing[cur] && amt > 0) {
        mergedBalances.push({ currency: cur, amount: amt });
      }
    });
    return { ...wallet, balances: mergedBalances };
  });
}
