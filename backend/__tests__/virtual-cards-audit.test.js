'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  provisionVirtualCardForUser,
  getPrimaryVirtualCard,
  toggleVirtualCardFreeze,
  setVirtualCardStatus,
  userVirtualCardFreezeHistory,
  enrichCardForAdmin,
} = require('../virtualCards');
const { recordVirtualCardCharge } = require('../virtualCardCharges');

function buildDb() {
  const userId = uuidv4();
  const walletId = uuidv4();
  return {
    db: {
      users: [{ id: userId, email: 'card-audit@test.local', preferredCurrency: 'USD' }],
      wallets: [{ id: walletId, userId, balances: [{ currency: 'USD', amount: 0 }] }],
      virtualCards: [],
      virtualCardCharges: [],
    },
    userId,
    walletId,
  };
}

test('every user can be assigned one unique virtual card with persistent id', () => {
  const { db, userId, walletId } = buildDb();
  const first = provisionVirtualCardForUser(db, { userId, walletId, currency: 'USD' });
  assert.equal(first.created, true);
  assert.ok(first.card.id);
  assert.equal(first.card.userId, userId);

  const second = provisionVirtualCardForUser(db, { userId, walletId, currency: 'USD' });
  assert.equal(second.created, false);
  assert.equal(second.card.id, first.card.id);
  assert.equal(db.virtualCards.length, 1);
});

test('no two users share the same live card record', () => {
  const { db, userId, walletId } = buildDb();
  provisionVirtualCardForUser(db, { userId, walletId, currency: 'USD' });

  const otherUserId = uuidv4();
  const otherWalletId = uuidv4();
  db.users.push({ id: otherUserId, email: 'other@test.local' });
  db.wallets.push({ id: otherWalletId, userId: otherUserId, balances: [{ currency: 'USD', amount: 0 }] });

  const other = provisionVirtualCardForUser(db, {
    userId: otherUserId,
    walletId: otherWalletId,
    currency: 'USD',
  });
  assert.notEqual(other.card.id, getPrimaryVirtualCard(db, userId).id);
  assert.equal(other.card.userId, otherUserId);
});

test('card status, limits, and freeze history are stored', () => {
  const { db, userId, walletId } = buildDb();
  const { card } = provisionVirtualCardForUser(db, { userId, walletId, currency: 'USD' });
  assert.equal(card.status, 'active');
  assert.ok(card.dailyLimit > 0);
  assert.ok(card.monthlyLimit > 0);

  toggleVirtualCardFreeze(db, card, { actor: 'user' });
  assert.equal(card.status, 'frozen');
  assert.equal(card.freezeHistory.length, 1);

  setVirtualCardStatus(card, 'blocked', { actor: 'admin', adminId: 'ops-1', reason: 'risk review' });
  assert.equal(card.status, 'blocked');

  setVirtualCardStatus(card, 'closed', { actor: 'user', reason: 'closed by user' });
  assert.equal(card.status, 'closed');
  assert.ok(card.closedAt);
});

test('card transactions persist with cardId and userId', () => {
  const { db, userId, walletId } = buildDb();
  const { card } = provisionVirtualCardForUser(db, { userId, walletId, currency: 'USD' });

  const result = recordVirtualCardCharge(db, {
    cardId: card.id,
    userId,
    amount: 1500,
    currency: 'USD',
    merchant: 'Test Merchant',
    type: 'purchase',
    status: 'completed',
    idempotencyKey: 'audit-charge-1',
  });

  assert.equal(result.created, true);
  assert.equal(db.virtualCardCharges.length, 1);
  assert.equal(db.virtualCardCharges[0].cardId, card.id);
  assert.equal(db.virtualCardCharges[0].userId, userId);
  assert.equal(getPrimaryVirtualCard(db, userId).spentToday, 1500);
  assert.equal(getPrimaryVirtualCard(db, userId).spentMonth, 1500);
});

test('admin enrichment exposes owner, last4, status, spend, and freeze history', () => {
  const { db, userId, walletId } = buildDb();
  const { card } = provisionVirtualCardForUser(db, { userId, walletId, currency: 'USD' });
  toggleVirtualCardFreeze(db, card, { actor: 'admin', adminId: 'reviewer-1' });

  const adminView = enrichCardForAdmin(card, userId);
  assert.equal(adminView.userId, userId);
  assert.equal(adminView.last4, card.last4);
  assert.equal(adminView.status, 'frozen');
  assert.ok(Array.isArray(adminView.freezeHistory));
  assert.equal(adminView.freezeEventCount, 1);

  const history = userVirtualCardFreezeHistory(db, userId);
  assert.equal(history.length, 1);
  assert.equal(history[0].cardId, card.id);
});
