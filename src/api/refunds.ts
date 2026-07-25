import { API_BASE } from './client';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';
import { generateId } from './transactions';

export type RefundStatus =
  | 'requested'
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface RefundEligibility {
  eligible: boolean;
  depositTransactionId: string;
  stripePaymentIntentId: string | null;
  currency: string;
  depositAmount: number;
  grossAmount: number | null;
  feeAmount: number | null;
  walletRefundable: number;
  availableBalance: number;
  maxRefundable: number;
  withinRefundWindow: boolean;
  refundWindowDays: number;
  accountStatus: string;
  stripe: {
    available: boolean;
    reason: string;
    charged: number | null;
    alreadyRefunded: number | null;
    remaining: number | null;
    intentStatus: string | null;
  };
  destinationPolicy: 'original_payment_method_only';
  message: string;
}

export interface RefundRequest {
  id: string;
  userId: string;
  walletId: string;
  depositTransactionId: string;
  stripePaymentIntentId: string;
  stripeRefundId: string | null;
  amount: number;
  stripeRefundAmount: number;
  currency: string;
  status: RefundStatus;
  statusHistory: Array<{ status: string; at: number; by: string; reason?: string }>;
  holdPlaced: boolean;
  holdReleased: boolean;
  walletDebited: boolean;
  failureReason: string | null;
  stripeStatus: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.errorCode = data.errorCode;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getRefundEligibility(transactionId: string): Promise<RefundEligibility> {
  const res = await fetchWithTokenRefresh(
    `${API_BASE}/refunds/eligibility/${encodeURIComponent(transactionId)}`,
    { method: 'GET' },
  );
  return parseJson(res);
}

export async function requestRefund(opts: {
  depositTransactionId: string;
  amount?: number;
  amountMode?: 'full' | 'partial';
  idempotencyKey?: string;
}): Promise<{ refund: RefundRequest; message?: string; destinationPolicy: string }> {
  const key = opts.idempotencyKey || generateId();
  const res = await fetchWithTokenRefresh(`${API_BASE}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      depositTransactionId: opts.depositTransactionId,
      ...(opts.amountMode === 'full'
        ? { amountMode: 'full' }
        : { amount: opts.amount, amountMode: 'partial' }),
    }),
  });
  return parseJson(res);
}

export async function listRefunds(): Promise<{ refunds: RefundRequest[] }> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/refunds`, { method: 'GET' });
  return parseJson(res);
}

export async function getRefund(id: string): Promise<{ refund: RefundRequest }> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/refunds/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return parseJson(res);
}
