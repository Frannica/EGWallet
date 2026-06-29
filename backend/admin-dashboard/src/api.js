const BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function getHeaders(mutating = false) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${sessionStorage.getItem('adminToken') || ''}`,
  };
  if (mutating) {
    const csrf = sessionStorage.getItem('adminCsrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

function persistSession(body) {
  sessionStorage.setItem('adminToken', body.token);
  sessionStorage.setItem('adminRefreshToken', body.refreshToken || '');
  sessionStorage.setItem('adminCsrf', body.csrfToken || '');
  sessionStorage.setItem('adminTokenExpiry', String(body.expiresAt));
  sessionStorage.setItem('adminProfile', JSON.stringify(body.admin));
  sessionStorage.setItem('adminPermissions', JSON.stringify(body.admin?.permissions || []));
}

async function tryRefreshSession() {
  const refreshToken = sessionStorage.getItem('adminRefreshToken');
  if (!refreshToken) return false;
  const res = await fetch(`${BASE_URL}/admin/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  persistSession(await res.json());
  return true;
}

async function adminFetch(path, options = {}) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase());
  let res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...getHeaders(mutating), ...(options.headers || {}) },
  });

  if (res.status === 401) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { ...getHeaders(mutating), ...(options.headers || {}) },
      });
    }
  }

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

export async function sendHeartbeat() {
  await adminFetch('/admin/auth/heartbeat', { method: 'POST', body: '{}' });
}

export async function fetchDashboardOverview() {
  const res = await adminFetch('/admin/overview');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchAdminHealth() {
  const res = await adminFetch('/admin/overview/health');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function globalSearch(query) {
  const params = new URLSearchParams({ q: query.trim() });
  const res = await adminFetch(`/admin/search?${params}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchAuditLog(limit = 100) {
  const res = await adminFetch(`/admin/audit/actions?limit=${limit}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function exportUserCsv(userId) {
  const res = await adminFetch(`/admin/users/${userId}/export`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `user-${userId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadKycDocument(id) {
  const res = await adminFetch(`/admin/kyc/documents/${id}/download`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kyc-${id}`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function searchUsers(query) {
  const params = new URLSearchParams({ q: query.trim() });
  const res = await adminFetch(`/admin/users/search?${params}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchWithdrawals(filters = {}) {
  const params = new URLSearchParams();
  if (filters.queue) params.set('queue', filters.queue);
  if (filters.status) params.set('status', filters.status);
  if (filters.currency) params.set('currency', filters.currency);
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const res = await adminFetch(`/admin/withdrawals${qs ? '?' + qs : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
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
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function reconcileWithdrawal(id) {
  const res = await adminFetch(`/admin/withdrawals/${id}/reconcile`, { method: 'POST', body: '{}' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function fetchSupportTickets(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  const qs = params.toString();
  const res = await adminFetch(`/admin/support/tickets${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchSupportTicket(id) {
  const res = await adminFetch(`/admin/support/tickets/${id}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function replySupportTicket(id, message) {
  const res = await adminFetch(`/admin/support/tickets/${id}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function closeSupportTicket(id, resolution) {
  const res = await adminFetch(`/admin/support/tickets/${id}/close`, {
    method: 'POST',
    body: JSON.stringify({ resolution }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function fetchDisputes(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  const qs = params.toString();
  const res = await adminFetch(`/admin/disputes${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function updateDispute(id, payload) {
  const res = await adminFetch(`/admin/disputes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function sendNotification(payload) {
  const res = await adminFetch('/admin/notifications/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function broadcastAnnouncement(payload) {
  const res = await adminFetch('/admin/notifications/announcements', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server error: ${res.status}`);
  }
  return res.json();
}

export async function fetchAnnouncements() {
  const res = await adminFetch('/admin/notifications/announcements');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

export async function fetchFraudSignals(filters = {}) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.userId) params.set('userId', filters.userId);
  const qs = params.toString();
  const res = await adminFetch(`/admin/fraud${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
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
  if (res.status === 404) throw new Error('Document not found.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return URL.createObjectURL(await res.blob());
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
  if (res.status === 429) throw new Error('Too many login attempts. Try again later.');
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  persistSession(await res.json());
}

export function logout() {
  const token = sessionStorage.getItem('adminToken');
  const refreshToken = sessionStorage.getItem('adminRefreshToken');
  const csrf = sessionStorage.getItem('adminCsrf');
  if (token) {
    fetch(`${BASE_URL}/admin/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf || '',
      },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  ['adminToken', 'adminRefreshToken', 'adminCsrf', 'adminTokenExpiry', 'adminProfile', 'adminPermissions'].forEach((k) => {
    sessionStorage.removeItem(k);
  });
}

export function isLoggedIn() {
  const token = sessionStorage.getItem('adminToken');
  const expiresAt = Number(sessionStorage.getItem('adminTokenExpiry') || 0);
  if (!token) return false;
  if (Date.now() > expiresAt) { logout(); return false; }
  return true;
}

export function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  localStorage.setItem('adminTheme', next);
  return next;
}

export function initTheme() {
  const saved = localStorage.getItem('adminTheme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
}
