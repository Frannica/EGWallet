'use strict';

const express = require('express');
const { adminAuth, requirePermission } = require('./adminAuth');
const { loadAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

router.get('/', adminAuth, requirePermission('stats:read'), (req, res) => {
  try {
    const db = loadAppState();
    const todayStart = startOfTodayMs();
    const users = db.users || [];
    const withdrawals = db.withdrawals || [];
    const transactions = db.transactions || [];

    const pendingKyc = users.filter((u) => ['pending', 'under_review', 'pending_verification'].includes(u.kycStatus)).length;
    const verifiedUsers = users.filter((u) => u.kycStatus === 'approved').length;
    const pendingWithdrawals = withdrawals.filter((w) =>
      ['pending', 'pending_review', 'processing', 'submitted'].includes(w.status),
    ).length;
    const transactionsToday = transactions.filter((tx) => (tx.createdAt || tx.timestamp || 0) >= todayStart).length;
    const newUsersToday = users.filter((u) => (u.createdAt || 0) >= todayStart).length;

    const stats = {
      totalUsers: users.length,
      pendingKyc,
      verifiedUsers,
      pendingWithdrawals,
      transactionsToday,
      newUsersToday,
      generatedAt: Date.now(),
    };

    logAdminAction(req, 'STATS_VIEW', stats);
    res.json(stats);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

module.exports = router;
