'use strict';
/**
 * refundStripeSafety.js
 *
 * CRITICAL: Never release a refund wallet hold because of HTTP 502, timeout,
 * idempotency noise, or a transient Stripe SDK error until Stripe has been
 * re-queried and confirmed that no refund object exists for this request.
 */

/**
 * Find an existing Stripe Refund for an EGWallet refund request.
 * Matches metadata.refundRequestId / egwalletRefundId, then amount+PI.
 *
 * @returns {Promise<object|null>} Stripe Refund object or null
 */
async function findStripeRefundForRequest(stripeClient, {
  refundId,
  paymentIntentId,
  stripeAmount,
} = {}) {
  if (!stripeClient || !paymentIntentId || !refundId) return null;

  const list = await stripeClient.refunds.list({
    payment_intent: paymentIntentId,
    limit: 100,
  });
  const rows = list.data || [];

  const byMeta = rows.find((r) =>
    r.metadata?.refundRequestId === refundId
    || r.metadata?.egwalletRefundId === refundId
  );
  if (byMeta) return byMeta;

  if (Number.isFinite(Number(stripeAmount))) {
    const byAmount = rows.find((r) =>
      Number(r.amount) === Number(stripeAmount)
      && ['succeeded', 'pending', 'requires_action'].includes(String(r.status || '').toLowerCase())
    );
    if (byAmount) return byAmount;
  }

  return null;
}

/**
 * After stripe.refunds.create throws (or times out), decide whether it is safe
 * to release the wallet hold.
 *
 * Outcomes:
 *   { stripeRefund }            — a refund exists; settle it (never release)
 *   { safeToReleaseHold: true } — Stripe listed cleanly and no matching refund
 *   { safeToReleaseHold: false, reason } — uncertain; keep hold, do not restore
 */
async function resolveStripeRefundAfterCreateError(stripeClient, {
  refundId,
  paymentIntentId,
  stripeAmount,
  error,
} = {}) {
  const errMsg = error?.message || String(error || 'unknown');
  const errCode = error?.code || error?.type || null;

  if (!stripeClient) {
    return {
      safeToReleaseHold: false,
      reason: 'stripe_client_unavailable',
      errorMessage: errMsg,
      errorCode: errCode,
    };
  }

  try {
    const existing = await findStripeRefundForRequest(stripeClient, {
      refundId,
      paymentIntentId,
      stripeAmount,
    });
    if (existing) {
      return {
        stripeRefund: existing,
        safeToReleaseHold: false,
        reason: 'stripe_refund_already_exists',
        errorMessage: errMsg,
        errorCode: errCode,
      };
    }
    return {
      stripeRefund: null,
      safeToReleaseHold: true,
      reason: 'stripe_confirmed_no_refund',
      errorMessage: errMsg,
      errorCode: errCode,
    };
  } catch (lookupErr) {
    return {
      stripeRefund: null,
      safeToReleaseHold: false,
      reason: 'stripe_requery_failed',
      errorMessage: errMsg,
      errorCode: errCode,
      lookupError: lookupErr.message,
    };
  }
}

/**
 * Human-readable ledger narrative for admin reconciliation UIs.
 * Preserves the immutable ledger; only labels existing rows.
 */
function buildRefundLedgerNarrative(ledgerEntries = []) {
  const sorted = [...ledgerEntries].sort(
    (a, b) => Number(a.at || 0) - Number(b.at || 0)
  );
  return sorted.map((l) => {
    const type = l.type;
    let meaning = type;
    if (type === 'deposit_refund_hold') {
      meaning = 'Hold placed — available balance reduced; funds escrowed pending Stripe';
    } else if (type === 'deposit_refund_release') {
      meaning = 'Hold released — available balance temporarily restored (failure / cancel path)';
    } else if (type === 'deposit_refund_debit') {
      if (/reconcile|false_release|redebit/i.test(String(l.note || ''))) {
        meaning = 'Final recovery debit — available corrected after temporary restoration; Stripe had already succeeded';
      } else {
        meaning = 'Final debit — hold cleared without restoring available (Stripe success, normal path)';
      }
    } else if (type === 'deposit_refund_redebit') {
      meaning = 'Recovery debit — available re-debited after a false restoration; Stripe had already succeeded';
    }
    return {
      id: l.id,
      type,
      meaning,
      amount: l.amount,
      balanceBefore: l.balanceBefore ?? l.balance_before,
      balanceAfter: l.balanceAfter ?? l.balance_after,
      at: l.at,
      note: l.note || null,
      by: l.by || l.by_actor || null,
    };
  });
}

module.exports = {
  findStripeRefundForRequest,
  resolveStripeRefundAfterCreateError,
  buildRefundLedgerNarrative,
};
