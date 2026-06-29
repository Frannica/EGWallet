'use strict';

const express = require('express');
const { pool } = require('./db/pool');
const { loadAppState, isDatabaseConnected } = require('./db/appStateStore');
const { adminAuth, requirePermission } = require('./adminAuth');
const { getOnlineAdmins } = require('./adminSessions');
const { getAdminAuditLogs } = require('./adminAudit');

const router = express.Router();

async function pingDatabase() {
  if (!process.env.DATABASE_URL) return { status: 'not_configured', latencyMs: null };
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'error', latencyMs: Date.now() - start, error: error.message };
  }
}

router.get('/health', adminAuth, requirePermission('health:read'), async (req, res) => {
  const dbPing = await pingDatabase();
  const appStateOk = isDatabaseConnected();
  res.json({
    api: { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) },
    database: {
      ...dbPing,
      appState: appStateOk ? 'connected' : 'missing',
    },
    railway: {
      environment: process.env.RAILWAY_ENVIRONMENT || null,
      service: process.env.RAILWAY_SERVICE_NAME || null,
      deployment: process.env.RAILWAY_DEPLOYMENT_ID || null,
    },
    timestamp: Date.now(),
  });
});

router.get('/', adminAuth, requirePermission('stats:read'), async (req, res) => {
  try {
    const db = loadAppState();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    const users = db.users || [];
    const withdrawals = db.withdrawals || [];
    const transactions = db.transactions || [];

    const stats = {
      totalUsers: users.length,
      pendingKyc: users.filter((u) => ['pending', 'under_review', 'pending_verification'].includes(u.kycStatus)).length,
      verifiedUsers: users.filter((u) => u.kycStatus === 'approved').length,
      pendingWithdrawals: withdrawals.filter((w) =>
        ['pending', 'pending_review', 'processing', 'submitted'].includes(w.status),
      ).length,
      transactionsToday: transactions.filter((tx) => (tx.createdAt || tx.timestamp || 0) >= todayMs).length,
      newUsersToday: users.filter((u) => (u.createdAt || 0) >= todayMs).length,
    };

    const activity = getAdminAuditLogs({ limit: 25 });
    const onlineAdmins = getOnlineAdmins();
    const dbPing = await pingDatabase();

    res.json({
      stats,
      activity,
      onlineAdmins,
      health: {
        api: 'ok',
        database: dbPing.status,
        railway: process.env.RAILWAY_ENVIRONMENT || 'local',
      },
      generatedAt: Date.now(),
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load dashboard overview' });
  }
});

module.exports = router;
