'use strict';
/**
 * Stripe refund-to-original-card unit tests.
 *
 * Covers the refundEngine state machine, wallet hold/release/finalize,
 * over-refund prevention, destination-card rejection in the router source,
 * webhook event wiring, and the card-withdrawal removal gate.
 *
 * No live Stripe API calls. No real money movement.
 */
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_for_unit_tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  createRefundRequest,
  getWalletRefundableAmount,
  computeStripeRefundAmount,
  markRefundSubmitted,
  markRefundSucceeded,
  markRefundFailed,
  markRefundCancelled,
  applyStripeRefundObject,
  sanitizeRefundForResponse,
  isWithinRefundWindow,
} = require('../refundEngine');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(__dirname, '..', 'refundsRouter.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(__dirname, '..', 'adminRefunds.js'), 'utf8');
const migrationSource = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '012_stripe_refunds.sql'),
  'utf8'
);

function makeDb({ balance = 1000, depositAmount = 1000, fee = 0 } = {}) {
  const userId = uuidv4();
  const walletId = uuidv4();
  const depositId = uuidv4();
  const intentId = 'pi_test_' + uuidv4().replace(/-/g, '').slice(0, 24);
  return {
    userId,
    walletId,
    depositId,
    intentId,
    db: {
      users: [{ id: userId, email: 'test@example.com', accountStatus: 'active' }],
      wallets: [{
        id: walletId,
        userId,
        balances: [{ currency: 'USD', amount: balance }],
        holdBalance: {},
      }],
      transactions: [{
        id: depositId,
        type: 'deposit',
        status: 'completed',
        toWalletId: walletId,
        amount: depositAmount,
        currency: 'USD',
        stripeIntentId: intentId,
        grossAmount: depositAmount + fee,
        feeAmount: fee,
        timestamp: Date.now() - 60_000,
      }],
      refundRequests: [],
      ledger: [],
    },
  };
}

test('migration 012 creates refund_requests and stripe_webhook_events', () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS refund_requests/);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS stripe_webhook_events/);
  assert.match(migrationSource, /stripe_payment_intent_id/);
  assert.match(migrationSource, /idempotency_key/);
  assert.match(migrationSource, /status_history/);
});

test('webhook route handles refund.created/updated/failed and charge.refunded', () => {
  assert.match(indexSource, /refund\.created/);
  assert.match(indexSource, /refund\.updated/);
  assert.match(indexSource, /refund\.failed/);
  assert.match(indexSource, /charge\.refunded/);
  assert.match(indexSource, /reserveStripeWebhookEvent/);
  assert.match(indexSource, /applyStripeRefundObject/);
});

test('user and admin routers reject destination card redirection', () => {
  assert.match(routerSource, /DESTINATION_NOT_ALLOWED/);
  assert.match(routerSource, /original_payment_method_only/);
  assert.match(adminSource, /REFUND_REDIRECT_FORBIDDEN/);
  assert.match(adminSource, /original_payment_method_only/);
});

test('computeStripeRefundAmount: full remaining uses Stripe remaining', () => {
  assert.equal(computeStripeRefundAmount({
    walletAmount: 1000, depositNet: 1000, depositGross: 1015, stripeRemaining: 1015,
  }), 1015);
});

test('computeStripeRefundAmount: partial is proportional and capped', () => {
  const amt = computeStripeRefundAmount({
    walletAmount: 500, depositNet: 1000, depositGross: 1000, stripeRemaining: 1000,
  });
  assert.equal(amt, 500);
  const capped = computeStripeRefundAmount({
    walletAmount: 900, depositNet: 1000, depositGross: 1000, stripeRemaining: 100,
  });
  assert.equal(capped, 100);
});

test('createRefundRequest places hold and reduces spendable balance', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  const result = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'key-1',
    stripeRefundAmount: 1000,
  });
  assert.equal(result.replay, false);
  assert.equal(result.refund.status, 'requested');
  assert.equal(result.refund.holdPlaced, true);
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(db.wallets[0].holdBalance.USD, 1000);
  assert.ok(db.ledger.some((l) => l.type === 'deposit_refund_hold'));
});

test('held funds cannot be spent — available balance already decremented', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 600,
    idempotencyKey: 'key-hold',
    stripeRefundAmount: 600,
  });
  assert.equal(db.wallets[0].balances[0].amount, 400);
  // A second refund for the remaining 400 of deposit is ok for refundable calc,
  // but wallet only has 400 available.
  assert.equal(getWalletRefundableAmount(db, db.transactions[0]), 400);
});

test('over-refund of deposit net is rejected', () => {
  const { db, userId, depositId } = makeDb({ balance: 2000, depositAmount: 1000 });
  createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 700,
    idempotencyKey: 'k1',
    stripeRefundAmount: 700,
  });
  assert.throws(
    () => createRefundRequest(db, userId, {
      depositTransactionId: depositId,
      amount: 400,
      idempotencyKey: 'k2',
      stripeRefundAmount: 400,
    }),
    (err) => err.errorCode === 'AMOUNT_EXCEEDS_REFUNDABLE'
  );
});

test('idempotent replay returns same refund for same client key', () => {
  const { db, userId, depositId } = makeDb();
  const a = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 500,
    idempotencyKey: 'same-key',
    stripeRefundAmount: 500,
  });
  const b = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 500,
    idempotencyKey: 'same-key',
    stripeRefundAmount: 500,
  });
  assert.equal(b.replay, true);
  assert.equal(b.refund.id, a.refund.id);
  assert.equal(db.refundRequests.length, 1);
  assert.equal(db.wallets[0].balances[0].amount, 500); // hold applied once
});

test('Stripe success finalizes debit without restoring balance', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'ok',
    stripeRefundAmount: 1000,
  });
  markRefundSubmitted(db, refund.id, {
    stripeRefundId: 're_test_1',
    stripeStatus: 'succeeded',
  });
  assert.equal(refund.status, 'succeeded');
  assert.equal(refund.walletDebited, true);
  assert.equal(refund.holdReleased, true);
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(db.wallets[0].holdBalance.USD, 0);
  assert.ok(db.ledger.some((l) => l.type === 'deposit_refund_debit'));
  assert.ok(db.transactions.some((t) => t.type === 'deposit_refund' && t.refundRequestId === refund.id));
});

test('Stripe failure restores wallet balance completely', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'fail',
    stripeRefundAmount: 1000,
  });
  markRefundFailed(db, refund.id, 'card_declined');
  assert.equal(refund.status, 'failed');
  assert.equal(db.wallets[0].balances[0].amount, 1000);
  assert.equal(db.wallets[0].holdBalance.USD, 0);
  assert.equal(refund.walletDebited, false);
  assert.ok(db.ledger.some((l) => l.type === 'deposit_refund_release'));
});

test('cancel before Stripe submit restores balance', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 400,
    idempotencyKey: 'cancel',
    stripeRefundAmount: 400,
  });
  markRefundCancelled(db, refund.id, 'user_cancel', { by: 'user' });
  assert.equal(refund.status, 'cancelled');
  assert.equal(db.wallets[0].balances[0].amount, 1000);
});

test('webhook replay does not double-debit', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'wh',
    stripeRefundAmount: 1000,
  });
  const stripeRefund = {
    id: 're_abc',
    status: 'succeeded',
    metadata: { refundRequestId: refund.id },
  };
  applyStripeRefundObject(db, stripeRefund, 'refund.updated');
  applyStripeRefundObject(db, stripeRefund, 'refund.updated');
  applyStripeRefundObject(db, stripeRefund, 'charge.refunded');
  assert.equal(db.wallets[0].balances[0].amount, 0);
  const debitLedgers = db.ledger.filter((l) => l.type === 'deposit_refund_debit');
  assert.equal(debitLedgers.length, 1);
});

test('out-of-order failed-after-success does not restore balance', () => {
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'ooo',
    stripeRefundAmount: 1000,
  });
  markRefundSucceeded(db, refund.id, { stripeRefundId: 're_x' });
  markRefundFailed(db, refund.id, 'late failure event');
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.ok(refund.reconciliationResult?.conflict === 'failed_after_success');
});

test('sanitizeRefundForResponse never exposes destination card fields', () => {
  const sanitized = sanitizeRefundForResponse({
    id: 'r1', userId: 'u', walletId: 'w', depositTransactionId: 'd',
    stripePaymentIntentId: 'pi_x', stripeRefundId: 're_x',
    amount: 10, stripeRefundAmount: 10, currency: 'USD', status: 'pending',
    statusHistory: [], holdPlaced: true, holdReleased: false, walletDebited: false,
    failureReason: null, stripeStatus: 'pending', reconciliationResult: null,
    createdAt: 1, updatedAt: 1, completedAt: null,
    cardNumber: '4111111111111111', destination: 'should-not-leak',
  });
  assert.equal(sanitized.cardNumber, undefined);
  assert.equal(sanitized.destination, undefined);
  assert.equal(sanitized.stripePaymentIntentId, 'pi_x');
});

test('refund window rejects old deposits', () => {
  const { db, userId, depositId } = makeDb();
  db.transactions[0].timestamp = Date.now() - (200 * 24 * 60 * 60 * 1000);
  assert.equal(isWithinRefundWindow(db.transactions[0]), false);
  assert.throws(
    () => createRefundRequest(db, userId, {
      depositTransactionId: depositId,
      amount: 100,
      idempotencyKey: 'old',
      stripeRefundAmount: 100,
    }),
    (err) => err.errorCode === 'REFUND_WINDOW_EXPIRED'
  );
});

test('non-Stripe deposits cannot be refunded to a card', () => {
  const { db, userId, depositId } = makeDb();
  db.transactions[0].stripeIntentId = null;
  assert.throws(
    () => createRefundRequest(db, userId, {
      depositTransactionId: depositId,
      amount: 100,
      idempotencyKey: 'nostripe',
      stripeRefundAmount: 100,
    }),
    (err) => err.errorCode === 'NOT_STRIPE_DEPOSIT'
  );
});

test('ownership check rejects other users deposits', () => {
  const { db, depositId } = makeDb();
  assert.throws(
    () => createRefundRequest(db, uuidv4(), {
      depositTransactionId: depositId,
      amount: 100,
      idempotencyKey: 'other',
      stripeRefundAmount: 100,
    }),
    (err) => err.status === 404 || err.errorCode === 'WALLET_NOT_FOUND'
  );
});

test('$10 case math: full refund holds 1000, success → 0, failure → 1000', () => {
  // Exact scenario for buah@buah.com USD $10.00 without executing live.
  const { db, userId, depositId } = makeDb({ balance: 1000, depositAmount: 1000 });
  assert.equal(getWalletRefundableAmount(db, db.transactions[0]), 1000);

  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'buah-10',
    stripeRefundAmount: 1000,
  });
  assert.equal(refund.amount, 1000);
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(db.wallets[0].holdBalance.USD, 1000);

  // Failure path restores.
  markRefundFailed(db, refund.id, 'simulated');
  assert.equal(db.wallets[0].balances[0].amount, 1000);

  // Re-create after failure (new key) and succeed → $0.
  const again = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'buah-10-retry',
    stripeRefundAmount: 1000,
  });
  markRefundSucceeded(db, again.refund.id, { stripeRefundId: 're_buah' });
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(getWalletRefundableAmount(db, db.transactions[0]), 0);
});
