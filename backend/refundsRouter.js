'use strict';
/**
 * refundsRouter.js
 * User-facing Stripe refund-to-original-card API.
 *
 *   GET  /refunds/eligibility/:transactionId
 *   POST /refunds
 *   GET  /refunds
 *   GET  /refunds/:id
 *   POST /refunds/:id/cancel   (only before Stripe accepts)
 *
 * Mounted with authMiddleware by index.js.
 */

const express = require('express');
const router = express.Router();
const {
  createRefundRequest,
  getWalletRefundableAmount,
  isWithinRefundWindow,
  computeStripeRefundAmount,
  markRefundSubmitted,
  markRefundCancelled,
  sanitizeRefundForResponse,
  REFUND_WINDOW_DAYS,
} = require('./refundEngine');
const {
  commitCreateRefundPostgres,
  commitRefundTransitionPostgres,
  getDurableRefundIdempotency,
} = require('./db/refundsPostgres');
const { loadAppState, saveAppState } = require('./db/appStateStore');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

function getUser(db, userId) {
  return (db.users || []).find((u) => u.id === userId) || null;
}

function accountBlocked(user) {
  if (!user) return { blocked: true, code: 'ACCOUNT_NOT_FOUND', error: 'Account not found' };
  const status = user.accountStatus || user.status;
  if (status === 'suspended') return { blocked: true, code: 'ACCOUNT_SUSPENDED', error: 'Account suspended. Contact support.' };
  if (status === 'frozen') return { blocked: true, code: 'ACCOUNT_FROZEN', error: 'Account frozen. Contact support.' };
  if (status === 'locked' || user.locked) return { blocked: true, code: 'ACCOUNT_LOCKED', error: 'Account locked. Contact support.' };
  return { blocked: false };
}

/**
 * Retrieve Stripe PI and compute remaining refundable charge amount.
 * Returns null stripeRemaining when Stripe is unavailable (caller decides).
 */
async function inspectStripePaymentIntent(intentId) {
  if (!stripeClient) return { available: false, reason: 'stripe_not_configured' };
  const intent = await stripeClient.paymentIntents.retrieve(intentId);
  if (!intent) return { available: false, reason: 'intent_not_found' };
  if (intent.status !== 'succeeded') {
    return { available: false, reason: 'intent_not_succeeded', intentStatus: intent.status, intent };
  }
  const charged = Number(intent.amount_received || intent.amount || 0);
  const alreadyRefunded = Number(intent.amount_refunded || 0);
  const remaining = Math.max(0, charged - alreadyRefunded);
  return {
    available: remaining > 0,
    reason: remaining > 0 ? 'ok' : 'fully_refunded_on_stripe',
    intent,
    charged,
    alreadyRefunded,
    remaining,
  };
}

// ── GET /refunds/eligibility/:transactionId ──────────────────────────────────
router.get('/eligibility/:transactionId', async (req, res) => {
  const db = loadAppState();
  const user = getUser(db, req.user.userId);
  const block = accountBlocked(user);
  const tx = (db.transactions || []).find((t) => t.id === req.params.transactionId);

  if (!tx || tx.type !== 'deposit') {
    return res.status(404).json({ error: 'Deposit not found', errorCode: 'DEPOSIT_NOT_FOUND' });
  }

  const wallet = (db.wallets || []).find((w) => w.id === tx.toWalletId && w.userId === req.user.userId);
  if (!wallet) {
    return res.status(403).json({ error: 'Deposit does not belong to this user', errorCode: 'DEPOSIT_NOT_OWNED' });
  }

  const walletRefundable = getWalletRefundableAmount(db, tx);
  const withinWindow = isWithinRefundWindow(tx);
  const balance = (wallet.balances || []).find((b) => b.currency === tx.currency);
  const availableBalance = balance ? Number(balance.amount || 0) : 0;

  let stripeInfo = { available: false, reason: 'not_checked' };
  try {
    if (tx.stripeIntentId) {
      stripeInfo = await inspectStripePaymentIntent(tx.stripeIntentId);
    } else {
      stripeInfo = { available: false, reason: 'not_stripe_deposit' };
    }
  } catch (err) {
    stripeInfo = { available: false, reason: 'stripe_lookup_failed', error: err.message };
  }

  const eligible =
    !block.blocked &&
    tx.status === 'completed' &&
    !!tx.stripeIntentId &&
    String(tx.stripeIntentId).startsWith('pi_') &&
    withinWindow &&
    walletRefundable > 0 &&
    availableBalance > 0 &&
    stripeInfo.available;

  const maxRefundable = Math.min(
    walletRefundable,
    availableBalance,
    // Cap by Stripe remaining mapped back to wallet units (conservative: 1:1 when no fee)
    stripeInfo.remaining != null
      ? Math.min(walletRefundable, stripeInfo.remaining)
      : walletRefundable
  );

  return res.json({
    eligible,
    depositTransactionId: tx.id,
    stripePaymentIntentId: tx.stripeIntentId || null,
    currency: tx.currency,
    depositAmount: tx.amount,
    grossAmount: tx.grossAmount || null,
    feeAmount: tx.feeAmount || null,
    walletRefundable,
    availableBalance,
    maxRefundable: eligible ? maxRefundable : 0,
    withinRefundWindow: withinWindow,
    refundWindowDays: REFUND_WINDOW_DAYS,
    accountStatus: block.blocked ? block.code : 'ok',
    stripe: {
      available: !!stripeInfo.available,
      reason: stripeInfo.reason,
      charged: stripeInfo.charged ?? null,
      alreadyRefunded: stripeInfo.alreadyRefunded ?? null,
      remaining: stripeInfo.remaining ?? null,
      intentStatus: stripeInfo.intentStatus || stripeInfo.intent?.status || null,
    },
    destinationPolicy: 'original_payment_method_only',
    message: 'Refunds return money only to the original payment method used for this deposit. You cannot choose a different card.',
  });
});

// ── POST /refunds ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { depositTransactionId, amount, amountMode } = req.body || {};
  const clientKey = req.body?.idempotencyKey
    || req.headers['idempotency-key']
    || req.headers['x-idempotency-key'];

  if (!clientKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required', errorCode: 'IDEMPOTENCY_KEY_REQUIRED' });
  }
  if (!depositTransactionId) {
    return res.status(400).json({ error: 'depositTransactionId is required', errorCode: 'MISSING_FIELDS' });
  }

  // Reject any attempt to supply a destination card.
  if (req.body?.destination || req.body?.cardNumber || req.body?.paymentMethodId || req.body?.destinationCard) {
    return res.status(400).json({
      error: 'Refunds return only to the original payment method. Do not supply a destination card.',
      errorCode: 'DESTINATION_NOT_ALLOWED',
      destinationPolicy: 'original_payment_method_only',
    });
  }

  const withBalanceMutex = req.app.locals.withBalanceMutex;
  const logger = req.app.locals.logger || console;

  // Fast durable idempotency replay
  try {
    const durableHit = await getDurableRefundIdempotency(clientKey, req.user.userId);
    if (durableHit) return res.status(200).json(durableHit);
  } catch (_) { /* continue */ }

  if (!stripeClient) {
    return res.status(503).json({
      error: 'Card refunds are temporarily unavailable. Please try again later.',
      errorCode: 'STRIPE_NOT_CONFIGURED',
    });
  }

  // Pre-flight (outside mutex): ownership + Stripe remaining. Re-checked
  // under the mutex before the hold is placed.
  const preDb = loadAppState();
  const preUser = getUser(preDb, req.user.userId);
  const preBlock = accountBlocked(preUser);
  if (preBlock.blocked) {
    return res.status(403).json({ error: preBlock.error, errorCode: preBlock.code });
  }
  const preDeposit = (preDb.transactions || []).find((t) => t.id === depositTransactionId);
  if (!preDeposit || preDeposit.type !== 'deposit') {
    return res.status(404).json({ error: 'Deposit not found', errorCode: 'DEPOSIT_NOT_FOUND' });
  }
  const preWallet = (preDb.wallets || []).find(
    (w) => w.id === preDeposit.toWalletId && w.userId === req.user.userId
  );
  if (!preWallet) {
    return res.status(403).json({ error: 'Deposit does not belong to this user', errorCode: 'DEPOSIT_NOT_OWNED' });
  }
  if (!preDeposit.stripeIntentId || !String(preDeposit.stripeIntentId).startsWith('pi_')) {
    return res.status(400).json({
      error: 'This deposit was not made via Stripe card and cannot be refunded to a card',
      errorCode: 'NOT_STRIPE_DEPOSIT',
    });
  }

  let stripeInfo;
  try {
    stripeInfo = await inspectStripePaymentIntent(preDeposit.stripeIntentId);
  } catch (stripeErr) {
    logger.warn?.('[POST /refunds] Stripe PI lookup failed', { error: stripeErr.message });
    return res.status(503).json({
      error: 'Unable to verify deposit with Stripe. Please try again shortly.',
      errorCode: 'STRIPE_LOOKUP_FAILED',
    });
  }
  if (!stripeInfo.available) {
    return res.status(400).json({
      error: stripeInfo.reason === 'fully_refunded_on_stripe'
        ? 'This deposit has already been fully refunded on Stripe.'
        : 'This deposit cannot be refunded through Stripe right now.',
      errorCode: 'STRIPE_NOT_REFUNDABLE',
      stripe: { reason: stripeInfo.reason },
      destinationPolicy: 'original_payment_method_only',
    });
  }

  let created;
  let responseBody;

  try {
    await withBalanceMutex(async () => {
      const db = loadAppState();
      const user = getUser(db, req.user.userId);
      const block = accountBlocked(user);
      if (block.blocked) {
        const err = new Error(block.error);
        err.status = 403;
        err.errorCode = block.code;
        throw err;
      }

      const depositTx = (db.transactions || []).find((t) => t.id === depositTransactionId);
      if (!depositTx) {
        const err = new Error('Deposit not found');
        err.status = 404;
        err.errorCode = 'DEPOSIT_NOT_FOUND';
        throw err;
      }

      // Resolve amount: 'full' mode uses entire remaining refundable.
      let walletAmount = amount;
      if (amountMode === 'full' || amount === undefined || amount === null) {
        walletAmount = getWalletRefundableAmount(db, depositTx);
      }
      if (!Number.isInteger(walletAmount) || walletAmount <= 0) {
        const err = new Error('Invalid refund amount');
        err.status = 400;
        err.errorCode = 'INVALID_AMOUNT';
        throw err;
      }

      const depositNet = Number(depositTx.amount || 0);
      const depositGross = Number(depositTx.grossAmount || stripeInfo.charged || depositNet);
      const stripeRefundAmount = computeStripeRefundAmount({
        walletAmount,
        depositNet,
        depositGross,
        stripeRemaining: stripeInfo.remaining,
      });
      if (!(stripeRefundAmount > 0)) {
        const err = new Error('No refundable Stripe amount remaining');
        err.status = 400;
        err.errorCode = 'STRIPE_NOT_REFUNDABLE';
        throw err;
      }

      created = createRefundRequest(db, req.user.userId, {
        depositTransactionId,
        amount: walletAmount,
        idempotencyKey: clientKey,
        stripeRefundAmount,
        stripePaymentIntentId: depositTx.stripeIntentId,
      });

      if (created.replay) {
        responseBody = {
          refund: sanitizeRefundForResponse(created.refund),
          destinationPolicy: 'original_payment_method_only',
          replay: true,
        };
        return;
      }

      responseBody = {
        refund: sanitizeRefundForResponse(created.refund),
        destinationPolicy: 'original_payment_method_only',
        message: 'Refund requested. Money will return only to the original payment method.',
      };

      const pg = await commitCreateRefundPostgres({
        stateDb: db,
        refund: created.refund,
        userId: req.user.userId,
        clientKey,
        responseBody,
      });

      if (pg.replay) {
        responseBody = pg.response;
        created = { replay: true, refund: pg.response?.refund };
        return;
      }
      if (pg.insufficientFunds) {
        // Roll back in-memory hold
        markRefundCancelled(db, created.refund.id, 'insufficient_funds_postgres', { by: 'system' });
        saveAppState(db);
        const err = new Error('Insufficient wallet balance to refund this deposit');
        err.status = 400;
        err.errorCode = 'INSUFFICIENT_BALANCE';
        throw err;
      }
      if (pg.overRefund) {
        markRefundCancelled(db, created.refund.id, 'over_refund_guard', { by: 'system' });
        saveAppState(db);
        const err = new Error(`Refundable amount is ${pg.refundable}`);
        err.status = 400;
        err.errorCode = 'AMOUNT_EXCEEDS_REFUNDABLE';
        err.refundable = pg.refundable;
        throw err;
      }

      saveAppState(db);
    });
  } catch (err) {
    logger.warn?.('[POST /refunds] rejected', { error: err.message, code: err.errorCode });
    return res.status(err.status || 500).json({
      error: err.message || 'Refund failed',
      errorCode: err.errorCode || 'REFUND_FAILED',
      ...(err.refundable !== undefined && { refundable: err.refundable }),
      destinationPolicy: 'original_payment_method_only',
    });
  }

  if (created?.replay) {
    return res.status(200).json(responseBody);
  }

  // ── Call Stripe OUTSIDE the balance mutex (network I/O) ────────────────────
  const refundId = created.refund.id;
  const stripeAmount = created.refund.stripeRefundAmount;
  const paymentIntent = created.refund.stripePaymentIntentId;

  let stripeRefund;
  try {
    stripeRefund = await stripeClient.refunds.create(
      {
        payment_intent: paymentIntent,
        amount: stripeAmount,
        reason: 'requested_by_customer',
        metadata: {
          refundRequestId: refundId,
          egwalletRefundId: refundId,
          depositTransactionId: created.refund.depositTransactionId,
          userId: req.user.userId,
        },
      },
      { idempotencyKey: `egw-refund-${refundId}` }
    );
  } catch (stripeErr) {
    logger.error?.('[POST /refunds] Stripe refunds.create error — re-querying before any hold release', {
      refundId, error: stripeErr.message, code: stripeErr.code,
    });
    const { resolveStripeRefundAfterCreateError } = require('./refundStripeSafety');
    const resolution = await resolveStripeRefundAfterCreateError(stripeClient, {
      refundId,
      paymentIntentId: paymentIntent,
      stripeAmount,
      error: stripeErr,
    });

    if (resolution.stripeRefund) {
      // Stripe already has the refund (timeout / 502 / idempotency after success).
      // Settle as success — NEVER restore wallet funds.
      stripeRefund = resolution.stripeRefund;
      logger.warn?.('[POST /refunds] Stripe refund found on re-query after create error; settling', {
        refundId, stripeRefundId: stripeRefund.id, status: stripeRefund.status,
      });
    } else if (resolution.safeToReleaseHold) {
      await withBalanceMutex(async () => {
        const db = loadAppState();
        const expectedStatus = 'requested';
        const { markRefundFailed } = require('./refundEngine');
        markRefundFailed(db, refundId, stripeErr.message || 'Stripe refund create failed', {
          by: 'system',
          stripeStatus: 'failed',
        });
        const refund = (db.refundRequests || []).find((r) => r.id === refundId);
        await commitRefundTransitionPostgres({
          stateDb: db,
          refund,
          expectedStatus,
          ledgerTypes: ['deposit_refund_release'],
        });
        saveAppState(db);
        responseBody = {
          refund: sanitizeRefundForResponse(refund),
          error: 'Stripe could not process the refund. Your balance has been restored.',
          errorCode: 'STRIPE_REFUND_FAILED',
          destinationPolicy: 'original_payment_method_only',
          stripeRequery: { reason: resolution.reason },
        };
      });
      return res.status(502).json(responseBody);
    } else {
      // Uncertain (lookup failed). Keep hold — do not restore.
      await withBalanceMutex(async () => {
        const db = loadAppState();
        const refund = (db.refundRequests || []).find((r) => r.id === refundId);
        if (refund) {
          refund.reconciliationResult = {
            at: Date.now(),
            outcome: 'hold_retained_pending_stripe_verify',
            reason: resolution.reason,
            createError: resolution.errorMessage,
            lookupError: resolution.lookupError || null,
          };
          saveAppState(db);
        }
        responseBody = {
          refund: sanitizeRefundForResponse(refund),
          error: 'Refund submitted to Stripe but confirmation is pending. Your funds remain on hold until verified.',
          errorCode: 'REFUND_PENDING_STRIPE_VERIFY',
          destinationPolicy: 'original_payment_method_only',
          stripeRequery: { reason: resolution.reason, safeToReleaseHold: false },
        };
      });
      return res.status(202).json(responseBody);
    }
  }

  // Apply Stripe result (create success OR re-query found existing refund)
  await withBalanceMutex(async () => {
    const db = loadAppState();
    const prior = (db.refundRequests || []).find((r) => r.id === refundId);
    const expectedStatus = prior?.status || 'requested';
    markRefundSubmitted(db, refundId, {
      stripeRefundId: stripeRefund.id,
      stripeStatus: stripeRefund.status,
      by: 'stripe',
    });
    const refund = (db.refundRequests || []).find((r) => r.id === refundId);
    const ledgerTypes = [];
    if (refund.status === 'succeeded') {
      const hasRedebit = (db.ledger || []).some(
        (l) => l.refundRequestId === refundId && l.type === 'deposit_refund_redebit'
      );
      ledgerTypes.push(hasRedebit ? 'deposit_refund_redebit' : 'deposit_refund_debit');
    }
    if (refund.status === 'failed') ledgerTypes.push('deposit_refund_release');
    await commitRefundTransitionPostgres({
      stateDb: db,
      refund,
      expectedStatus,
      ledgerTypes,
    });
    saveAppState(db);
    responseBody = {
      refund: sanitizeRefundForResponse(refund),
      destinationPolicy: 'original_payment_method_only',
      message: refund.status === 'succeeded'
        ? 'Refund succeeded. Money is returning to the original payment method.'
        : 'Refund submitted. Money will return only to the original payment method.',
    };
  });

  return res.status(201).json(responseBody);
});

// ── GET /refunds ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = loadAppState();
  const list = (db.refundRequests || [])
    .filter((r) => r.userId === req.user.userId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(sanitizeRefundForResponse);
  res.json({ refunds: list, destinationPolicy: 'original_payment_method_only' });
});

// ── GET /refunds/:id ─────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = loadAppState();
  const refund = (db.refundRequests || []).find(
    (r) => r.id === req.params.id && r.userId === req.user.userId
  );
  if (!refund) return res.status(404).json({ error: 'Refund not found' });
  res.json({
    refund: sanitizeRefundForResponse(refund),
    destinationPolicy: 'original_payment_method_only',
  });
});

// ── POST /refunds/:id/cancel ─────────────────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  const withBalanceMutex = req.app.locals.withBalanceMutex;
  try {
    let body;
    await withBalanceMutex(async () => {
      const db = loadAppState();
      const refund = (db.refundRequests || []).find(
        (r) => r.id === req.params.id && r.userId === req.user.userId
      );
      if (!refund) {
        const err = new Error('Refund not found');
        err.status = 404;
        throw err;
      }
      const expectedStatus = refund.status;
      markRefundCancelled(db, refund.id, 'cancelled_by_user', { by: 'user' });
      await commitRefundTransitionPostgres({
        stateDb: db,
        refund,
        expectedStatus,
        ledgerTypes: ['deposit_refund_release'],
      });
      saveAppState(db);
      body = {
        refund: sanitizeRefundForResponse(refund),
        destinationPolicy: 'original_payment_method_only',
      };
    });
    return res.json(body);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Cancel failed',
      errorCode: err.errorCode || 'CANCEL_FAILED',
    });
  }
});

module.exports = router;
module.exports.inspectStripePaymentIntent = inspectStripePaymentIntent;
