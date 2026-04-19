'use strict';
/**
 * adminWithdrawals.js
 * Express router mounted at /admin/withdrawals in index.js.
 * All routes require Authorization: Bearer <token>.
 * Tokens are issued by POST /admin/login and expire after TOKEN_TTL_MS.
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { adminTransition } = require('./withdrawalEngine');

// ─── Token store ──────────────────────────────────────────────────────────────
// Map<token, expiresAt (ms)>
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const activeTokens = new Map();

function issueToken() {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  activeTokens.set(token, expiresAt);
  return { token, expiresAt };
}

function validateToken(token) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

// ─── Admin authentication middleware ─────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!validateToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── GET /admin/withdrawals ───────────────────────────────────────────────────
// Optional query: ?status=pending_review&currency=XAF&userId=xxx
router.get('/', adminAuth, (req, res) => {
  const db = req.app.locals.loadDB();
  let list = db.withdrawals || [];

  if (req.query.status)   list = list.filter(w => w.status   === req.query.status);
  if (req.query.currency) list = list.filter(w => w.currency === req.query.currency);
  if (req.query.userId)   list = list.filter(w => w.userId   === req.query.userId);

  // Newest first
  list = list.slice().sort((a, b) => b.createdAt - a.createdAt);

  // Pagination
  const totalItems = list.length;
  const limit      = Math.max(1, parseInt(req.query.limit, 10)  || 20);
  const page       = Math.max(1, parseInt(req.query.page,  10)  || 1);
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const safePage   = Math.min(page, totalPages);
  const start      = (safePage - 1) * limit;
  const data       = list.slice(start, start + limit);

  res.json({ data, page: safePage, totalPages, totalItems, count: data.length, withdrawals: data });
});

// ─── GET /admin/withdrawals/:id ───────────────────────────────────────────────
// Returns withdrawal + its ledger entries
router.get('/:id', adminAuth, (req, res) => {
  const db = req.app.locals.loadDB();
  const w = (db.withdrawals || []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });

  const ledger = (db.ledger || []).filter(l => l.withdrawalId === w.id);
  res.json({ withdrawal: w, ledger });
});

// ─── POST /admin/withdrawals/:id/transition ───────────────────────────────────
// body: { status: string, note?: string }
// Moves the withdrawal through the state machine.
router.post('/:id/transition', adminAuth, (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: '"status" is required' });

  const adminId = req.headers['x-admin-id'] || 'unknown-admin';
  const db = req.app.locals.loadDB();

  let updated;
  try {
    updated = adminTransition(db, req.params.id, status, adminId, note || null);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  req.app.locals.saveDB(db);

  req.app.locals.logger.info('Admin withdrawal transition', {
    withdrawalId: req.params.id,
    newStatus:    status,
    adminId,
    note:         note || null,
  });

  res.json({ withdrawal: updated });
});

// ─── Login handler — exported so index.js can mount it at POST /admin/login ──
function adminLoginHandler(req, res) {
  const { secret } = req.body || {};
  if (!secret || !process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'Invalid credentials' });
  let match = false;
  try {
    match = crypto.timingSafeEqual(
      Buffer.from(secret),
      Buffer.from(process.env.ADMIN_SECRET)
    );
  } catch (_) {} // Different lengths — not equal
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  const { token, expiresAt } = issueToken();
  res.json({ token, expiresAt });
}

module.exports = { router, adminLoginHandler };
