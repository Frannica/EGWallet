'use strict';

const express = require('express');
const { adminAuth } = require('./adminWithdrawals');
const { loadAppState } = require('./db/appStateStore');
const { listKycDocuments, toPublicDocument } = require('./db/kycUploadPostgres');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

function sanitizeWithdrawal(w) {
  if (!w) return w;
  return {
    id: w.id,
    userId: w.userId,
    walletId: w.walletId,
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    method: w.method,
    country: w.country,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    accountMask: w.accountMask || null,
    bankNameDisplay: w.bankNameDisplay || null,
  };
}

function sanitizeUserSummary(user, db) {
  const wallets = (db.wallets || []).filter((w) => w.userId === user.id);
  return {
    id: user.id,
    email: user.email,
    username: user.username || null,
    fullName: user.fullName || null,
    kycStatus: user.kycStatus || 'pending',
    kycTier: user.kycTier ?? 0,
    createdAt: user.createdAt || null,
    walletIds: wallets.map((w) => w.id),
  };
}

function matchesSearch(user, db, query) {
  const q = query.toLowerCase();
  if (user.id === query) return true;
  if (user.email?.toLowerCase().includes(q)) return true;
  if (user.username?.toLowerCase().includes(q)) return true;
  const wallets = (db.wallets || []).filter((w) => w.userId === user.id);
  return wallets.some((w) => w.id === query || w.id.toLowerCase().includes(q));
}

function buildRiskFlags(user, db) {
  const flags = [];
  if (user.kycDeviceBlocked) flags.push({ type: 'kyc_device_blocked', severity: 'high' });
  if (user.kycStatus === 'rejected') flags.push({ type: 'kyc_rejected', severity: 'medium' });
  const fraudLogs = (db.auditLog || []).filter(
    (entry) => entry.userId === user.id && /fraud|aml|suspicious/i.test(entry.action || entry.type || ''),
  );
  if (fraudLogs.length > 0) {
    flags.push({ type: 'fraud_reports', severity: 'high', count: fraudLogs.length });
  }
  return flags;
}

router.get('/', adminAuth, async (req, res) => {
  try {
    const db = loadAppState();
    const q = (req.query.q || req.query.search || '').trim();
    let users = db.users || [];

    if (q) {
      users = users.filter((user) => matchesSearch(user, db, q));
    } else {
      users = users.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
    }

    const data = users.map((user) => sanitizeUserSummary(user, db));
    logAdminAction(req, 'USERS_LIST', { query: q || null, count: data.length });
    res.json({ users: data, count: data.length });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/:id', adminAuth, async (req, res) => {
  try {
    const db = loadAppState();
    const user = (db.users || []).find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const wallets = (db.wallets || [])
      .filter((w) => w.userId === user.id)
      .map((w) => ({
        id: w.id,
        currency: w.currency,
        balances: (w.balances || []).map((b) => ({ currency: b.currency, amount: b.amount })),
        holdBalance: w.holdBalance || {},
      }));

    const walletIds = new Set(wallets.map((w) => w.id));
    const transactions = (db.transactions || [])
      .filter((tx) => walletIds.has(tx.fromWalletId) || walletIds.has(tx.toWalletId))
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100)
      .map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        fromWalletId: tx.fromWalletId,
        toWalletId: tx.toWalletId,
        memo: tx.memo || null,
        createdAt: tx.createdAt,
      }));

    const paymentRequests = (db.paymentRequests || [])
      .filter((pr) => pr.requesterId === user.id || pr.userId === user.id || walletIds.has(pr.walletId))
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 50)
      .map((pr) => ({
        id: pr.id,
        walletId: pr.walletId,
        amount: pr.amount,
        currency: pr.currency,
        status: pr.status,
        memo: pr.memo || null,
        createdAt: pr.createdAt,
      }));

    const withdrawals = (db.withdrawals || [])
      .filter((w) => w.userId === user.id)
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 50)
      .map(sanitizeWithdrawal);

    let kycDocuments = [];
    try {
      const docs = await listKycDocuments({ userId: user.id });
      kycDocuments = docs.map(toPublicDocument);
    } catch (_error) {
      kycDocuments = [];
    }

    const profile = {
      id: user.id,
      email: user.email,
      username: user.username || null,
      fullName: user.fullName || null,
      region: user.region || null,
      role: user.role || 'individual',
      kycStatus: user.kycStatus || 'pending',
      kycTier: user.kycTier ?? 0,
      kycUpdatedAt: user.kycUpdatedAt || null,
      createdAt: user.createdAt || null,
    };

    logAdminAction(req, 'USER_DETAIL_VIEW', { userId: user.id });

    res.json({
      profile,
      wallets,
      transactions,
      paymentRequests,
      withdrawals,
      kycDocuments,
      riskFlags: buildRiskFlags(user, db),
      readOnly: true,
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load user detail' });
  }
});

module.exports = router;
