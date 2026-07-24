import { API_BASE, getApiLanguage } from './client';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';

/**
 * Stripe Connect (Express accounts) client — US/UK/European withdrawal
 * onboarding. All endpoints are inert (return enabled: false / 503) unless
 * the backend has STRIPE_CONNECT_ENABLED=true and the operator has populated
 * STRIPE_CONNECT_APPROVED_COUNTRIES with Stripe-confirmed corridors. See
 * backend/stripeConnect.js for the compliance gate this depends on.
 */

function throwApiError(err: any, fallback: string, status: number): never {
  const error = new Error(err?.error || err?.message || fallback) as Error & {
    errorCode?: string;
    status?: number;
  };
  error.errorCode = err?.errorCode;
  error.status = status;
  throw error;
}

export interface StripeConnectCountries {
  enabled: boolean;
  countries: string[];
}

export interface StripeConnectStatus {
  exists: boolean;
  onboardingStatus: 'not_started' | 'onboarding' | 'pending_verification' | 'complete' | 'restricted';
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  detailsSubmitted?: boolean;
  currentlyDue?: string[];
  disabledReason?: string | null;
  country?: string;
}

export interface StripeConnectOnboardingLink {
  stripeAccountId: string;
  url: string;
  expiresAt: number;
}

/** Which ISO-2 countries this deployment currently supports for Stripe Connect withdrawals. */
export async function getStripeConnectCountries(): Promise<StripeConnectCountries> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/stripe-connect/countries`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });
  if (!res.ok) {
    // Fail closed — treat any error as "not available" rather than surfacing
    // a broken onboarding entry point.
    return { enabled: false, countries: [] };
  }
  return res.json();
}

/** Current user's Connect onboarding/account status (DB read only, no Stripe call). */
export async function getStripeConnectStatus(): Promise<StripeConnectStatus> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/stripe-connect/status`, {
    headers: { 'Accept-Language': getApiLanguage() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Failed to fetch Stripe Connect status', res.status);
  }
  return res.json();
}

/** Creates (or reuses) the user's connected account and returns a fresh onboarding URL. */
export async function startStripeConnectOnboarding(country: string): Promise<StripeConnectOnboardingLink> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/stripe-connect/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': getApiLanguage() },
    body: JSON.stringify({ country }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Failed to start Stripe onboarding', res.status);
  }
  return res.json();
}

/** Account Links expire quickly — call this if the user navigated away before finishing. */
export async function refreshStripeConnectLink(): Promise<StripeConnectOnboardingLink> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/stripe-connect/refresh-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': getApiLanguage() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Failed to refresh Stripe onboarding link', res.status);
  }
  return res.json();
}

/** Pulls the latest status directly from Stripe — call after returning from hosted onboarding. */
export async function syncStripeConnectStatus(): Promise<StripeConnectStatus> {
  const res = await fetchWithTokenRefresh(`${API_BASE}/stripe-connect/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': getApiLanguage() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throwApiError(err, 'Failed to sync Stripe Connect status', res.status);
  }
  return res.json();
}
