const BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${sessionStorage.getItem('adminToken') || ''}`,
  };
}

async function adminFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...getHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) throw new Error('Unauthorized — please log in again.');
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Forbidden — insufficient permissions.');
  }
  return res;
}

export function hasPermission(permission) {
  try {
    const perms = JSON.parse(sessionStorage.getItem('adminPermissions') || '[]');
    return perms.includes('*') || perms.includes(permission);
  } catch {
    return false;
  }
}

export function getAdminProfile() {
  try {
    return JSON.parse(sessionStorage.getItem('adminProfile') || 'null');
  } catch {
    return null;
  }
}

export async function fetchMe() {
  const res = await adminFetch('/admin/auth/me');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const body = await res.json();
  sessionStorage.setItem('adminProfile', JSON.stringify(body.admin));
  sessionStorage.setItem('adminPermissions', JSON.stringify(body.admin.permissions || []));
  return body.admin;
}

export async function fetchStats() {
  const res = await adminFetch('/admin/stats');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function searchUsers(query) {
  const params = new URLSearchParams({ q: query.trim() });
  const res = await adminFetch(`/admin/users/search?${params}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchWithdrawals(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.currency) params.set('currency', filters.currency);
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
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

export async function reconcileWithdrawal(id) {
  const res = await adminFetch(`/admin/withdrawals/${id}/reconcile`, { method: 'POST', body: '{}' });
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

export async function fetchUserTimeline(id) {
  const res = await adminFetch(`/admin/users/${id}/timeline`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchUserNotes(id) {
  const res = await adminFetch(`/admin/users/${id}/notes`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function addUserNote(id, note) {
  const res = await adminFetch(`/admin/users/${id}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function userAction(id, action) {
  const res = await adminFetch(`/admin/users/${id}/${action}`, { method: 'POST', body: '{}' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export const suspendUser = (id) => userAction(id, 'suspend');
export const unsuspendUser = (id) => userAction(id, 'unsuspend');
export const lockUser = (id) => userAction(id, 'lock');
export const unlockUser = (id) => userAction(id, 'unlock');
export const resetFailedLogins = (id) => userAction(id, 'reset-failed-logins');

export async function fetchPendingKyc() {
  const res = await adminFetch('/admin/kyc/pending');
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

export async function fetchSystemLogs(limit = 100) {
  const res = await adminFetch(`/admin/logs/errors?limit=${limit}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchSettings() {
  const res = await adminFetch('/admin/settings');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function updateSettings(payload) {
  const res = await adminFetch('/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function login(email, password) {
  if (!email?.trim() || !password) throw new Error('Email and password are required.');
  const res = await fetch(`${BASE_URL}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  if (res.status === 401) throw new Error('Invalid email or password.');
  if (res.status === 423) throw new Error('Account temporarily locked. Try again later.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const { token, expiresAt, admin } = await res.json();
  sessionStorage.setItem('adminToken', token);
  sessionStorage.setItem('adminTokenExpiry', String(expiresAt));
  sessionStorage.setItem('adminProfile', JSON.stringify(admin));
  sessionStorage.setItem('adminPermissions', JSON.stringify(admin.permissions || []));
}

export function logout() {
  const token = sessionStorage.getItem('adminToken');
  if (token) {
    fetch(`${BASE_URL}/admin/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  sessionStorage.removeItem('adminToken');
  sessionStorage.removeItem('adminTokenExpiry');
  sessionStorage.removeItem('adminProfile');
  sessionStorage.removeItem('adminPermissions');
}

export function isLoggedIn() {
  const token = sessionStorage.getItem('adminToken');
  const expiresAt = Number(sessionStorage.getItem('adminTokenExpiry') || 0);
  if (!token) return false;
  if (Date.now() > expiresAt) { logout(); return false; }
  return true;
}
