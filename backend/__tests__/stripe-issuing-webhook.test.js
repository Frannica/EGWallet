'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  mapAuthorizationToCharge,
  mapTransactionToCharge,
  mapStripeCardStatus,
  processStripeIssuingEvent,
  findCardByStripeCardId,
} = require('../stripeIssuing');
const { recordVirtualCardCharge } = require('../virtualCardCharges');
const { setVirtualCardStatus } = require('../virtualCards');

const STRIPE_CARD_ID = 'ic_test_card_001';

function buildDb() {
  const userId = uuidv4();
  const walletId = uuidv4();
  const cardId = uuidv4();
  const db = {
    users: [{ id: userId, email: 'issuing@test.local' }],
    wallets: [{ id: walletId, userId, balances: [{ currency: 'USD', amount: 0 }] }],
    virtualCards: [{
      id: cardId,
      userId,
      walletId,
      stripeCardId: STRIPE_CARD_ID,
      stripeCardholderId: 'ich_test_holder_001',
      last4: '4242',
      brand: 'visa',
      currency: 'USD',
      status: 'active',
      createdAt: Date.now(),
      spentToday: 0,
      spentMonth: 0,
    }],
    virtualCardCharges: [],
  };
  return { db, userId, cardId };
}

test('mapStripeCardStatus maps active/inactive/canceled', () => {
  assert.equal(mapStripeCardStatus('active'), 'active');
  assert.equal(mapStripeCardStatus('inactive'), 'frozen');
  assert.equal(mapStripeCardStatus('canceled'), 'closed');
});

test('declined authorization maps to decline charge', () => {
  const payload = mapAuthorizationToCharge({
    id: 'iauth_declined_1',
    amount: 2500,
    currency: 'usd',
    approved: false,
    status: 'closed',
    card: STRIPE_CARD_ID,
    merchant_data: { name: 'Test Merchant' },
  }, { eventId: 'evt_decl_1' });

  assert.equal(payload.type, 'decline');
  assert.equal(payload.status, 'declined');
  assert.equal(payload.amount, 2500);
  assert.equal(payload.currency, 'USD');
  assert.equal(payload.merchant, 'Test Merchant');
  assert.equal(payload.providerReference, 'iauth_declined_1');
});

test('capture transaction maps to completed purchase', () => {
  const payload = mapTransactionToCharge({
    id: 'ipi_capture_1',
    type: 'capture',
    amount: 1800,
    currency: 'usd',
    card: STRIPE_CARD_ID,
    merchant_data: { name: 'Coffee Shop' },
    created: 1710000000,
  }, { eventId: 'evt_cap_1' });

  assert.equal(payload.type, 'purchase');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.amount, 1800);
  assert.equal(payload.providerReference, 'ipi_capture_1');
});

test('refund transaction maps to completed refund', () => {
  const payload = mapTransactionToCharge({
    id: 'ipi_refund_1',
    type: 'refund',
    amount: 500,
    currency: 'usd',
    card: STRIPE_CARD_ID,
  }, { eventId: 'evt_ref_1' });

  assert.equal(payload.type, 'refund');
  assert.equal(payload.status, 'completed');
});

test('processStripeIssuingEvent records capture and is idempotent on replay', () => {
  const prevEnabled = process.env.STRIPE_ISSUING_ENABLED;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_ISSUING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';

  try {
    const { db, userId, cardId } = buildDb();
    const event = {
      id: 'evt_txn_1',
      type: 'issuing_transaction.created',
      data: {
        object: {
          id: 'ipi_capture_2',
          type: 'capture',
          amount: 3200,
          currency: 'usd',
          card: STRIPE_CARD_ID,
          merchant_data: { name: 'Online Store' },
        },
      },
    };

    const first = processStripeIssuingEvent(db, event, { recordVirtualCardCharge, setVirtualCardStatus });
    assert.equal(first.action, 'charge_recorded');
    assert.equal(db.virtualCardCharges.length, 1);
    assert.equal(db.virtualCardCharges[0].userId, userId);
    assert.equal(db.virtualCardCharges[0].cardId, cardId);
    assert.equal(db.virtualCardCharges[0].type, 'purchase');

    const second = processStripeIssuingEvent(db, event, { recordVirtualCardCharge, setVirtualCardStatus });
    assert.equal(second.action, 'charge_duplicate');
    assert.equal(db.virtualCardCharges.length, 1);
  } finally {
    if (prevEnabled === undefined) delete process.env.STRIPE_ISSUING_ENABLED;
    else process.env.STRIPE_ISSUING_ENABLED = prevEnabled;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
  }
});

test('processStripeIssuingEvent syncs card status on issuing_card.updated', () => {
  const prevEnabled = process.env.STRIPE_ISSUING_ENABLED;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_ISSUING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';

  try {
    const { db } = buildDb();
    const card = findCardByStripeCardId(db, STRIPE_CARD_ID);
    assert.equal(card.status, 'active');

    processStripeIssuingEvent(db, {
      id: 'evt_card_1',
      type: 'issuing_card.updated',
      data: {
        object: {
          id: STRIPE_CARD_ID,
          status: 'inactive',
          last4: '9999',
          brand: 'mastercard',
        },
      },
    }, { recordVirtualCardCharge, setVirtualCardStatus });

    assert.equal(card.status, 'frozen');
    assert.equal(card.last4, '9999');
    assert.equal(card.brand, 'mastercard');
  } finally {
    if (prevEnabled === undefined) delete process.env.STRIPE_ISSUING_ENABLED;
    else process.env.STRIPE_ISSUING_ENABLED = prevEnabled;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
  }
});

test('processStripeIssuingEvent skips when STRIPE_ISSUING_ENABLED is false', () => {
  const prevEnabled = process.env.STRIPE_ISSUING_ENABLED;
  process.env.STRIPE_ISSUING_ENABLED = 'false';

  try {
    const { db } = buildDb();
    const result = processStripeIssuingEvent(db, {
      id: 'evt_skip',
      type: 'issuing_transaction.created',
      data: { object: { id: 'ipi_x', type: 'capture', amount: 100, currency: 'usd', card: STRIPE_CARD_ID } },
    }, { recordVirtualCardCharge, setVirtualCardStatus });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'issuing_disabled');
    assert.equal(db.virtualCardCharges.length, 0);
  } finally {
    if (prevEnabled === undefined) delete process.env.STRIPE_ISSUING_ENABLED;
    else process.env.STRIPE_ISSUING_ENABLED = prevEnabled;
  }
});
