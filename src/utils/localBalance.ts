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

/** Map of ISO currency code → amount in **minor units** (e.g. cents). */
export type LocalBalances = Record<string, number>;

export type LocalTransaction = {
  id: string;
  type: 'deposit' | 'withdrawal' | 'send';
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
 * For each currency already in the wallet, take max(backend, local).
 * For currencies only in local (e.g. deposited when backend was down),
 * add them as extra balance entries.
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
      return { ...b, amount: Math.max(b.amount, localBalances[b.currency] || 0) };
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
