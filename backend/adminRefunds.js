'use strict';
/**
 * adminRefunds.js
 * Express router mounted at /admin/refunds.
 *
 * Admin can inspect refunds, reconcile against Stripe, and safely retry
 * ONLY when no Stripe refund was ever created (hold was released after a
 * pre-Stripe failure). Admins can NEVER redirect refund money to a
 * different destination — Stripe always refunds the original PaymentIntent.
 */

const express = require('express');
const router = express.Router();
const { adminAuth, requirePermission, adminCsrf } = require('./adminAuth');
const {
  sanitizeRefundForResponse,
  markRefundSucceeded,
  markRefundFailed,
  applyStripeRefundObject,
} = require('./refundEngine');
const { commitRefundTransitionPostgres, getRefundById } = require('./db/refundsPostgres');
const {
  buildRefundLedgerNarrative,
  findStripeRefundForRequest,
} = require('./refundStripeSafety');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

router.get('/', adminAuth, requirePermission('refunds:read'), (req, res) => {
  const db = loadAppState();
  let list = db.refundRequests || [];

  if (req.query.status) list = list.filter((r) => r.status === req.query.status);
  if (req.query.userId) list = list.filter((r) => r.userId === req.query.userId);
  if (req.query.currency) list = list.filter((r) => r.currency === req.query.currency);
  if (req.query.depositTransactionId) {
    list = list.filter((r) => r.depositTransactionId === req.query.depositTransactionId);
  }

  list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const totalItems = list.length;
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * limit;
  const data = list.slice(start, start + limit).map(sanitizeRefundForResponse);

  logAdminAction(req, 'REFUNDS_LIST', {
    status: req.query.status || null,
    count: data.length,
    totalItems,
  });

  res.json({ data, page: safePage, totalPages, totalItems, count: data.length, refunds: data });
});

router.get('/:id', adminAuth, requirePermission('refunds:read'), async (req, res) => {
  const db = loadAppState();
  const refund = (db.refundRequests || []).find((r) => r.id === req.params.id);
  if (!refund) return res.status(404).json({ error: 'Refund not found' });

  const ledger = (db.ledger || []).filter((l) => l.refundRequestId === refund.id);
  const deposit = (db.transactions || []).find((t) => t.id === refund.depositTransactionId) || null;
  let pgRow = null;
  try { pgRow = await getRefundById(refund.id); } catch (_) { /* optional */ }

  logAdminAction(req, 'REFUND_VIEW', {
    refundId: refund.id, userId: refund.userId, status: refund.status,
  });

  const ledgerNarrative = buildRefundLedgerNarrative(ledger);
  res.json({
    refund: sanitizeRefundForResponse(refund),
    ledger,
    ledgerNarrative,
    deposit: deposit ? {
      id: deposit.id,
      amount: deposit.amount,
      currency: deposit.currency,
      stripeIntentId: deposit.stripeIntentId,
      grossAmount: deposit.grossAmount || null,
      feeAmount: deposit.feeAmount || null,
      status: deposit.status,
      timestamp: deposit.timestamp,
    } : null,
    postgres: pgRow,
    // Explicitly document that destination cannot be changed.
    destinationPolicy: 'original_payment_method_only',
  });
});

/**
 * Reconcile a refund against Stripe's current Refund object.
 * Syncs local state to Stripe — never redirects money elsewhere.
 */
router.post('/:id/reconcile', adminAuth, adminCsrf, requirePermission('refunds:write'), async (req, res) => {
  if (!stripeClient) return res.status(503).json({ error: 'Stripe is not configured' });

  const withBalanceMutex = req.app.locals.withBalanceMutex;
  if (!withBalanceMutex) return res.status(500).json({ error: 'Balance mutex unavailable' });

  let result;
  try {
    await withBalanceMutex(async () => {
      const db = loadAppState();
      const refund = (db.refundRequests || []).find((r) => r.id === req.params.id);
      if (!refund) {
        result = { status: 404, body: { error: 'Refund not found' } };
        return;
      }

      const expectedStatus = refund.status;
      let stripeRefund = null;

      if (refund.stripeRefundId) {
        stripeRefund = await stripeClient.refunds.retrieve(refund.stripeRefundId);
      } else if (refund.stripePaymentIntentId) {
        // Always re-query Stripe before deciding to leave failed/released.
        stripeRefund = await findStripeRefundForRequest(stripeClient, {
          refundId: refund.id,
          paymentIntentId: refund.stripePaymentIntentId,
          stripeAmount: refund.stripeRefundAmount || refund.amount,
        });
      }

      if (!stripeRefund) {
        refund.reconciliationResult = {
          at: Date.now(),
          outcome: 'no_stripe_refund_found',
          localStatus: refund.status,
        };
        saveAppState(db);
        result = {
          status: 200,
          body: {
            refund: sanitizeRefundForResponse(refund),
            reconciliation: refund.reconciliationResult,
            ledgerNarrative: buildRefundLedgerNarrative(
              (db.ledger || []).filter((l) => l.refundRequestId === refund.id)
            ),
          },
        };
        return;
      }

      const applyResult = applyStripeRefundObject(db, stripeRefund, 'admin_reconcile');
      refund.reconciliationResult = {
        at: Date.now(),
        outcome: 'synced',
        stripeStatus: stripeRefund.status,
        stripeRefundId: stripeRefund.id,
        applyResult,
      };

      const ledgerTypes = [];
      if (refund.status === 'succeeded') {
        const hasRedebit = (db.ledger || []).some(
          (l) => l.refundRequestId === refund.id && l.type === 'deposit_refund_redebit'
        );
        ledgerTypes.push(hasRedebit ? 'deposit_refund_redebit' : 'deposit_refund_debit');
      }
      if (refund.status === 'failed' || refund.status === 'cancelled') {
        ledgerTypes.push('deposit_refund_release');
      }

      await commitRefundTransitionPostgres({
        stateDb: db,
        refund,
        expectedStatus,
        ledgerTypes,
      });
      saveAppState(db);

      result = {
        status: 200,
        body: {
          refund: sanitizeRefundForResponse(refund),
          reconciliation: refund.reconciliationResult,
          ledgerNarrative: buildRefundLedgerNarrative(
            (db.ledger || []).filter((l) => l.refundRequestId === refund.id)
          ),
          destinationPolicy: 'original_payment_method_only',
        },
      };
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Reconcile failed' });
  }

  logAdminAction(req, 'REFUND_RECONCILE', {
    refundId: req.params.id,
    outcome: result?.body?.reconciliation?.outcome || null,
  });
  return res.status(result.status).json(result.body);
});

/**
 * Safe retry: ONLY when the refund failed before Stripe created a refund
 * object (no stripeRefundId). Creates nothing new here — tells the admin
 * to have the user re-submit with a new idempotency key. We deliberately
 * do NOT re-call Stripe from admin with a new amount/destination.
 */
router.post('/:id/retry', adminAuth, adminCsrf, requirePermission('refunds:write'), async (req, res) => {
  const db = loadAppState();
  const refund = (db.refundRequests || []).find((r) => r.id === req.params.id);
  if (!refund) return res.status(404).json({ error: 'Refund not found' });

  if (refund.stripeRefundId) {
    return res.status(409).json({
      error: 'A Stripe refund already exists for this request. Use Reconcile to sync status. Money can only return to the original payment method.',
      errorCode: 'STRIPE_REFUND_EXISTS',
      stripeRefundId: refund.stripeRefundId,
      destinationPolicy: 'original_payment_method_only',
    });
  }

  if (refund.status !== 'failed' && refund.status !== 'cancelled') {
    return res.status(409).json({
      error: `Refund is ${refund.status}; only failed/cancelled refunds without a Stripe refund ID are eligible for user re-submission.`,
      errorCode: 'RETRY_NOT_ELIGIBLE',
    });
  }

  logAdminAction(req, 'REFUND_RETRY_GUIDANCE', {
    refundId: refund.id,
    userId: refund.userId,
    status: refund.status,
  });

  return res.json({
    ok: true,
    message: 'No Stripe refund was created. The user may submit a new refund request with a fresh Idempotency-Key. Destination remains the original payment method only.',
    refund: sanitizeRefundForResponse(refund),
    destinationPolicy: 'original_payment_method_only',
    // Admin cannot force-succeed or redirect.
    adminActionsAllowed: ['reconcile'],
  });
});

// Explicitly reject any attempt to set a destination card/account.
router.post('/:id/redirect', adminAuth, adminCsrf, requirePermission('refunds:write'), (req, res) => {
  logAdminAction(req, 'REFUND_REDIRECT_BLOCKED', { refundId: req.params.id });
  return res.status(400).json({
    error: 'Refunds can only return to the original Stripe payment method. Redirecting refund money is not supported.',
    errorCode: 'REFUND_REDIRECT_FORBIDDEN',
    destinationPolicy: 'original_payment_method_only',
  });
});

module.exports = { router };
// markRefundSucceeded / markRefundFailed kept imported for future admin force-sync hooks.
void markRefundSucceeded;
void markRefundFailed;
