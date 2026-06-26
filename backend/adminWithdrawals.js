'use strict';
/**
 * adminWithdrawals.js
 * Express router mounted at /admin/withdrawals in index.js.
 * All routes require Authorization: Bearer <token>.
 * Tokens are issued by POST /admin/login and expire after TOKEN_TTL_MS.
 */

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const router  = express.Router();
const { adminTransition, markWithdrawalPaid, markWithdrawalFailed } = require('./withdrawalEngine');
const { payoutRouter } = require('./payoutProviders');
const { commitWithdrawalTransitionPostgres } = require('./db/withdrawalsPostgres');
const USE_POSTGRES_RUNTIME = !!process.env.DATABASE_URL;

// ─── PII sanitizer ────────────────────────────────────────────────────────────
// Strip encrypted ciphertext and regulated PII from withdrawal objects before
// returning them over the API.  Mirrors sanitizeWithdrawalForResponse in index.js.
// accountMask and bankNameDisplay are the safe display copies written at creation.
function sanitizeAdmin(w) {
  if (!w) return w;
  return {
    ...w,
    accountNumber:     w.accountMask     || null,
    bankName:          w.bankNameDisplay || null,
    accountHolderName: null,
    iban:              null,
    swiftBic:          null,
  };
}

// ─── Token store ──────────────────────────────────────────────────────────────
// Map<sha256(token), expiresAt (ms)>  — raw tokens are never stored, only hashes.
// This prevents a memory-dump or debug-log from exposing live bearer tokens.
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const activeTokens = new Map();

function hashAdminToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function issueToken() {
  const raw       = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  activeTokens.set(hashAdminToken(raw), expiresAt);
  return { token: raw, expiresAt };
}

function validateToken(raw) {
  if (!raw) return false;
  const hash      = hashAdminToken(raw);
  const expiresAt = activeTokens.get(hash);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeTokens.delete(hash);
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
  const data       = list.slice(start, start + limit).map(sanitizeAdmin);

  res.json({ data, page: safePage, totalPages, totalItems, count: data.length, withdrawals: data });
});

// ─── GET /admin/withdrawals/:id ───────────────────────────────────────────────
// Returns withdrawal + its ledger entries
router.get('/:id', adminAuth, (req, res) => {
  const db = req.app.locals.loadDB();
  const w = (db.withdrawals || []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });

  const ledger = (db.ledger || []).filter(l => l.withdrawalId === w.id);
  res.json({ withdrawal: sanitizeAdmin(w), ledger });
});

// ─── POST /admin/withdrawals/:id/transition ───────────────────────────────────
// body: { status: string, note?: string }
// Moves the withdrawal through the state machine.
// C3: wrapped in withBalanceMutex — transitions to 'failed'/'reversed' issue refunds
// that credit available balance and must be serialised with all other balance writes.
router.post('/:id/transition', adminAuth, async (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: '"status" is required' });

  const adminId = req.headers['x-admin-id'] || 'unknown-admin';

  // withBalanceMutex is injected via app.locals in index.js; fall back to plain call
  // in environments where it is not yet set (tests, legacy callers).
  const withBalanceMutex = req.app.locals.withBalanceMutex || ((fn) => fn());

  // Tracks whether adminTransition actually completed — set true only on the happy
  // path inside the mutex.  The setImmediate below is gated on this flag so that a
  // failed/duplicate transition (e.g. processing→processing 409) never schedules a
  // second executePayout for a withdrawal that already has payoutDispatchRef set.
  let transitionSucceeded = false;

  await withBalanceMutex(async () => {
    const db = req.app.locals.loadDB();

    let updated;
    try {
      updated = adminTransition(db, req.params.id, status, adminId, note || null);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    if (USE_POSTGRES_RUNTIME) {
      const previousStatus = Array.isArray(updated.statusHistory) && updated.statusHistory.length > 1
        ? updated.statusHistory[updated.statusHistory.length - 2].status
        : null;
      const pgResult = await commitWithdrawalTransitionPostgres({
        stateDb: db,
        withdrawal: updated,
        expectedStatus: previousStatus || undefined,
      });
      if (pgResult.notFound) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }
      if (pgResult.conflict) {
        return res.status(409).json({ error: 'Withdrawal state changed concurrently' });
      }
    } else {
      req.app.locals.saveDB(db);
    }

    req.app.locals.logger.info('Admin withdrawal transition', {
      withdrawalId: req.params.id,
      newStatus:    status,
      adminId,
      note:         note || null,
    });

    res.json({ withdrawal: sanitizeAdmin(updated) });
    transitionSucceeded = true; // only reached on success — after saveDB and res.json
  });

  // Fire the payout engine only after a successful transition to 'processing'.
  // Guarding on transitionSucceeded prevents a duplicate admin request (or any
  // error path) from scheduling a second provider call for the same withdrawal.
  if (transitionSucceeded && status === 'processing' && req.app.locals.executePayout) {
    const { executePayout, loadDB, saveDB, logger, withBalanceMutex: wbm } = req.app.locals;
    setImmediate(() => executePayout(req.params.id, loadDB, saveDB, logger, wbm));
  }
});

// ─── POST /admin/withdrawals/:id/reconcile ────────────────────────────────────
// Queries the provider for the current status of a processing withdrawal and
// completes its lifecycle (markWithdrawalPaid or markWithdrawalFailed) inside
// withBalanceMutex.
//
// Use when:
//   - payoutReference set but not yet settled (Stripe pending/in_transit, Kora processing)
//   - payoutDispatchRef set but no payoutReference (mid-call crash / timeout)
//
// Response: { status: 'paid'|'failed'|'pending', withdrawal }
router.post('/:id/reconcile', adminAuth, async (req, res) => {
  const adminId           = req.headers['x-admin-id'] || 'unknown-admin';
  const withBalanceMutex  = req.app.locals.withBalanceMutex || ((fn) => fn());
  const { loadDB, saveDB, logger } = req.app.locals;

  const db = loadDB();
  const w  = (db.withdrawals || []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'processing') {
    return res.status(400).json({
      error: `Withdrawal is not in processing state (current: ${w.status}) — reconcile only applies to processing withdrawals`,
    });
  }

  const ref = w.payoutReference || w.payoutDispatchRef;
  if (!ref) {
    return res.status(400).json({
      error: 'No provider reference found. The payout engine has not yet contacted the provider — use the transition endpoint to retry.',
    });
  }

  // ── Query provider status ─────────────────────────────────────────────────
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
  const stripeClient      = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
  const KORA_API_KEY      = process.env.KORA_API_KEY || null;

  // Determine provider from the withdrawal record; fall back to the same routing
  // logic used by executePayout (country-based). This is always correct because
  // payoutProvider is now persisted in attemptPayout before any HTTP call.
  const provider = w.payoutProvider || payoutRouter(w.country);

  let providerStatus; // 'settled' | 'failed' | 'pending'
  let providerDetail = {};

  try {
    if (provider === 'stripe' && stripeClient) {
      let stripePayout = null;

      if (w.payoutReference) {
        // Fast path: we already have the Stripe payout ID (po_xxx) — retrieve directly.
        stripePayout = await stripeClient.payouts.retrieve(w.payoutReference);

      } else {
        // Only payoutDispatchRef exists — HTTP call was initiated but no response
        // was received.  stripePayout() always sets metadata.withdrawalId, so search
        // by that field.  Paginate up to MAX_PAGES to avoid a false-negative from a
        // single 100-item page, then treat confirmed-absent as terminal failure so
        // the refund path can run (adminTransition blocks on payoutDispatchRef, but
        // markWithdrawalFailed inside the reconcile mutex does not).
        const MAX_PAGES  = 3; // 300 payouts maximum in the time window
        const minCreated = Math.floor((w.createdAt - 3_600_000) / 1000);
        let   pageCount  = 0;
        let   hasMore    = true;
        let   afterCursor;

        while (hasMore && !stripePayout && pageCount < MAX_PAGES) {
          const listParams = { limit: 100, created: { gte: minCreated } };
          if (afterCursor) listParams.starting_after = afterCursor;
          const page = await stripeClient.payouts.list(listParams);
          stripePayout = page.data.find(p => p.metadata && p.metadata.withdrawalId === w.id) || null;
          hasMore      = page.has_more;
          if (!stripePayout && page.data.length > 0) {
            afterCursor = page.data[page.data.length - 1].id;
          }
          pageCount++;
        }

        if (!stripePayout) {
          // Exhaustive search found nothing — result is INCONCLUSIVE, not confirmed failure.
          //
          // "Not found in list" is NOT a positive terminal-failure signal from Stripe:
          //   - The payout may have been created after our minCreated window.
          //   - The payout object may not yet be indexed by Stripe's list API.
          //   - Network issues during the original dispatch may resolve asynchronously.
          //
          // Rule: no positive terminal failure from provider = no refund.
          // Leave the withdrawal in processing and require manual/provider confirmation.
          providerStatus = 'pending';
          providerDetail = {
            message: `No Stripe payout found after searching ${pageCount} page(s) — result is inconclusive. ` +
              'Do NOT treat as confirmed absent. Check the Stripe dashboard or wait for a webhook before refunding.',
            payoutDispatchRef: w.payoutDispatchRef,
            pagesSearched: pageCount,
          };
          logger.warn('[reconcile] Stripe payout not found after exhaustive list search — treating as pending (not failed)', {
            withdrawalId: w.id, pagesSearched: pageCount, payoutDispatchRef: w.payoutDispatchRef,
          });
        }
      }

      if (stripePayout) {
        // Persist the Stripe payout ID now so future reconcile calls can use the fast path.
        if (!w.payoutReference) {
          try {
            const withBalanceMutex = req.app.locals.withBalanceMutex || ((fn) => fn());
            await withBalanceMutex(async () => {
              const dbSave = req.app.locals.loadDB();
              const wSave  = (dbSave.withdrawals || []).find(x => x.id === w.id);
              if (wSave && !wSave.payoutReference) {
                wSave.payoutReference = stripePayout.id;
                wSave.payoutProvider  = 'stripe';
                if (USE_POSTGRES_RUNTIME) {
          const pgResult = await commitWithdrawalTransitionPostgres({
                    stateDb: dbSave,
                    withdrawal: wSave,
            expectedStatus: 'processing',
                  });
          if (pgResult.conflict) {
            throw Object.assign(new Error('Concurrent reconcile update conflict'), { statusCode: 409 });
          }
                } else {
                  req.app.locals.saveDB(dbSave);
                }
              }
            });
          } catch (_) { /* non-fatal — continue with status mapping */ }
        }
        providerDetail = { id: stripePayout.id, status: stripePayout.status,
          arrival_date: stripePayout.arrival_date };
        if (stripePayout.status === 'paid')                                   providerStatus = 'settled';
        else if (stripePayout.status === 'failed' || stripePayout.status === 'canceled') providerStatus = 'failed';
        else                                                                   providerStatus = 'pending';
      }

    } else if (provider === 'kora' && KORA_API_KEY) {
      // Kora disbursement status endpoint: GET /merchant/api/v1/transactions/{reference}
      // (Disbursements are created via /transactions/disburse — status lives on /transactions/,
      //  not /charges/ which is for incoming collections.)
      const koraRef = w.payoutReference || ref;
      let   koraResponse;
      try {
        koraResponse = await axios.get(
          `https://api.korapay.com/merchant/api/v1/transactions/${koraRef}`,
          { headers: { Authorization: `Bearer ${KORA_API_KEY}` }, timeout: 15_000 }
        );
      } catch (koraErr) {
        if (koraErr.response?.status === 404) {
          // Kora returned 404 — result is INCONCLUSIVE, not confirmed failure.
          //
          // A single 404 is NOT a positive terminal-failure signal from Kora:
          //   - Kora may process disbursements asynchronously after the dispatch call.
          //   - The reference may not yet be indexed if the original request timed out
          //     but was accepted by Kora's backend.
          //   - A 404 during the post-dispatch grace window could still resolve to paid.
          //
          // Rule: no positive terminal failure from provider = no refund.
          // Leave the withdrawal in processing and require manual/provider confirmation.
          providerStatus = 'pending';
          providerDetail = {
            reference: koraRef,
            message:   'Transaction not found in Kora (HTTP 404) — result is inconclusive. ' +
              'Do NOT treat as confirmed absent. Check the Kora dashboard or wait for a webhook before refunding.',
          };
          logger.warn('[reconcile] Kora transaction not found (404) — treating as pending (not failed)', {
            withdrawalId: w.id, koraRef,
          });
        } else {
          throw koraErr; // re-throw transient errors for the outer catch → 502
        }
      }
      if (koraResponse) {
        const data   = koraResponse.data?.data || {};
        const status = (data.status || '').toLowerCase();
        providerDetail = { reference: koraRef, status: data.status, amount: data.amount };
        if (['success', 'completed'].includes(status))              providerStatus = 'settled';
        else if (['failed', 'reversed', 'cancelled'].includes(status)) providerStatus = 'failed';
        else                                                            providerStatus = 'pending';
      }

    } else {
      return res.status(400).json({
        error: `Provider '${provider}' is not configured — cannot query status automatically. Configure STRIPE_SECRET_KEY or KORA_API_KEY.`,
        ref,
        provider,
      });
    }
  } catch (queryErr) {
    logger.error('[reconcile] Provider status query failed', {
      withdrawalId: w.id, provider, ref, error: queryErr.message,
    });
    return res.status(502).json({
      error: `Provider status query failed: ${queryErr.message}`,
      provider,
      ref,
    });
  }

  logger.info('[reconcile] Provider status retrieved', {
    withdrawalId: w.id, provider, providerStatus, providerDetail, adminId,
  });

  // ── Apply terminal outcome inside withBalanceMutex ────────────────────────
  if (providerStatus === 'settled') {
    let alreadyPaid = false;
    try {
      await withBalanceMutex(async () => {
        const dbR = loadDB();
        const wR  = (dbR.withdrawals || []).find(x => x.id === w.id);

        // C-1 TOCTOU guard: re-verify status inside the mutex on a fresh DB load.
        // A concurrent executePayout may have already resolved this withdrawal
        // between the provider query above and this mutex entry.
        if (!wR) throw new Error('Withdrawal not found after mutex acquisition');
        if (wR.status === 'paid') {
          // Concurrent path already completed the transition — idempotent, nothing to do.
          alreadyPaid = true;
          return;
        }
        if (wR.status !== 'processing') {
          throw Object.assign(
            new Error(`Concurrent state change: withdrawal is now '${wR.status}', cannot mark paid — re-check state`),
            { statusCode: 409 }
          );
        }

        // Use the freshest reference in priority order:
        //   1. wR.payoutReference  — already persisted on a previous reconcile or unsettled-path save
        //   2. providerDetail.id   — real Stripe po_xxx / Kora ref from the query just performed
        //   3. providerDetail.reference — Kora uses 'reference', not 'id'
        //   4. w.payoutReference   — stale snapshot (last resort)
        // Never use `ref` (payoutDispatchRef = 'egw-*') as the settled reference.
        const paidRef = wR.payoutReference
          || providerDetail.id
          || providerDetail.reference
          || w.payoutReference;
        if (!wR.payoutReference) {
          wR.payoutReference = paidRef;
          wR.payoutProvider  = provider;
        }
        markWithdrawalPaid(dbR, w.id, paidRef, provider);
        if (USE_POSTGRES_RUNTIME) {
          const pgResult = await commitWithdrawalTransitionPostgres({
            stateDb: dbR,
            withdrawal: (dbR.withdrawals || []).find((x) => x.id === w.id),
            expectedStatus: 'processing',
          });
          if (pgResult.conflict) {
            throw Object.assign(new Error('Concurrent state change conflict'), { statusCode: 409 });
          }
        } else {
          saveDB(dbR);
        }
      });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({ error: `Failed to mark paid: ${err.message}` });
    }
    logger.info('[reconcile] Marked paid', { withdrawalId: w.id, adminId, alreadyPaid });
    const dbFinal = loadDB();
    return res.json({ status: 'paid', withdrawal: sanitizeAdmin((dbFinal.withdrawals || []).find(x => x.id === w.id)) });
  }

  if (providerStatus === 'failed') {
    let alreadyResolved = false;
    let requiresRequery = false;
    try {
      await withBalanceMutex(async () => {
        const dbR = loadDB();
        const wR  = (dbR.withdrawals || []).find(x => x.id === w.id);

        // C-1 TOCTOU guard: re-verify state inside the mutex on a fresh DB load.
        if (!wR || wR.status !== 'processing') {
          // Withdrawal already resolved by a concurrent path — do not refund again.
          alreadyResolved = true;
          return;
        }
        // Refined TOCTOU guard: only block refund when payoutReference was set or
        // changed AFTER our provider query started (i.e. by a concurrent executePayout
        // in that window).
        //
        // Two distinct cases:
        //   payoutReference unchanged since route entry → our query already used that
        //     exact reference and confirmed terminal failure → refund is safe.
        //   payoutReference newly set / changed since route entry → a concurrent path
        //     may have received a settled response → status unknown → re-query.
        //
        // `w` is the snapshot from the initial loadDB() before the provider query.
        // `wR` is the fresh reload inside the mutex.
        if (wR.payoutReference && wR.payoutReference !== w.payoutReference) {
          requiresRequery = true;
          return;
        }

        // H-3: require an explicit terminal-failure status string from the provider API.
        // providerDetail.status is the raw provider status set during the query above
        // (Stripe: 'failed'|'canceled'; Kora: 'failed'|'reversed'|'cancelled').
        // If it is absent or not in the known set, the refund is blocked and a re-query
        // is required — prevents a transient or ambiguous provider response from
        // triggering an irreversible wallet credit inside the mutex.
        const TERMINAL_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'reversed']);
        if (!TERMINAL_STATUSES.has((providerDetail.status || '').toLowerCase())) {
          requiresRequery = true;
          logger.warn('[reconcile] terminal marker absent or ambiguous — refund blocked, re-query required', {
            withdrawalId: w.id, providerDetail, adminId,
          });
          return;
        }

        markWithdrawalFailed(dbR, w.id, `Reconciled by admin ${adminId}: provider status = failed`);
        if (USE_POSTGRES_RUNTIME) {
          const pgResult = await commitWithdrawalTransitionPostgres({
            stateDb: dbR,
            withdrawal: (dbR.withdrawals || []).find((x) => x.id === w.id),
            expectedStatus: 'processing',
          });
          if (pgResult.conflict) {
            throw new Error('Concurrent state change conflict');
          }
        } else {
          saveDB(dbR);
        }
      });
    } catch (err) {
      return res.status(500).json({ error: `Failed to mark failed: ${err.message}` });
    }

    if (alreadyResolved) {
      const dbFinal = loadDB();
      const wFinal  = (dbFinal.withdrawals || []).find(x => x.id === w.id);
      logger.info('[reconcile] Withdrawal already resolved — no-op', { withdrawalId: w.id, status: wFinal?.status, adminId });
      return res.json({ status: wFinal?.status || 'resolved', withdrawal: sanitizeAdmin(wFinal) });
    }
    if (requiresRequery) {
      logger.warn('[reconcile] payoutReference set by concurrent path — refund blocked, re-query required', { withdrawalId: w.id, adminId });
      return res.status(409).json({
        error: 'A provider reference was saved concurrently — the provider may have settled. Re-run POST /admin/withdrawals/' + w.id + '/reconcile to check current provider status before issuing any refund.',
        withdrawalId: w.id,
      });
    }

    logger.info('[reconcile] Marked failed and refund issued', { withdrawalId: w.id, adminId });
    const dbFinal = loadDB();
    return res.json({ status: 'failed', withdrawal: sanitizeAdmin((dbFinal.withdrawals || []).find(x => x.id === w.id)) });
  }

  // Provider still pending — return status for monitoring.
  return res.json({
    status: 'pending',
    message: 'Provider has not yet settled this payout. Check again later or wait for a webhook.',
    providerDetail,
    withdrawal: sanitizeAdmin(w),
  });
});

// ─── Logout handler — exported so index.js can mount it at POST /admin/logout ─
// Revokes the supplied bearer token by removing its hash from the in-memory store.
// Deleting a non-existent key is a safe no-op, so this is idempotent.
// No auth middleware needed — the token IS the credential being invalidated.
function adminLogoutHandler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!raw) return res.status(400).json({ error: 'No token provided' });
  activeTokens.delete(hashAdminToken(raw));
  res.json({ ok: true });
}

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

module.exports = { router, adminLoginHandler, adminLogoutHandler };
