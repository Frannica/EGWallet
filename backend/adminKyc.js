'use strict';

const express = require('express');
const { adminAuth } = require('./adminWithdrawals');
const {
  listKycDocuments,
  getKycDocumentById,
  readKycDocumentContent,
  toPublicDocument,
} = require('./db/kycUploadPostgres');

const router = express.Router();

router.get('/documents', adminAuth, async (req, res) => {
  try {
    const documents = await listKycDocuments({
      userId: req.query.userId || undefined,
      status: req.query.status || undefined,
    });
    res.json({ documents: documents.map(toPublicDocument) });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to list KYC documents' });
  }
});

router.get('/documents/:id/content', adminAuth, async (req, res) => {
  try {
    const payload = await readKycDocumentContent(req.params.id);
    if (!payload) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', payload.document.mimeType);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `inline; filename="${payload.document.id}"`);
    res.send(payload.buffer);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to read KYC document' });
  }
});

router.get('/documents/:id', adminAuth, async (req, res) => {
  try {
    const document = await getKycDocumentById(req.params.id);
    if (!document) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: toPublicDocument(document) });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch KYC document' });
  }
});

module.exports = router;
