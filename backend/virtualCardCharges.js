'use strict';

const { v4: uuidv4 } = require('uuid');

const CHARGE_TYPES = ['purchase', 'refund', 'decline', 'reversal'];
const CHARGE_STATUSES = ['completed', 'pending', 'failed', 'declined'];

function ensureChargesArray(db) {
  if (!db.virtualCardCharges) db.virtualCardCharges = [];
  return db.virtualCardCharges;
}

function findExistingCharge(db, { idempotencyKey, providerReference }) {
  const charges = db.virtualCardCharges || [];
  if (idempotencyKey) {
    const byKey = charges.find((c) => c.idempotencyKey === idempotencyKey);
    if (byKey) return byKey;
  }
  if (providerReference) {
    const byRef = charges.find((c) => c.providerReference === providerReference);
    if (byRef) return byRef;
  }
  return null;
}

function applySpentTodayDelta(card, type, amount, status) {
  const { applySpendDelta } = require('./virtualCards');
  applySpendDelta(card, type, amount, status);
}

/**
 * Persist a virtual card charge/event. Idempotent on idempotencyKey or providerReference.
 * Does not move wallet balances or process payments — event log only.
 */
function recordVirtualCardCharge(db, payload) {
  const {
    cardId,
    userId,
    amount,
    currency,
    merchant = null,
    status = 'completed',
    type,
    createdAt = Date.now(),
    providerReference = null,
    idempotencyKey = null,
  } = payload || {};

  if (!cardId || !userId) {
    throw new Error('cardId and userId are required');
  }
  if (!CHARGE_TYPES.includes(type)) {
    throw new Error(`Invalid charge type: ${type}`);
  }
  if (!CHARGE_STATUSES.includes(status)) {
    throw new Error(`Invalid charge status: ${status}`);
  }
  if (amount == null || Number.isNaN(Number(amount)) || Number(amount) < 0) {
    throw new Error('amount must be a non-negative number');
  }
  if (!currency) {
    throw new Error('currency is required');
  }

  const existing = findExistingCharge(db, { idempotencyKey, providerReference });
  if (existing) {
    return { charge: existing, created: false, duplicate: true };
  }

  const card = (db.virtualCards || []).find(
    (c) => c.id === cardId && c.userId === userId && c.status !== 'deleted',
  );
  if (!card) {
    throw new Error('Virtual card not found');
  }

  const charge = {
    id: uuidv4(),
    cardId,
    userId,
    amount: Number(amount),
    currency,
    merchant: merchant || null,
    status,
    type,
    createdAt,
    providerReference: providerReference || null,
    idempotencyKey: idempotencyKey || null,
  };

  ensureChargesArray(db).push(charge);
  applySpentTodayDelta(card, type, charge.amount, status);

  return { charge, created: true, duplicate: false };
}

function userVirtualCardCharges(db, userId) {
  return (db.virtualCardCharges || [])
    .filter((c) => c.userId === userId)
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function mapVirtualCardCharge(charge, db) {
  const card = (db.virtualCards || []).find((c) => c.id === charge.cardId);
  const last4 = card?.last4 || '****';
  return {
    id: charge.id,
    cardId: charge.cardId,
    userId: charge.userId,
    cardLast4: last4,
    maskedCard: `****${last4}`,
    amount: charge.amount,
    currency: charge.currency,
    merchant: charge.merchant || null,
    status: charge.status,
    type: charge.type,
    createdAt: charge.createdAt,
    providerReference: charge.providerReference || null,
  };
}

module.exports = {
  CHARGE_TYPES,
  CHARGE_STATUSES,
  recordVirtualCardCharge,
  userVirtualCardCharges,
  mapVirtualCardCharge,
  findExistingCharge,
};
