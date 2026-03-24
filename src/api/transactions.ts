import { API_BASE } from './client';
import { v4 as uuidv4 } from 'uuid';

/** Fetch the primary currency of any wallet (used to preview FX before sending). */
export async function getWalletCurrency(
  token: string,
  walletId: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/wallets/${walletId}/currency`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 'XAF'; // graceful fallback
  const data = await res.json();
  return data.currency || 'XAF';
}

export interface FxQuote {
  fromCurrency: string;
  toCurrency: string;
  sentAmountMinor: number;
  receivedAmountMinor: number;
  rate: number;
  rateDisplay: string;
  isSameCurrency: boolean;
}

/** Get a real-time FX quote for a cross-currency transfer preview. */
export async function fetchFxQuote(
  token: string,
  from: string,
  to: string,
  amountMinor: number
): Promise<FxQuote | null> {
  try {
    const res = await fetch(
      `${API_BASE}/fx-quote?from=${from}&to=${to}&amount=${amountMinor}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

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

// Payment Requests
export async function createPaymentRequest(
  token: string,
  walletId: string,
  amount: number,
  currency: string,
  memo?: string
) {
  const idempotencyKey = uuidv4();
  
  const res = await fetch(`${API_BASE}/payment-requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ walletId, amount, currency, memo, idempotencyKey }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Create request failed');
  }

  return res.json();
}

export async function getPaymentRequests(token: string) {
  const res = await fetch(`${API_BASE}/payment-requests`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch requests failed');
  }

  return res.json();
}

export async function cancelPaymentRequest(token: string, requestId: string) {
  const res = await fetch(`${API_BASE}/payment-requests/${requestId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Cancel failed');
  }

  return res.json();
}

// Virtual Cards
export async function createVirtualCard(
  token: string,
  walletId: string,
  currency: string,
  label?: string
) {
  const idempotencyKey = uuidv4();
  
  const res = await fetch(`${API_BASE}/virtual-cards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ walletId, currency, label, idempotencyKey }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Create card failed');
  }

  return res.json();
}

export async function getVirtualCards(token: string) {
  const res = await fetch(`${API_BASE}/virtual-cards`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch cards failed');
  }

  return res.json();
}

export async function toggleCardFreeze(token: string, cardId: string) {
  const idempotencyKey = uuidv4();
  
  const res = await fetch(`${API_BASE}/virtual-cards/${cardId}/toggle-freeze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ idempotencyKey }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Toggle freeze failed');
  }

  return res.json();
}

export async function deleteVirtualCard(token: string, cardId: string) {
  const res = await fetch(`${API_BASE}/virtual-cards/${cardId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Delete card failed');
  }

  return res.json();
}

// Budgets
export async function createBudget(
  token: string,
  walletId: string,
  currency: string,
  monthlyLimit: number
) {
  const idempotencyKey = uuidv4();
  
  const res = await fetch(`${API_BASE}/budgets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ walletId, currency, monthlyLimit, idempotencyKey }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Create budget failed');
  }

  return res.json();
}

export async function getBudgets(token: string) {
  const res = await fetch(`${API_BASE}/budgets`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch budgets failed');
  }

  return res.json();
}

export async function getBudgetAnalytics(token: string, budgetId: string) {
  const res = await fetch(`${API_BASE}/budgets/${budgetId}/analytics`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch analytics failed');
  }

  return res.json();
}

export async function deleteBudget(token: string, budgetId: string) {
  const res = await fetch(`${API_BASE}/budgets/${budgetId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Delete budget failed');
  }

  return res.json();
}
