import { API_BASE, getApiLanguage } from './client';
import { safeApiCall } from '../utils/networkGuard';
import { getDeviceId } from '../utils/deviceInfo';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';

export type User = { id: string; email: string; region?: string };

function throwHttpError(status: number, body: any, fallback: string): never {
  const err: any = new Error(body?.error || body?.message || fallback);
  err.status = status;
  if (body?.errorCode) err.errorCode = body.errorCode;
  throw err;
}

// Module-level cache so getDeviceId() is only awaited once per session
let _deviceId: string | null = null;
async function cachedDeviceId(): Promise<string> {
  if (_deviceId) return _deviceId;
  _deviceId = await getDeviceId().catch(() => 'unknown');
  return _deviceId;
}

export async function register(email: string, password: string, region?: string, deviceInfo?: any) {
  const deviceId = await cachedDeviceId();
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'Accept-Language': getApiLanguage() },
      body: JSON.stringify({ email, password, region, deviceInfo })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throwHttpError(res.status, err, 'Register failed');
    }
    return res.json();
  }, { timeout: 15000, retries: 1 });

  if (!result) throw new Error('Network request failed');
  return result;
}

export async function login(email: string, password: string, deviceInfo?: any) {
  const deviceId = await cachedDeviceId();
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'Accept-Language': getApiLanguage() },
      body: JSON.stringify({ email, password, deviceInfo })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throwHttpError(res.status, err, 'Login failed');
    }
    return res.json();
  }, { timeout: 15000, retries: 1 });

  if (!result) throw new Error('Network request failed');
  return result;
}

export async function me(token: string) {
  const deviceId = await cachedDeviceId();
  const result = await safeApiCall(async () => {
    const res = await fetchWithTokenRefresh(`${API_BASE}/me`, {
      headers: { 'x-device-id': deviceId, 'Accept-Language': getApiLanguage() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throwHttpError(res.status, err, 'Fetch profile failed');
    }
    return res.json();
  }, { timeout: 20000, retries: 2 });

  if (!result) throw new Error('Network request failed');
  return result;
}

export async function listWallets(token: string) {
  const deviceId = await cachedDeviceId();
  const result = await safeApiCall(async () => {
    const res = await fetchWithTokenRefresh(`${API_BASE}/wallets`, {
      headers: { 'x-device-id': deviceId, 'Accept-Language': getApiLanguage() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throwHttpError(res.status, err, 'Fetch wallets failed');
    }
    return res.json();
  }, { timeout: 20000, retries: 2 });

  if (!result) throw new Error('Network request failed');
  return result;
}

