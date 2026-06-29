'use strict';

const express = require('express');
const { adminAuth, requirePermission, adminCsrf } = require('./adminAuth');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

const VALID_STATUSES = ['open', 'investigating', 'resolved', 'closed'];

function sanitizeDispute(dispute, db) {
  const user = (db.users || []).find((u) => u.id === dispute.userId);
  const tx = (db.transactions || []).find((t) => t.id === dispute.transactionId);
  return {
    id: dispute.id,
    ticketNumber: dispute.ticketNumber,
    userId: dispute.userId,
    userEmail: dispute.userEmail || user?.email || null,
    transactionId: dispute.transactionId,
    transactionStatus: tx?.status || null,
    transactionAmount: tx?.amount ?? null,
    transactionCurrency: tx?.currency || null,
    reason: dispute.reason,
    description: dispute.description,
    status: dispute.status || 'open',
    resolution: dispute.resolution || null,
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
    resolvedBy: dispute.resolvedBy || null,
  };
}

router.get('/', adminAuth, requirePermission('disputes:read'), (req, res) => {
  const db = loadAppState();
  let disputes = [...(db.disputes || [])];

  if (req.query.status) disputes = disputes.filter((d) => d.status === req.query.status);
  if (req.query.userId) disputes = disputes.filter((d) => d.userId === req.query.userId);

  disputes.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalItems = disputes.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const start = (page - 1) * limit;
  const data = disputes.slice(start, start + limit).map((d) => sanitizeDispute(d, db));

  logAdminAction(req, 'DISPUTES_LIST', { count: data.length });
  res.json({ disputes: data, page, totalPages, totalItems, count: data.length });
});

router.get('/:id', adminAuth, requirePermission('disputes:read'), (req, res) => {
  const db = loadAppState();
  const dispute = (db.disputes || []).find((d) => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

  logAdminAction(req, 'DISPUTE_VIEW', { disputeId: dispute.id, userId: dispute.userId });
  res.json({ dispute: sanitizeDispute(dispute, db) });
});

router.patch('/:id', adminAuth, adminCsrf, requirePermission('disputes:write'), (req, res) => {
  const db = loadAppState();
  const dispute = (db.disputes || []).find((d) => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

  const { status, resolution } = req.body || {};
  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    dispute.status = status;
    if (status === 'resolved' || status === 'closed') {
      dispute.resolvedBy = req.admin.email;
      dispute.resolvedAt = Date.now();
    }
  }
  if (resolution !== undefined) dispute.resolution = String(resolution).trim() || null;
  dispute.updatedAt = Date.now();
  saveAppState(db);

  logAdminAction(req, 'DISPUTE_UPDATE', {
    disputeId: dispute.id,
    status: dispute.status,
    userId: dispute.userId,
  });
  res.json({ success: true, dispute: sanitizeDispute(dispute, db) });
});

module.exports = router;
