'use strict';

const express = require('express');
const { adminAuth, requirePermission } = require('./adminAuth');
const { loadAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

function normalizeQuery(q) {
  return (q || '').trim().toLowerCase();
}

function userPhones(user) {
  return [user.phone, user.phoneNumber, user.mobile].filter(Boolean).map(String);
}

function searchUsers(db, query) {
  const q = normalizeQuery(query);
  if (q.length < 2) return [];

  const results = [];
  const walletByUser = new Map();

  for (const wallet of db.wallets || []) {
    if (!walletByUser.has(wallet.userId)) walletByUser.set(wallet.userId, []);
    walletByUser.get(wallet.userId).push(wallet);
  }

  for (const user of db.users || []) {
    const wallets = walletByUser.get(user.id) || [];
    let matchType = null;

    if (user.id === query || user.id.toLowerCase() === q) matchType = 'user_id';
    else if (user.email?.toLowerCase().includes(q)) matchType = 'email';
    else if (user.username?.toLowerCase().includes(q)) matchType = 'username';
    else if (user.fullName?.toLowerCase().includes(q)) matchType = 'name';
    else if (`${user.firstName || ''} ${user.lastName || ''}`.toLowerCase().includes(q)) matchType = 'name';
    else if (userPhones(user).some((p) => p.includes(q))) matchType = 'phone';
    else if (wallets.some((w) => w.id === query || w.id.toLowerCase().includes(q))) matchType = 'wallet_id';

    if (matchType) {
      results.push({
        type: 'user',
        matchType,
        id: user.id,
        email: user.email,
        username: user.username || null,
        fullName: user.fullName || null,
        kycStatus: user.kycStatus || 'pending',
        walletIds: wallets.map((w) => w.id),
      });
    }
  }

  for (const tx of db.transactions || []) {
    if (tx.id === query || tx.id?.toLowerCase() === q) {
      results.push({
        type: 'transaction',
        matchType: 'transaction_id',
        id: tx.id,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        userHint: tx.fromWalletId || tx.toWalletId,
      });
    }
  }

  return results.slice(0, 30);
}

router.get('/', adminAuth, requirePermission('search:read'), (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

    const db = loadAppState();
    const results = searchUsers(db, q);
    logAdminAction(req, 'GLOBAL_SEARCH', { query: q, count: results.length });
    res.json({ results, count: results.length, query: q });
  } catch (_error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = { router, searchUsers };
