import { API_BASE } from './client';
import { safeApiCall } from '../utils/networkGuard';

export type User = { id: string; email: string; region?: string };

export async function register(email: string, password: string, region?: string) {
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, region })
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

export async function login(email: string, password: string) {
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
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
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/me`, { 
      headers: { Authorization: `Bearer ${token}` } 
    });
    if (!res.ok) throw new Error('Fetch profile failed');
    return res.json();
  }, { timeout: 10000, retries: 2 });

  if (!result) throw new Error('Failed to fetch profile. Please check your connection.');
  return result;
}

export async function listWallets(token: string) {
  const result = await safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/wallets`, { 
      headers: { Authorization: `Bearer ${token}` } 
    });
    if (!res.ok) throw new Error('Fetch wallets failed');
    return res.json();
  }, { timeout: 10000, retries: 2 });

  if (!result) throw new Error('Failed to fetch wallets. Please check your connection.');
  return result;
}
