'use strict';

const express = require('express');
const { adminAuth, requirePermission, getAdminActor, adminCsrf } = require('./adminAuth');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const {
  listKycDocuments,
  getKycDocumentById,
  readKycDocumentContent,
  toPublicDocument,
  updateKycDocumentReview,
  updateUserKycFields,
} = require('./db/kycUploadPostgres');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

function syncUserKycInAppState(userId, { kycStatus, kycTier }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const db = loadAppState();
    const user = (db.users || []).find((u) => u.id === userId);
    if (!user) return null;

    user.kycStatus = kycStatus;
    user.kycTier = kycTier;
    user.kycUpdatedAt = Date.now();

    if (!db.kyc) db.kyc = [];
    let kycEntry = db.kyc.find((k) => k.userId === userId);
    if (!kycEntry) {
      kycEntry = { userId, status: kycStatus, documents: [] };
      db.kyc.push(kycEntry);
    } else {
      kycEntry.status = kycStatus;
      if (Array.isArray(kycEntry.documents)) {
        kycEntry.documents = kycEntry.documents.map((doc) => ({
          ...doc,
          status: kycStatus,
          reviewedAt: Date.now(),
        }));
      }
    }

    try {
      saveAppState(db);
      return user;
    } catch (error) {
      if (!String(error.message).includes('DB_VERSION_CONFLICT') || attempt === 2) throw error;
    }
  }
  return null;
}

router.get('/pending', adminAuth, requirePermission('kyc:read'), async (req, res) => {
  try {
    const pendingStatuses = ['under_review', 'pending', 'pending_verification'];
    const documents = await listKycDocuments({ status: req.query.status || undefined });
    const pending = documents
      .filter((doc) => pendingStatuses.includes(doc.status))
      .map(toPublicDocument);
    logAdminAction(req, 'KYC_PENDING_LIST', { count: pending.length });
    res.json({ documents: pending, count: pending.length });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to list pending KYC submissions' });
  }
});

router.get('/documents', adminAuth, requirePermission('kyc:read'), async (req, res) => {
  try {
    const documents = await listKycDocuments({
      userId: req.query.userId || undefined,
      status: req.query.status || undefined,
    });
    logAdminAction(req, 'KYC_DOCUMENTS_LIST', {
      userId: req.query.userId || null,
      status: req.query.status || null,
      count: documents.length,
    });
    res.json({ documents: documents.map(toPublicDocument) });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to list KYC documents' });
  }
});

router.get('/documents/:id/download', adminAuth, requirePermission('kyc:download'), async (req, res) => {
  try {
    const payload = await readKycDocumentContent(req.params.id);
    if (!payload) return res.status(404).json({ error: 'Document not found' });
    logAdminAction(req, 'KYC_DOCUMENT_DOWNLOAD', {
      documentId: req.params.id,
      userId: payload.document.userId,
    });
    res.set('Content-Type', payload.document.mimeType);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="kyc-${payload.document.id}"`);
    res.send(payload.buffer);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to download KYC document' });
  }
});

router.get('/documents/:id/content', adminAuth, requirePermission('kyc:read'), async (req, res) => {
  try {
    const payload = await readKycDocumentContent(req.params.id);
    if (!payload) return res.status(404).json({ error: 'Document not found' });
    logAdminAction(req, 'KYC_DOCUMENT_VIEW', { documentId: req.params.id, userId: payload.document.userId });
    res.set('Content-Type', payload.document.mimeType);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `inline; filename="${payload.document.id}"`);
    res.send(payload.buffer);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to read KYC document' });
  }
});

router.get('/documents/:id', adminAuth, requirePermission('kyc:read'), async (req, res) => {
  try {
    const document = await getKycDocumentById(req.params.id);
    if (!document) return res.status(404).json({ error: 'Document not found' });
    logAdminAction(req, 'KYC_DOCUMENT_META', { documentId: req.params.id });
    res.json({ document: toPublicDocument(document) });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch KYC document' });
  }
});

router.post('/documents/:id/approve', adminAuth, adminCsrf, requirePermission('kyc:approve'), async (req, res) => {
  try {
    const document = await getKycDocumentById(req.params.id);
    if (!document) return res.status(404).json({ error: 'Document not found' });

    const kycTier = Number.isInteger(req.body?.kycTier) ? req.body.kycTier : 1;
    if (kycTier < 0 || kycTier > 3) {
      return res.status(400).json({ error: 'kycTier must be between 0 and 3' });
    }

    const reviewedBy = getAdminActor(req);
    const updatedDoc = await updateKycDocumentReview(document.id, {
      status: 'approved',
      reviewedBy,
      rejectionReason: null,
    });

    try {
      await updateUserKycFields(document.userId, { kycStatus: 'approved', kycTier });
    } catch (_pgError) {
      // App-state sync remains authoritative for dashboard reads.
    }

    const user = syncUserKycInAppState(document.userId, { kycStatus: 'approved', kycTier });
    if (!user) return res.status(404).json({ error: 'User not found' });

    logAdminAction(req, 'KYC_APPROVED', {
      documentId: document.id,
      userId: document.userId,
      kycTier,
      reviewedBy,
    });

    res.json({
      success: true,
      document: toPublicDocument(updatedDoc),
      user: {
        id: user.id,
        kycStatus: user.kycStatus,
        kycTier: user.kycTier,
        approvedBy: reviewedBy,
        approvedAt: updatedDoc.reviewedAt,
      },
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to approve KYC document' });
  }
});

router.post('/documents/:id/reject', adminAuth, adminCsrf, requirePermission('kyc:approve'), async (req, res) => {
  try {
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });

    const document = await getKycDocumentById(req.params.id);
    if (!document) return res.status(404).json({ error: 'Document not found' });

    const kycTier = Number.isInteger(req.body?.kycTier) ? req.body.kycTier : 0;
    const reviewedBy = getAdminActor(req);
    const updatedDoc = await updateKycDocumentReview(document.id, {
      status: 'rejected',
      reviewedBy,
      rejectionReason: reason,
    });

    try {
      await updateUserKycFields(document.userId, { kycStatus: 'rejected', kycTier });
    } catch (_pgError) {
      // App-state sync remains authoritative for dashboard reads.
    }

    const user = syncUserKycInAppState(document.userId, { kycStatus: 'rejected', kycTier });
    if (!user) return res.status(404).json({ error: 'User not found' });

    logAdminAction(req, 'KYC_REJECTED', {
      documentId: document.id,
      userId: document.userId,
      reason,
      reviewedBy,
    });

    res.json({
      success: true,
      document: toPublicDocument(updatedDoc),
      user: {
        id: user.id,
        kycStatus: user.kycStatus,
        kycTier: user.kycTier,
        rejectedBy: reviewedBy,
        rejectedAt: updatedDoc.reviewedAt,
        rejectionReason: reason,
      },
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to reject KYC document' });
  }
});

module.exports = router;
