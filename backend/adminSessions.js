'use strict';

const crypto = require('crypto');

const ONLINE_TTL_MS = parseInt(process.env.ADMIN_ONLINE_TTL_MS || '300000', 10);
const csrfTokens = new Map();
const onlineAdmins = new Map();

function getClientIP(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req?.headers?.['x-real-ip'] || req?.connection?.remoteAddress || 'unknown';
}

function issueCsrfToken(adminId) {
  const token = crypto.randomBytes(24).toString('hex');
  csrfTokens.set(adminId, token);
  return token;
}

function validateCsrfToken(adminId, token) {
  if (!adminId || !token) return false;
  return csrfTokens.get(adminId) === token;
}

function revokeCsrfToken(adminId) {
  csrfTokens.delete(adminId);
}

function touchOnlineAdmin(req) {
  if (!req?.admin?.id) return;
  onlineAdmins.set(req.admin.id, {
    adminId: req.admin.id,
    email: req.admin.email,
    role: req.admin.role,
    lastSeen: Date.now(),
    lastLoginAt: req.admin.lastLoginAt || null,
    ipAddress: getClientIP(req),
  });
}

function removeOnlineAdmin(adminId) {
  onlineAdmins.delete(adminId);
}

function getOnlineAdmins() {
  const now = Date.now();
  for (const [id, session] of onlineAdmins.entries()) {
    if (now - session.lastSeen > ONLINE_TTL_MS) onlineAdmins.delete(id);
  }
  return [...onlineAdmins.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

function adminCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'];
  if (!validateCsrfToken(req.admin?.id, token)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

module.exports = {
  issueCsrfToken,
  validateCsrfToken,
  revokeCsrfToken,
  touchOnlineAdmin,
  removeOnlineAdmin,
  getOnlineAdmins,
  adminCsrf,
};
