import { API_BASE, getApiLanguage } from './client';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';

function throwApiError(err: any, fallback: string, status: number): never {
  const error = new Error(err?.error || err?.message || fallback) as Error & {
    errorCode?: string;
    status?: number;
  };
  error.errorCode = err?.errorCode;
  error.status = status;
  throw error;
}

export interface GridStatus {
  configured: boolean;
  webhookPublicKeyConfigured: boolean;
  countries: string[];
  customer: {
    gridCustomerId: string;
    kycStatus: string | null;
    termsVersion: string | null;
    termsAcceptedAt: string | null;
  } | null;
}

export interface GridKycLink {
  kycUrl: string;
  expiresAt?: string;
  provider?: string;
}

export async function getGridStatus(): Promise<GridStatus> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/grid/status`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });
  if (!res.ok) {
    return { configured: false, webhookPublicKeyConfigured: false, countries: [], customer: null };
  }
  return res.json();
}

export async function getGridEndUserTerms(): Promise<{ version: string; url: string }> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/grid/end-user-terms`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Unable to load Grid End User Terms', res.status);
  }
  return res.json();
}

export async function createGridCustomer(input: {
  fullName: string;
  acceptanceMethod: 'CHECKBOX' | 'CLICK_TO_ACCEPT';
  region?: string;
  currencies?: string[];
}): Promise<{ customer: GridStatus['customer'] }> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/grid/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': getApiLanguage() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Grid customer creation failed', res.status);
  }
  return res.json();
}

export async function createGridKycLink(redirectUri?: string): Promise<GridKycLink> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/grid/customers/kyc-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': getApiLanguage() },
    body: JSON.stringify(redirectUri ? { redirectUri } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Grid hosted KYC link is unavailable', res.status);
  }
  return res.json();
}

/** Create the Grid customer (End User Terms) and return a hosted KYC URL when Sandbox provides one. */
export async function startGridOnboarding(fullName: string, region?: string): Promise<{ kycUrl?: string }> {
  await createGridCustomer({
    fullName,
    acceptanceMethod: 'CLICK_TO_ACCEPT',
    region,
    currencies: ['USD', 'EUR', 'GBP'],
  });
  try {
    const link = await createGridKycLink();
    return { kycUrl: link.kycUrl };
  } catch {
    return {};
  }
}
