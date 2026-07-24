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
  err: { error?: string; message?: string; code?: string; errorCode?: string; limitType?: string },
  fallback: string,
  status: number,
  meta?: { endpoint?: string; idempotencyKey?: string },
): never {
  const error = new Error(err.error || err.message || fallback) as Error & {
    code?: string;
    errorCode?: string;
    limitType?: string;
    status?: number;
    endpoint?: string;
    idempotencyKey?: string;
  };
  error.code = err.code;
  error.errorCode = err.errorCode;
  error.limitType = err.limitType;
  error.status = status;
  if (meta?.endpoint) error.endpoint = meta.endpoint;
  if (meta?.idempotencyKey) error.idempotencyKey = meta.idempotencyKey;
  throw error;
}

function throwTimeoutError(): never {
  const err: any = new Error('Request timeout');
  err.status = 408;
  err.code = 'REQUEST_TIMEOUT';
  throw err;
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
    if (signal?.aborted) throw err;
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throwTimeoutError();
    }
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

const MONEY_OP_TIMEOUT_MS = 30000;

/** POST with idempotency key — retries once on transport failure or ambiguous non-OK. */
async function postWithIdempotencyRetry(
  url: string,
  body: string,
  idempotencyKey: string,
  timeoutMs = MONEY_OP_TIMEOUT_MS,
): Promise<any> {
  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'Accept-Language': getApiLanguage(),
  };

  async function postOnce(signal?: AbortSignal) {
    return fetchWithTokenRefresh(url, { method: 'POST', headers, body, signal });
  }

  async function reconcile(): Promise<any | null> {
    try {
      const retry = await postOnce();
      if (retry.ok) return retry.json();
    } catch { /* fall through */ }
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await postOnce(controller.signal);
  } catch (err: any) {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    if (err?.name === 'AbortError') {
      throwTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Request failed', res.status, { idempotencyKey });
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

  return postWithIdempotencyRetry(
    `${API_BASE}/transactions`,
    JSON.stringify({
      fromWalletId,
      toWalletId,
      amount,
      currency,
      memo,
      idempotencyKey,
    }),
    idempotencyKey,
  );
}

/** Pay a payment request with idempotency retry (same key on double-tap / timeout). */
export async function payPaymentRequest(
  token: string,
  requestId: string,
  fromWalletId: string,
  callerIdempotencyKey?: string,
): Promise<any> {
  const idempotencyKey = callerIdempotencyKey || generateId();

  return postWithIdempotencyRetry(
    `${API_BASE}/payment-requests/${encodeURIComponent(requestId)}/pay`,
    JSON.stringify({ fromWalletId, idempotencyKey }),
    idempotencyKey,
  );
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
    throwApiError(err, 'Fetch transactions failed', res.status);
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
    throwApiError(err, 'Create request failed', res.status);
  }

  return res.json();
}

export async function getPaymentRequests(token: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/payment-requests`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Fetch requests failed', res.status);
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
    throwApiError(err, 'Cancel failed', res.status);
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
    throwApiError(err, 'Create card failed', res.status);
  }

  return res.json();
}

export async function getVirtualCards(token: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/virtual-cards`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Fetch cards failed', res.status);
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
    throwApiError(err, 'Toggle freeze failed', res.status);
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
    throwApiError(err, 'Delete card failed', res.status);
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
    throwApiError(err, 'Create budget failed', res.status);
  }

  return res.json();
}

export async function getBudgets(token: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/budgets`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Fetch budgets failed', res.status);
  }

  return res.json();
}

export async function getBudgetAnalytics(token: string, budgetId: string) {
  const res = await fetchWithTokenRefresh(`${API_BASE}/budgets/${budgetId}/analytics`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Fetch analytics failed', res.status);
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
    throwApiError(err, 'Delete budget failed', res.status);
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
    if (err?.name === 'AbortError') throwTimeoutError();
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'QR payment failed', res.status);
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
  const endpoint = 'POST /exchange';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

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
    const isAbort = controller.signal.aborted || err?.name === 'AbortError';
    const error: any = isAbort
      ? (() => {
          const timeoutErr: any = new Error('Request timeout');
          timeoutErr.status = 408;
          timeoutErr.code = 'REQUEST_TIMEOUT';
          return timeoutErr;
        })()
      : err;
    if (error && typeof error === 'object') {
      (error as any).endpoint = endpoint;
      (error as any).idempotencyKey = idempotencyKey;
    }
    if (__DEV__) console.warn('[Exchange] transport error', {
      message: error?.message,
      status: (error as any)?.status,
      aborted: controller.signal.aborted,
      endpoint,
      idempotencyKey,
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (__DEV__) console.warn('[Exchange] API error', {
      message: err.error || err.message || 'Exchange failed',
      status: res.status,
      endpoint,
      idempotencyKey,
      code: err.code,
    });
    throwApiError(err, 'Exchange failed', res.status, { endpoint, idempotencyKey });
  }

  return res.json();
}

