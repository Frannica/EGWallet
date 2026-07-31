'use strict';

const express = require('express');
const { adminAuth, requirePermission, adminCsrf } = require('./adminAuth');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const { listKycDocuments, toPublicDocument } = require('./db/kycUploadPostgres');
const { listAdminUserNotes, insertAdminUserNote } = require('./db/adminPlatformPostgres');
const { logAdminAction, auditChange, getAdminAuditLogs } = require('./adminAudit');
const {
  ACTIVITY_CATEGORIES,
  buildLimitSummary,
  buildActivityCounts,
  getUserActivity,
  getUserWalletIds,
  userTransactions,
  userPaymentRequests,
  userWithdrawals,
  userVirtualCards,
  userQrCodes,
  mapTransaction,
  sanitizeVirtualCard,
  sanitizeQrCode,
  paginate,
} = require('./adminUserHelpers');

const router = express.Router();

const MAX_LOGIN_HISTORY = 50;

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
    accountStatus: user.accountStatus || 'active',
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
  if (user.accountStatus === 'suspended') flags.push({ type: 'account_suspended', severity: 'high' });
  if (user.accountStatus === 'locked') flags.push({ type: 'account_locked', severity: 'high' });
  if (user.kycDeviceBlocked) flags.push({ type: 'kyc_device_blocked', severity: 'high' });
  if (user.kycStatus === 'rejected') flags.push({ type: 'kyc_rejected', severity: 'medium' });
  if ((user.failedLoginAttempts || 0) >= 3) {
    flags.push({ type: 'failed_logins', severity: 'medium', count: user.failedLoginAttempts });
  }
  const fraudLogs = (db.auditLog || []).filter(
    (entry) => entry.userId === user.id && /fraud|aml|suspicious/i.test(entry.action || entry.type || ''),
  );
  if (fraudLogs.length > 0) {
    flags.push({ type: 'fraud_reports', severity: 'high', count: fraudLogs.length });
  }
  return flags;
}

function findUserOr404(req, res) {
  const db = loadAppState();
  const user = (db.users || []).find((u) => u.id === req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return { db, user };
}

function appendLoginHistory(user, entry) {
  if (!user.loginHistory) user.loginHistory = [];
  user.loginHistory.unshift(entry);
  if (user.loginHistory.length > MAX_LOGIN_HISTORY) {
    user.loginHistory = user.loginHistory.slice(0, MAX_LOGIN_HISTORY);
  }
}

router.post('/:id/impersonate', adminAuth, (_req, res) => {
  res.status(403).json({
    error: 'Impersonation is disabled',
    message: 'Admin login-as-user is never permitted for security and compliance.',
  });
});

router.get('/:id/export', adminAuth, requirePermission('users:export'), (req, res) => {
  try {
    const found = findUserOr404(req, res);
    if (!found) return;
    const { db, user } = found;
    const wallets = (db.wallets || []).filter((w) => w.userId === user.id);
    const rows = [
      ['field', 'value'],
      ['id', user.id],
      ['email', user.email],
      ['username', user.username || ''],
      ['fullName', user.fullName || ''],
      ['kycStatus', user.kycStatus || 'pending'],
      ['kycTier', user.kycTier ?? 0],
      ['accountStatus', user.accountStatus || 'active'],
      ['createdAt', user.createdAt || ''],
      ['walletIds', wallets.map((w) => w.id).join(';')],
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    logAdminAction(req, 'USER_EXPORT', { userId: user.id, format: 'csv' });
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="user-${user.id.slice(0, 8)}.csv"`);
    res.send(csv);
  } catch (_error) {
    res.status(500).json({ error: 'Export failed' });
  }
});

router.get('/search', adminAuth, requirePermission('search:read'), (req, res) => {
  try {
    const db = loadAppState();
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }
    const users = (db.users || []).filter((user) => matchesSearch(user, db, q)).slice(0, 20);
    logAdminAction(req, 'USER_SEARCH', { query: q, count: users.length });
    res.json({ users: users.map((u) => sanitizeUserSummary(u, db)) });
  } catch (_error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

router.get('/', adminAuth, requirePermission('users:read'), async (req, res) => {
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

router.get('/:id/timeline', adminAuth, requirePermission('timeline:read'), async (req, res) => {
  try {
    const found = findUserOr404(req, res);
    if (!found) return;
    const { db, user } = found;
    const walletIds = new Set((db.wallets || []).filter((w) => w.userId === user.id).map((w) => w.id));
    const events = [];

    (user.loginHistory || []).forEach((entry) => {
      events.push({
        type: 'login',
        timestamp: entry.timestamp,
        summary: entry.success ? 'Successful login' : 'Failed login',
        details: { ip: entry.ip, success: entry.success },
      });
    });

    (db.transactions || [])
      .filter((tx) => walletIds.has(tx.fromWalletId) || walletIds.has(tx.toWalletId))
      .forEach((tx) => {
        const isDeposit = tx.type === 'deposit' || (!tx.fromWalletId && tx.toWalletId);
        const isTransfer = tx.type === 'transfer' || tx.type === 'p2p' || (tx.fromWalletId && tx.toWalletId);
        events.push({
          type: isDeposit ? 'deposit' : isTransfer ? 'transfer' : 'transaction',
          timestamp: tx.createdAt || tx.timestamp,
          summary: `${tx.type || 'transaction'} ${tx.amount} ${tx.currency}`,
          details: { id: tx.id, status: tx.status },
        });
      });

    (db.withdrawals || [])
      .filter((w) => w.userId === user.id)
      .forEach((w) => {
        events.push({
          type: 'withdrawal',
          timestamp: w.createdAt,
          summary: `Withdrawal ${w.amount} ${w.currency} — ${w.status}`,
          details: { id: w.id, status: w.status },
        });
      });

    (db.paymentRequests || [])
      .filter((pr) => pr.requesterId === user.id || pr.userId === user.id || walletIds.has(pr.walletId))
      .forEach((pr) => {
        events.push({
          type: 'payment_request',
          timestamp: pr.createdAt,
          summary: `Payment request ${pr.amount} ${pr.currency} — ${pr.status}`,
          details: { id: pr.id, status: pr.status },
        });
      });

    let kycDocuments = [];
    try {
      kycDocuments = await listKycDocuments({ userId: user.id });
    } catch (_error) {
      kycDocuments = [];
    }
    kycDocuments.forEach((doc) => {
      events.push({
        type: 'kyc',
        timestamp: doc.uploadedAt,
        summary: `KYC ${doc.documentType} — ${doc.status}`,
        details: {
          id: doc.id,
          status: doc.status,
          reviewedBy: doc.reviewedBy,
          rejectionReason: doc.rejectionReason,
        },
      });
    });

    getAdminAuditLogs({ limit: 500 })
      .filter((entry) => entry.details?.userId === user.id)
      .forEach((entry) => {
        events.push({
          type: 'admin_action',
          timestamp: entry.timestamp,
          summary: entry.action,
          details: { adminId: entry.adminId, ...entry.details },
        });
      });

    events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    logAdminAction(req, 'USER_TIMELINE_VIEW', { userId: user.id, eventCount: events.length });
    res.json({ userId: user.id, events, count: events.length });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

router.get('/:id/notes', adminAuth, requirePermission('notes:read'), async (req, res) => {
  try {
    const found = findUserOr404(req, res);
    if (!found) return;
    const notes = await listAdminUserNotes(found.user.id);
    res.json({ notes, count: notes.length });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

router.post('/:id/notes', adminAuth, adminCsrf, requirePermission('notes:write'), async (req, res) => {
  try {
    const found = findUserOr404(req, res);
    if (!found) return;
    const note = (req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'note is required' });

    const saved = await insertAdminUserNote({
      userId: found.user.id,
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      note,
    });
    logAdminAction(req, 'USER_NOTE_ADD', { userId: found.user.id, noteId: saved.id });
    res.status(201).json({ note: saved });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to save note' });
  }
});

function accountAction(action, status) {
  return (req, res) => {
    const found = findUserOr404(req, res);
    if (!found) return;
    const { db, user } = found;
    const before = { accountStatus: user.accountStatus || 'active' };
    user.accountStatus = status;
    user.accountStatusUpdatedAt = Date.now();
    user.accountStatusUpdatedBy = req.admin.email;
    saveAppState(db);
    auditChange(req, action, {
      userId: user.id,
      before,
      after: { accountStatus: user.accountStatus },
    });
    res.json({ success: true, userId: user.id, accountStatus: user.accountStatus });
  };
}

// Status transitions: admin JWT + users:write (CSRF not required — same pattern as
// /admin/ledger/heal-balances — so compliance ops/scripts can act with a short-lived token).
router.post('/:id/suspend', adminAuth, requirePermission('users:write'), accountAction('USER_SUSPEND', 'suspended'));
router.post('/:id/unsuspend', adminAuth, requirePermission('users:write'), accountAction('USER_UNSUSPEND', 'active'));
router.post('/:id/lock', adminAuth, requirePermission('users:write'), accountAction('USER_LOCK', 'locked'));
router.post('/:id/unlock', adminAuth, requirePermission('users:write'), accountAction('USER_UNLOCK', 'active'));
router.post('/:id/freeze', adminAuth, requirePermission('users:write'), accountAction('USER_FREEZE', 'frozen'));
router.post('/:id/unfreeze', adminAuth, requirePermission('users:write'), accountAction('USER_UNFREEZE', 'active'));

const HOLD_FLAGS = ['fraudHold', 'amlHold', 'sanctionsHold', 'courtOrderHold', 'complianceHold', 'legalHold'];

/** Set/clear compliance holds on a user (JSON app_state). CSRF-exempt like heal-balances for ops scripts. */
router.post('/:id/holds', adminAuth, requirePermission('users:write'), (req, res) => {
  const found = findUserOr404(req, res);
  if (!found) return;
  const { db, user } = found;
  const body = req.body || {};
  const before = {};
  const after = {};
  for (const flag of HOLD_FLAGS) {
    if (Object.prototype.hasOwnProperty.call(body, flag)) {
      before[flag] = user[flag] === true;
      const next = body[flag] === true;
      if (next) user[flag] = true;
      else delete user[flag];
      after[flag] = next;
    }
  }
  if (Object.keys(after).length === 0) {
    return res.status(400).json({ error: `Provide at least one of: ${HOLD_FLAGS.join(', ')}` });
  }
  user.holdsUpdatedAt = Date.now();
  user.holdsUpdatedBy = req.admin.email;
  saveAppState(db);
  auditChange(req, 'USER_HOLDS_UPDATE', { userId: user.id, before, after });
  res.json({
    success: true,
    userId: user.id,
    holds: HOLD_FLAGS.reduce((acc, f) => {
      acc[f] = user[f] === true;
      return acc;
    }, {}),
  });
});

router.post('/:id/reset-failed-logins', adminAuth, adminCsrf, requirePermission('users:write'), (req, res) => {
  const found = findUserOr404(req, res);
  if (!found) return;
  const { db, user } = found;
  const before = {
    failedLoginAttempts: user.failedLoginAttempts || 0,
    accountStatus: user.accountStatus || 'active',
  };
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  if (user.accountStatus === 'locked') user.accountStatus = 'active';
  saveAppState(db);
  auditChange(req, 'USER_RESET_FAILED_LOGINS', {
    userId: user.id,
    before,
    after: { failedLoginAttempts: 0, accountStatus: user.accountStatus },
  });
  res.json({ success: true, userId: user.id, failedLoginAttempts: 0 });
});

router.get('/:id/activity', adminAuth, requirePermission('users:read'), (req, res) => {
  try {
    const found = findUserOr404(req, res);
    if (!found) return;
    const { db, user } = found;
    const category = (req.query.category || '').trim();
    if (!ACTIVITY_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'Invalid category',
        validCategories: ACTIVITY_CATEGORIES,
      });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const result = getUserActivity(db, user, category, page, limit);
    if (!result) return res.status(400).json({ error: 'Unknown category' });
    logAdminAction(req, 'USER_ACTIVITY_VIEW', { userId: user.id, category, page, totalItems: result.totalItems });
    res.json({ userId: user.id, ...result });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.get('/:id', adminAuth, requirePermission('users:read'), async (req, res) => {
  try {
    const found = findUserOr404(req, res);
    if (!found) return;
    const { db, user } = found;

    const wallets = (db.wallets || [])
      .filter((w) => w.userId === user.id)
      .map((w) => ({
        id: w.id,
        currency: w.currency,
        balances: (w.balances || []).map((b) => ({ currency: b.currency, amount: b.amount })),
        holdBalance: w.holdBalance || {},
      }));

    const walletIds = getUserWalletIds(db, user.id);
    const transactions = userTransactions(db, walletIds)
      .slice(0, 20)
      .map(mapTransaction);

    const paymentRequests = userPaymentRequests(db, user.id, walletIds)
      .slice(0, 20)
      .map((pr) => ({
        id: pr.id,
        walletId: pr.walletId,
        amount: pr.amount,
        currency: pr.currency,
        status: pr.status,
        memo: pr.memo || null,
        createdAt: pr.createdAt,
      }));

    const withdrawals = userWithdrawals(db, user.id)
      .slice(0, 20)
      .map(sanitizeWithdrawal);

    const virtualCards = userVirtualCards(db, user.id).slice(0, 10).map((c) => sanitizeVirtualCard(c, user.id));
    const qrCodes = userQrCodes(db, user.id).slice(0, 10).map(sanitizeQrCode);
    const limits = buildLimitSummary(user);
    const activityCounts = buildActivityCounts(db, user.id, walletIds);

    let kycDocuments = [];
    try {
      const docs = await listKycDocuments({ userId: user.id });
      kycDocuments = docs.map(toPublicDocument);
    } catch (_error) {
      kycDocuments = [];
    }

    let notes = [];
    try {
      notes = await listAdminUserNotes(user.id, { limit: 20 });
    } catch (_error) {
      notes = [];
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
      accountStatus: user.accountStatus || 'active',
      failedLoginAttempts: user.failedLoginAttempts || 0,
      lockedUntil: user.lockedUntil || null,
      createdAt: user.createdAt || null,
    };

    logAdminAction(req, 'USER_DETAIL_VIEW', { userId: user.id });

    res.json({
      profile,
      wallets,
      transactions,
      paymentRequests,
      withdrawals,
      virtualCards,
      qrCodes,
      limits,
      activityCounts,
      kycDocuments,
      notes,
      riskFlags: buildRiskFlags(user, db),
      readOnly: true,
      syncHint: 'Admin and mobile share the same database. Refresh this page after Admin actions; the Android app updates on its next API refresh (no push sync).',
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load user detail' });
  }
});

module.exports = router;
module.exports.appendLoginHistory = appendLoginHistory;
