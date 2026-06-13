import { API_BASE, getApiLanguage } from './client';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';

/** RFC-4122 v4 UUID using Math.random — no crypto.getRandomValues() needed. */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Fetch the primary currency of any wallet (used to preview FX before sending). */
export async function getWalletCurrency(
  token: string,
  walletId: string
): Promise<string> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/wallets/${encodeURIComponent(walletId)}/currency`, {
    headers: { 'Accept-Language': getApiLanguage() },
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
  // Fee-aware fields (returned when FX fee is applied server-side)
  fxFeeAmount?: number;
  receivedAmountMinorAfterFee?: number;
  fxFeeRate?: number;
  // Rate freshness (populated by backend FX system)
  ratesUpdatedAt?: number;
  ratesStale?: boolean;
}

function throwApiError(
  err: { error?: string; message?: string; code?: string; limitType?: string },
  fallback: string,
  status: number,
): never {
  const error = new Error(err.error || err.message || fallback) as Error & {
    code?: string;
    limitType?: string;
    status?: number;
  };
  error.code = err.code;
  error.limitType = err.limitType;
  error.status = status;
  throw error;
}

/** Get a real-time FX quote for a cross-currency transfer preview. */
export async function fetchFxQuote(
  token: string,
  from: string,
  to: string,
  amountMinor: number,
  signal?: AbortSignal,
): Promise<FxQuote> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }

  let res: Response;
  try {
    res = await fetchWithTokenRefresh(
      `${API_BASE}/fx-quote?from=${from}&to=${to}&amount=${amountMinor}`,
      { headers: { 'Accept-Language': getApiLanguage() }, signal: controller.signal },
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Quote unavailable', res.status);
  }
  return res.json();
}

export async function sendTransaction(
  token: string,
  fromWalletId: string,
  toWalletId: string,
  amount: number,
  currency: string,
  memo?: string,
  /** Caller-supplied stable key — reused across retries to prevent double-sends. */
  callerIdempotencyKey?: string,
) {
  const idempotencyKey = callerIdempotencyKey || generateId();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetchWithTokenRefresh(`${API_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Accept-Language': getApiLanguage(),
      },
      body: JSON.stringify({
        fromWalletId,
        toWalletId,
        amount,
        currency,
        memo,
        idempotencyKey,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.error || 'Send failed') as Error & { code?: string; limitType?: string };
    error.code = err.code;
    error.limitType = err.limitType;
    throw error;
  }

  return res.json();
}

export async function fetchTransactions(
  token: string,
  walletId: string
) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/wallets/${walletId}/transactions`, {
    headers: { 'Accept-Language': getApiLanguage() },
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
  const idempotencyKey = generateId();
  
  const res = await fetchWithTokenRefresh(`${API_BASE}/payment-requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'Accept-Language': getApiLanguage(),
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
  const res = await fetchWithTokenRefresh(`${API_BASE}/payment-requests`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch requests failed');
  }

  return res.json();
}

export async function cancelPaymentRequest(token: string, requestId: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/payment-requests/${requestId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': getApiLanguage(),
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
  const idempotencyKey = generateId();
  
  const res = await fetchWithTokenRefresh(`${API_BASE}/virtual-cards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'Accept-Language': getApiLanguage(),
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
  const res = await fetchWithTokenRefresh(`${API_BASE}/virtual-cards`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch cards failed');
  }

  return res.json();
}

export async function toggleCardFreeze(token: string, cardId: string) {
  const idempotencyKey = generateId();
  
  const res = await fetchWithTokenRefresh(`${API_BASE}/virtual-cards/${cardId}/toggle-freeze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'Accept-Language': getApiLanguage(),
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
  const res = await fetchWithTokenRefresh(`${API_BASE}/virtual-cards/${cardId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': getApiLanguage(),
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
  const idempotencyKey = generateId();
  
  const res = await fetchWithTokenRefresh(`${API_BASE}/budgets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'Accept-Language': getApiLanguage(),
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
  const res = await fetchWithTokenRefresh(`${API_BASE}/budgets`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch budgets failed');
  }

  return res.json();
}

export async function getBudgetAnalytics(token: string, budgetId: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/budgets/${budgetId}/analytics`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Fetch analytics failed');
  }

  return res.json();
}

export async function deleteBudget(token: string, budgetId: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/budgets/${budgetId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': getApiLanguage(),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Delete budget failed');
  }

  return res.json();
}

// ─── QR helpers ──────────────────────────────────────────────────────────────

export interface ValidatedQr {
  valid: boolean;
  type?: 'static' | 'dynamic';
  /** Display name of recipient (static QR) */
  displayName?: string;
  /** Whether the payer must supply the amount (static QR) */
  requiresAmount?: boolean;
  /** Amount in minor units (dynamic QR) */
  amount?: number;
  currency?: string;
  memo?: string;
  requestId?: string;
  walletId?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Validates a server-issued QR string via POST /qr/validate.
 * Rejects forged/unsigned QR codes before any money moves.
 */
export async function validateQr(token: string, qrString: string): Promise<ValidatedQr> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/qr/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': getApiLanguage(),
    },
    body: JSON.stringify({ qrString }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { valid: false, error: err.error || 'QR validation failed' };
  }
  return res.json();
}

/**
 * Pays via POST /qr/pay using a server-issued QR string.
 * For static QRs the payer supplies amount + currency.
 * For dynamic QRs the amount is embedded in the server record.
 */
export async function payViaQr(
  token: string,
  qrString: string,
  fromWalletId: string,
  amount?: number,
  currency?: string,
  /** Caller-supplied stable key — reused across retries to prevent double-charges. */
  callerIdempotencyKey?: string,
): Promise<any> {
  const idempotencyKey = callerIdempotencyKey || generateId();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetchWithTokenRefresh(`${API_BASE}/qr/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Accept-Language': getApiLanguage(),
      },
      body: JSON.stringify({ qrString, fromWalletId, amount, currency, idempotencyKey }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'QR payment failed');
  }

  return res.json();
}

/** Submit a same-wallet currency exchange (POST /exchange). */
export async function exchangeCurrency(
  token: string,
  walletId: string,
  fromCurrency: string,
  toCurrency: string,
  amount: number,
  /** Caller-supplied stable key — reused across retries to prevent double-exchanges. */
  callerIdempotencyKey?: string,
): Promise<any> {
  const idempotencyKey = callerIdempotencyKey || generateId();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetchWithTokenRefresh(`${API_BASE}/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Accept-Language': getApiLanguage(),
      },
      body: JSON.stringify({ walletId, fromCurrency, toCurrency, amount, idempotencyKey }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Exchange failed', res.status);
  }

  return res.json();
}

