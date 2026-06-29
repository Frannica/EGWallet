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
  return req.headers['x-admin-id'] || req.headers['x-admin-name'] || 'admin';
}

function logAdminAction(req, action, details = {}) {
  const entry = {
    id: uuidv4(),
    adminId: getAdminActor(req),
    action,
    details,
    timestamp: Date.now(),
    ipAddress: getClientIP(req),
    userAgent: req?.headers?.['user-agent'] || 'unknown',
  };
  adminAuditLogs.push(entry);
  if (adminAuditLogs.length > MAX_LOGS) adminAuditLogs.shift();
  auditLogger.info('ADMIN_ACTION', entry);
  return entry;
}

function getAdminAuditLogs({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  return adminAuditLogs.slice(-safeLimit).reverse();
}

module.exports = {
  logAdminAction,
  getAdminAuditLogs,
  getAdminActor,
};
