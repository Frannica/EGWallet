import { API_BASE, getApiLanguage } from './client';
import { safeApiCall } from '../utils/networkGuard';
import { getDeviceId } from '../utils/deviceInfo';

export type User = { id: string; email: string; region?: string };

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
      throw new Error(err.error || 'Register failed');
    }
    return res.json();
  }, { timeout: 15000, retries: 1 });

  if (!result) throw new Error('Registration failed. Please check your connection.');
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
      throw new Error(err.error || 'Login failed');
    }
    return res.json();
  }, { timeout: 15000, retries: 1 });

  if (!result) throw new Error('Login failed. Please check your connection.');
  return result;
}

export async function me(token: string) {
  const deviceId = await cachedDeviceId();
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId, 'Accept-Language': getApiLanguage() }
    });
    if (!res.ok) throw new Error('Fetch profile failed');
    return res.json();
  }, { timeout: 20000, retries: 2 });

  if (!result) throw new Error('Failed to fetch profile. Please check your connection.');
  return result;
}

export async function listWallets(token: string) {
  const deviceId = await cachedDeviceId();
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/wallets`, {
      headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId, 'Accept-Language': getApiLanguage() }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Fetch wallets failed');
    }
    return res.json();
  }, { timeout: 20000, retries: 2 });

  if (!result) throw new Error('Could not reach the server. Check that your computer and phone are on the same Wi-Fi.');
  return result;
}
