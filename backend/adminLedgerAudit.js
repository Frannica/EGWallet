'use strict';

/**
 * Admin-facing JSON-cache vs. PostgreSQL-ledger reconciliation / mismatch
 * detection.
 *
 * PostgreSQL `wallet_balances` is the sole authoritative source of truth for
 * money (see backend/db/walletBalanceAlign.js). The in-memory JSON
 * `app_metadata` (`db.wallets[].balances`) is a best-effort cache that is
 * healed from Postgres after every commit, but a crash, a missed healing
 * step, or an old pre-migration wallet can still leave it stale. This router
 * gives compliance/support staff READ-ONLY visibility into any drift between
 * the two so it can be investigated — it never writes to either store.
 */

const express = require('express');
const { adminAuth, requirePermission } = require('./adminAuth');
const { loadAppState } = require('./db/appStateStore');
const { getPostMutationBalance } = require('./db/walletBalanceAlign');
const { pool } = require('./db/pool');

const router = express.Router();

/** True only when a real Postgres connection succeeds — never throws. */
async function tryQuery(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    return { error: err };
  }
}

function allWalletCurrencyPairs(db) {
  const pairs = [];
  for (const wallet of db.wallets || []) {
    for (const bal of wallet.balances || []) {
      pairs.push({ walletId: wallet.id, userId: wallet.userId, currency: bal.currency });
    }
  }
  return pairs;
}

// GET /admin/ledger/balance-check?walletId=...&currency=USD
// Compares the JSON-cached balance for one wallet/currency against the
// authoritative Postgres wallet_balances row. Read-only — takes no lock.
router.get('/balance-check', adminAuth, requirePermission('audit:read'), async (req, res) => {
  const { walletId, currency } = req.query;
  if (!walletId || !currency) {
    return res.status(400).json({ error: 'walletId and currency query params are required' });
  }
  const db = loadAppState();
  const jsonAmount = getPostMutationBalance(db, walletId, String(currency).toUpperCase());

  const result = await tryQuery(
    'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
    [walletId, String(currency).toUpperCase()]
  );
  if (result.error) {
    return res.status(503).json({
      error: 'Postgres ledger unavailable — cannot perform balance check',
      jsonAmount,
    });
  }
  const postgresAmount = result.rowCount > 0 ? Number(result.rows[0].amount) : null;
  const matched = postgresAmount !== null && postgresAmount === jsonAmount;

  res.json({
    walletId,
    currency: String(currency).toUpperCase(),
    jsonAmount,
    postgresAmount,
    matched,
    delta: postgresAmount === null ? null : jsonAmount - postgresAmount,
    note: postgresAmount === null
      ? 'No Postgres wallet_balances row exists yet for this wallet/currency (never touched by a Postgres-backed money operation).'
      : undefined,
  });
});

// GET /admin/ledger/mismatches?limit=200
// System-wide scan: every JSON wallet/currency balance vs. its Postgres row.
// Returns ONLY the mismatches (JSON present but different from Postgres),
// capped at `limit`, so this stays cheap to call from the dashboard.
router.get('/mismatches', adminAuth, requirePermission('audit:read'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const db = loadAppState();
  const pairs = allWalletCurrencyPairs(db);

  const poolCheck = await tryQuery('SELECT 1');
  if (poolCheck.error) {
    return res.status(503).json({ error: 'Postgres ledger unavailable — cannot scan for mismatches' });
  }

  const mismatches = [];
  let scanned = 0;
  for (const pair of pairs) {
    scanned += 1;
    const jsonAmount = getPostMutationBalance(db, pair.walletId, pair.currency);
    const result = await tryQuery(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
      [pair.walletId, pair.currency]
    );
    if (result.error) continue;
    if (result.rowCount === 0) continue; // never-touched-by-Postgres wallet — not a mismatch, just unmigrated
    const postgresAmount = Number(result.rows[0].amount);
    if (postgresAmount !== jsonAmount) {
      mismatches.push({
        walletId: pair.walletId,
        userId: pair.userId,
        currency: pair.currency,
        jsonAmount,
        postgresAmount,
        delta: jsonAmount - postgresAmount,
      });
      if (mismatches.length >= limit) break;
    }
  }

  res.json({
    scanned,
    totalWalletCurrencyPairs: pairs.length,
    mismatchCount: mismatches.length,
    truncated: mismatches.length >= limit,
    mismatches,
    authoritative: 'postgres',
    note: 'PostgreSQL wallet_balances is the authoritative source. Any mismatch means the JSON cache is stale — it does not indicate incorrect money movement, since all commits are enforced by Postgres row locks.',
  });
});

module.exports = router;
