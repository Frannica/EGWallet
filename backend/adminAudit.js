'use strict';

const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const path = require('path');

const logDir = path.join(__dirname, 'logs');
const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({
      filename: process.env.AUDIT_LOG_PATH || path.join(logDir, 'audit.log'),
      maxsize: 52428800,
      maxFiles: 20,
    }),
  ],
});

const adminAuditLogs = [];
const MAX_LOGS = parseInt(process.env.MAX_ADMIN_AUDIT_LOGS || '5000', 10);

function getClientIP(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req?.headers?.['x-real-ip'] || req?.connection?.remoteAddress || 'unknown';
}

function getAdminActor(req) {
  if (req?.admin?.email) return req.admin.email;
  if (req?.admin?.id) return req.admin.id;
  return req.headers['x-admin-id'] || req.headers['x-admin-name'] || 'admin';
}

function parseBrowser(userAgent) {
  const ua = userAgent || 'unknown';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  return ua.slice(0, 80);
}

function logAdminAction(req, action, payload = {}) {
  const { before, after, ...details } = payload;
  const entry = {
    id: uuidv4(),
    admin: getAdminActor(req),
    adminId: req?.admin?.id || details.adminId || null,
    action,
    timestamp: Date.now(),
    ipAddress: getClientIP(req),
    browser: parseBrowser(req?.headers?.['user-agent']),
    userAgent: req?.headers?.['user-agent'] || 'unknown',
    before: before ?? null,
    after: after ?? null,
    details,
  };
  adminAuditLogs.push(entry);
  if (adminAuditLogs.length > MAX_LOGS) adminAuditLogs.shift();
  auditLogger.info('ADMIN_ACTION', entry);
  return entry;
}

function auditChange(req, action, { before, after, ...details }) {
  return logAdminAction(req, action, { before, after, ...details });
}

function getAdminAuditLogs({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  return adminAuditLogs.slice(-safeLimit).reverse();
}

module.exports = {
  logAdminAction,
  auditChange,
  getAdminAuditLogs,
  getAdminActor,
  parseBrowser,
};
