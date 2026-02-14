import { API_BASE } from './client';
import { v4 as uuidv4 } from 'uuid';
import { safeApiCall } from '../utils/networkGuard';

export async function sendTransaction(
  token: string,
  fromWalletId: string,
  toWalletId: string,
  amount: number,
  currency: string,
  memo?: string
) {
  // Generate idempotency key to prevent double-sends
  const idempotencyKey = uuidv4();

  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        fromWalletId,
        toWalletId,
        amount,
        currency,
        memo,
        idempotencyKey,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Send failed');
    }

    return res.json();
  }, { 
    timeout: 20000, // 20 seconds for financial transactions
    retries: 0, // NO RETRIES for money sends (idempotency prevents duplicates)
    onError: (error) => console.error('Transaction failed:', error)
  });

  if (!result) {
    throw new Error('Transaction failed. Please check your connection and try again. Your money is safe.');
  }

  return result;
}

export async function fetchTransactions(
  token: string,
  walletId: string
) {
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/wallets/${walletId}/transactions`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Fetch transactions failed');
    }

    return res.json();
  }, { timeout: 10000, retries: 2 });

  if (!result) {
    throw new Error('Failed to load transactions. Please check your connection.');
  }

  return result;
}
