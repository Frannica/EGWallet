import { API_BASE } from './client';
import { v4 as uuidv4 } from 'uuid';

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
}

export async function fetchTransactions(
  token: string,
  walletId: string
) {
  const res = await fetch(`${API_BASE}/wallets/${walletId}/transactions`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch transactions failed');
  }

  return res.json();
}
