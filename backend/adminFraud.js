'use strict';

const express = require('express');
const { adminAuth, requirePermission } = require('./adminAuth');
const { loadAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

function buildFraudSignals(db) {
  const signals = [];

  for (const alert of db.fraudAlerts || []) {
    signals.push({
      id: alert.id || `fraud-${alert.userId}-${alert.createdAt}`,
      type: 'fraud_alert',
      severity: alert.severity || 'high',
      userId: alert.userId || null,
      summary: alert.reason || alert.type || 'Fraud alert',
      source: 'fraud_alerts',
      createdAt: alert.createdAt || Date.now(),
      metadata: alert,
    });
  }

  for (const ticket of db.supportTickets || []) {
    const tags = ticket.tags || [];
    const isFraud = tags.some((t) => /fraud|theft|velocity|suspicious/i.test(t))
      || /fraud|theft|unauthorized/i.test(ticket.category || '')
      || /fraud|theft|stolen|hack/i.test(ticket.subject || '');
    if (isFraud && ticket.status !== 'closed') {
      signals.push({
        id: `ticket-${ticket.id}`,
        type: 'support_escalation',
        severity: ticket.priority === 'urgent' ? 'critical' : 'high',
        userId: ticket.userId,
        summary: ticket.subject,
        source: 'support_tickets',
        createdAt: ticket.createdAt,
        metadata: { ticketId: ticket.id, status: ticket.status, tags },
      });
    }
  }

  for (const dispute of db.disputes || []) {
    if (dispute.status === 'open' || dispute.status === 'investigating') {
      signals.push({
        id: `dispute-${dispute.id}`,
        type: 'dispute',
        severity: dispute.reason === 'unauthorized' ? 'critical' : 'medium',
        userId: dispute.userId,
        summary: `Dispute ${dispute.ticketNumber}: ${dispute.reason}`,
        source: 'disputes',
        createdAt: dispute.createdAt,
        metadata: { disputeId: dispute.id, transactionId: dispute.transactionId },
      });
    }
  }

  for (const user of db.users || []) {
    if ((user.failedLoginAttempts || 0) >= 5) {
      signals.push({
        id: `login-${user.id}`,
        type: 'failed_logins',
        severity: 'medium',
        userId: user.id,
        summary: `${user.failedLoginAttempts} failed login attempts`,
        source: 'user_risk',
        createdAt: user.lastFailedLoginAt || Date.now(),
        metadata: { failedLoginAttempts: user.failedLoginAttempts },
      });
    }
    if (user.accountStatus === 'suspended' || user.accountStatus === 'locked') {
      signals.push({
        id: `account-${user.id}`,
        type: 'account_restricted',
        severity: 'high',
        userId: user.id,
        summary: `Account ${user.accountStatus}`,
        source: 'user_risk',
        createdAt: Date.now(),
        metadata: { accountStatus: user.accountStatus },
      });
    }
  }

  signals.sort((a, b) => b.createdAt - a.createdAt);
  return signals;
}

router.get('/', adminAuth, requirePermission('fraud:read'), (req, res) => {
  const db = loadAppState();
  let signals = buildFraudSignals(db);

  if (req.query.type) signals = signals.filter((s) => s.type === req.query.type);
  if (req.query.userId) signals = signals.filter((s) => s.userId === req.query.userId);
  if (req.query.severity) signals = signals.filter((s) => s.severity === req.query.severity);

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const data = signals.slice(0, limit);

  logAdminAction(req, 'FRAUD_SIGNALS_LIST', { count: data.length });
  res.json({ signals: data, count: data.length, total: signals.length });
});

router.get('/user/:userId', adminAuth, requirePermission('fraud:read'), (req, res) => {
  const db = loadAppState();
  const user = (db.users || []).find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const signals = buildFraudSignals(db).filter((s) => s.userId === req.params.userId);
  const fraudLogs = (db.auditLog || []).filter(
    (entry) => entry.userId === req.params.userId && /fraud|aml|suspicious/i.test(entry.action || entry.type || ''),
  );

  logAdminAction(req, 'FRAUD_USER_INVESTIGATION', { userId: req.params.userId });
  res.json({
    userId: req.params.userId,
    email: user.email,
    accountStatus: user.accountStatus || 'active',
    kycStatus: user.kycStatus || 'pending',
    signals,
    auditEntries: fraudLogs.slice(0, 20),
  });
});

module.exports = router;
