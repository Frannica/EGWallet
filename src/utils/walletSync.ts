/**
 * walletSync — fetch backend wallets and overwrite local cache.
 * Backend is the only source of truth for displayed balances.
 */

import { listWallets } from '../api/auth';
import {
  syncLocalBalancesFromBackend,
  mergeWithLocalBalances,
  getLocalBalances,
  LocalBalances,
} from './localBalance';

export async function refreshWalletFromBackend(token: string): Promise<{
  wallets: Array<any>;
  localBalances: LocalBalances;
}> {
  const res = await listWallets(token);
  const backendWallets = res.wallets || [];
  await syncLocalBalancesFromBackend(backendWallets);
  const localBalances = await getLocalBalances();
  return {
    wallets: mergeWithLocalBalances(backendWallets, localBalances),
    localBalances,
  };
}
