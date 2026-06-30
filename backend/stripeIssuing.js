'use strict';

/**
 * Stripe Issuing integration helpers (no outbound Stripe API calls in this module).
 *
 * Used by POST /webhooks/stripe to map Issuing events into recordVirtualCardCharge().
 * Card provisioning (cardholders + cards) lives in stripeIssuingProvision.js once enabled.
 */

const ISSUING_EVENT_TYPES = new Set([
  'issuing_authorization.created',
  'issuing_authorization.updated',
  'issuing_transaction.created',
  'issuing_card.updated',
]);

function isStripeIssuingEnabled() {
  return process.env.STRIPE_ISSUING_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY;
}

function findCardByStripeCardId(db, stripeCardId) {
  if (!stripeCardId) return null;
  return (db.virtualCards || []).find(
    (c) => c.stripeCardId === stripeCardId && c.status !== 'deleted',
  ) || null;
}

function stripeCardIdFromObject(obj) {
  if (!obj) return null;
  if (typeof obj.card === 'string') return obj.card;
  return obj.card?.id || null;
}

function merchantFromAuthorization(auth) {
  return auth?.merchant_data?.name
    || auth?.merchant_data?.category
    || auth?.merchant_data?.network_id
    || null;
}

function merchantFromTransaction(txn) {
  return txn?.merchant_data?.name || merchantFromAuthorization(txn?.authorization) || null;
}

/**
 * Map Stripe Issuing card status to EGWallet virtual card status.
 * Stripe: active | inactive | canceled
 */
function mapStripeCardStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active': return 'active';
    case 'inactive': return 'frozen';
    case 'canceled': return 'closed';
    default: return null;
  }
}

/**
 * Build recordVirtualCardCharge payload from an Issuing authorization object.
 * Records declines and reversals; skips approved pending auths (capture recorded via transaction).
 */
function mapAuthorizationToCharge(auth, { eventId, recordPending = false } = {}) {
  const stripeCardId = stripeCardIdFromObject(auth);
  if (!stripeCardId) return null;

  const amount = auth.amount ?? 0;
  const currency = (auth.currency || 'usd').toUpperCase();
  const merchant = merchantFromAuthorization(auth);
  const base = {
    amount,
    currency,
    merchant,
    providerReference: auth.id,
    idempotencyKey: eventId ? `stripe-event:${eventId}` : `stripe-auth:${auth.id}`,
  };

  if (auth.approved === false) {
    return { ...base, type: 'decline', status: 'declined' };
  }

  if (auth.status === 'reversed') {
    return { ...base, type: 'reversal', status: 'completed' };
  }

  if (recordPending && auth.approved === true && auth.status === 'pending') {
    return { ...base, type: 'purchase', status: 'pending' };
  }

  return null;
}

/**
 * Build recordVirtualCardCharge payload from an Issuing transaction object.
 */
function mapTransactionToCharge(txn, { eventId } = {}) {
  const stripeCardId = stripeCardIdFromObject(txn);
  if (!stripeCardId) return null;

  const amount = txn.amount ?? 0;
  const currency = (txn.currency || 'usd').toUpperCase();
  const merchant = merchantFromTransaction(txn);
  const base = {
    amount,
    currency,
    merchant,
    providerReference: txn.id,
    idempotencyKey: eventId ? `stripe-event:${eventId}` : `stripe-txn:${txn.id}`,
    createdAt: txn.created ? txn.created * 1000 : Date.now(),
  };

  const txnType = txn.type || 'capture';
  if (txnType === 'refund') {
    return { ...base, type: 'refund', status: 'completed' };
  }
  if (txnType === 'capture') {
    return { ...base, type: 'purchase', status: 'completed' };
  }
  return null;
}

/**
 * Process a verified Stripe webhook event. Returns summary for logging; mutates db in place.
 * Does not touch wallet balances.
 */
function processStripeIssuingEvent(db, event, { recordVirtualCardCharge, setVirtualCardStatus, logger } = {}) {
  if (!ISSUING_EVENT_TYPES.has(event.type)) {
    return { handled: false, reason: 'not_issuing_event' };
  }

  if (!isStripeIssuingEnabled()) {
    return { handled: false, reason: 'issuing_disabled' };
  }

  const recordCharge = recordVirtualCardCharge || require('./virtualCardCharges').recordVirtualCardCharge;
  const setStatus = setVirtualCardStatus || require('./virtualCards').setVirtualCardStatus;
  const log = logger || { info: () => {}, warn: () => {} };

  const obj = event.data?.object;
  if (!obj) return { handled: false, reason: 'missing_object' };

  if (event.type === 'issuing_card.updated') {
    const card = findCardByStripeCardId(db, obj.id);
    if (!card) {
      log.warn('[stripe/issuing] issuing_card.updated — unknown card', { stripeCardId: obj.id });
      return { handled: true, action: 'card_not_found' };
    }
    const mapped = mapStripeCardStatus(obj.status);
    if (mapped && mapped !== card.status) {
      setStatus(card, mapped, { actor: 'stripe', reason: `issuing_card.updated:${obj.status}` });
    }
    if (obj.last4 && obj.last4 !== card.last4) card.last4 = obj.last4;
    if (obj.brand) card.brand = obj.brand;
    return { handled: true, action: 'card_synced', cardId: card.id, status: card.status };
  }

  const stripeCardId = stripeCardIdFromObject(obj);
  const card = findCardByStripeCardId(db, stripeCardId);
  if (!card) {
    log.warn('[stripe/issuing] event for unknown Stripe card', {
      eventType: event.type,
      stripeCardId,
      objectId: obj.id,
    });
    return { handled: true, action: 'card_not_found' };
  }

  let chargePayload = null;
  if (event.type === 'issuing_authorization.created') {
    chargePayload = mapAuthorizationToCharge(obj, {
      eventId: event.id,
      recordPending: process.env.STRIPE_ISSUING_RECORD_PENDING_AUTHS === 'true',
    });
  } else if (event.type === 'issuing_authorization.updated') {
    chargePayload = mapAuthorizationToCharge(obj, { eventId: event.id });
  } else if (event.type === 'issuing_transaction.created') {
    chargePayload = mapTransactionToCharge(obj, { eventId: event.id });
  }

  if (!chargePayload) {
    return { handled: true, action: 'no_charge_mapping', cardId: card.id };
  }

  const result = recordCharge(db, {
    cardId: card.id,
    userId: card.userId,
    ...chargePayload,
  });

  log.info('[stripe/issuing] charge recorded', {
    eventType: event.type,
    cardId: card.id,
    chargeId: result.charge?.id,
    created: result.created,
    duplicate: result.duplicate,
    type: chargePayload.type,
    status: chargePayload.status,
  });

  return {
    handled: true,
    action: result.duplicate ? 'charge_duplicate' : 'charge_recorded',
    cardId: card.id,
    chargeId: result.charge?.id,
  };
}

module.exports = {
  ISSUING_EVENT_TYPES,
  isStripeIssuingEnabled,
  findCardByStripeCardId,
  mapStripeCardStatus,
  mapAuthorizationToCharge,
  mapTransactionToCharge,
  processStripeIssuingEvent,
  stripeCardIdFromObject,
};
