const BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionStorage.getItem('adminToken') || ''}`,
  };
}

async function adminFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...getHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) throw new Error('Unauthorized — please log in again.');
  return res;
}

export async function fetchWithdrawals(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status)   params.set('status',   filters.status);
  if (filters.currency) params.set('currency', filters.currency);
  if (filters.userId)   params.set('userId',   filters.userId);
  if (filters.page)     params.set('page',     String(filters.page));
  if (filters.limit)    params.set('limit',    String(filters.limit));
  const qs = params.toString();
  const res = await adminFetch(`/admin/withdrawals${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchWithdrawalById(id) {
  const res = await adminFetch(`/admin/withdrawals/${id}`);
  if (res.status === 404) throw new Error('Withdrawal not found.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function transitionWithdrawal(id, status, note) {
  const res = await adminFetch(`/admin/withdrawals/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ status, note }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function fetchUsers(query = '') {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  const qs = params.toString();
  const res = await adminFetch(`/admin/users${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchUserById(id) {
  const res = await adminFetch(`/admin/users/${id}`);
  if (res.status === 404) throw new Error('User not found.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchPendingKyc() {
  const res = await adminFetch('/admin/kyc/pending');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchKycDocumentMeta(id) {
  const res = await adminFetch(`/admin/kyc/documents/${id}`);
  if (res.status === 404) throw new Error('Document not found.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchKycDocumentBlob(id) {
  const res = await adminFetch(`/admin/kyc/documents/${id}/content`, {
    headers: { Authorization: `Bearer ${sessionStorage.getItem('adminToken') || ''}` },
  });
  if (res.status === 401) throw new Error('Unauthorized — please log in again.');
  if (res.status === 404) throw new Error('Document not found.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function approveKycDocument(id, kycTier = 1) {
  const res = await adminFetch(`/admin/kyc/documents/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ kycTier }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function rejectKycDocument(id, reason, kycTier = 0) {
  const res = await adminFetch(`/admin/kyc/documents/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason, kycTier }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
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
