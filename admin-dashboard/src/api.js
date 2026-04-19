const BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionStorage.getItem('adminToken') || ''}`,
  };
}

export async function fetchWithdrawals(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status)   params.set('status',   filters.status);
  if (filters.currency) params.set('currency', filters.currency);
  if (filters.userId)   params.set('userId',   filters.userId);
  if (filters.page)     params.set('page',     String(filters.page));
  if (filters.limit)    params.set('limit',    String(filters.limit));
  const qs = params.toString();
  const url = `${BASE_URL}/admin/withdrawals${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: getHeaders() });
  if (res.status === 401) throw new Error('Unauthorized — check your admin secret.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchWithdrawalById(id) {
  const res = await fetch(`${BASE_URL}/admin/withdrawals/${id}`, { headers: getHeaders() });
  if (res.status === 401) throw new Error('Unauthorized — check your admin secret.');
  if (res.status === 404) throw new Error('Withdrawal not found.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function transitionWithdrawal(id, status, note) {
  const res = await fetch(`${BASE_URL}/admin/withdrawals/${id}/transition`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ status, note }),
  });
  if (res.status === 401) throw new Error('Unauthorized — check your admin secret.');
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function login(secret) {
  if (!secret || !secret.trim()) throw new Error('Secret cannot be empty.');
  const res = await fetch(`${BASE_URL}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secret.trim() }),
  });
  if (res.status === 401) throw new Error('Invalid admin secret.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const { token, expiresAt } = await res.json();
  sessionStorage.setItem('adminToken', token);
  sessionStorage.setItem('adminTokenExpiry', String(expiresAt));
}

export function logout() {
  sessionStorage.removeItem('adminToken');
  sessionStorage.removeItem('adminTokenExpiry');
}

export function isLoggedIn() {
  const token     = sessionStorage.getItem('adminToken');
  const expiresAt = Number(sessionStorage.getItem('adminTokenExpiry') || 0);
  if (!token) return false;
  if (Date.now() > expiresAt) { logout(); return false; }
  return true;
}
