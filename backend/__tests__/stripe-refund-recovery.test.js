'use strict';
/**
 * Refund recovery / idempotency proofs for the 502-after-Stripe-success defect.
 * No live Stripe network calls — stripe client is mocked.
 */
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_for_unit_tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  createRefundRequest,
  markRefundSubmitted,
  markRefundSucceeded,
  markRefundFailed,
  applyStripeRefundObject,
} = require('../refundEngine');

const {
  findStripeRefundForRequest,
  resolveStripeRefundAfterCreateError,
  buildRefundLedgerNarrative,
} = require('../refundStripeSafety');

const routerSource = fs.readFileSync(path.join(__dirname, '..', 'refundsRouter.js'), 'utf8');

function makeDb({ balance = 1000, depositAmount = 1000 } = {}) {
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
      users: [{ id: userId, email: 'rec@example.com', accountStatus: 'active' }],
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
        grossAmount: depositAmount,
        feeAmount: 0,
        timestamp: Date.now() - 60_000,
      }],
      refundRequests: [],
      ledger: [],
    },
  };
}

test('router source re-queries Stripe before releasing hold on create error', () => {
  assert.match(routerSource, /resolveStripeRefundAfterCreateError/);
  assert.match(routerSource, /REFUND_PENDING_STRIPE_VERIFY/);
  assert.match(routerSource, /re-querying before any hold release/);
});

test('timeout-after-Stripe-success: re-query finds refund and settle never restores', async () => {
  const { db, userId, depositId, intentId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'to-success',
    stripeRefundAmount: 1000,
  });
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(db.wallets[0].holdBalance.USD, 1000);

  const stripeRefund = {
    id: 're_timeout_ok',
    amount: 1000,
    status: 'succeeded',
    metadata: { refundRequestId: refund.id, egwalletRefundId: refund.id },
  };
  const stripeClient = {
    refunds: {
      list: async () => ({ data: [stripeRefund] }),
    },
  };

  const resolution = await resolveStripeRefundAfterCreateError(stripeClient, {
    refundId: refund.id,
    paymentIntentId: intentId,
    stripeAmount: 1000,
    error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  });
  assert.ok(resolution.stripeRefund);
  assert.equal(resolution.safeToReleaseHold, false);

  markRefundSubmitted(db, refund.id, {
    stripeRefundId: resolution.stripeRefund.id,
    stripeStatus: resolution.stripeRefund.status,
    by: 'stripe',
  });
  assert.equal(refund.status, 'succeeded');
  assert.equal(refund.walletDebited, true);
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(db.wallets[0].holdBalance.USD, 0);
  assert.ok(!db.ledger.some((l) => l.type === 'deposit_refund_release'));
  assert.ok(db.ledger.some((l) => l.type === 'deposit_refund_debit'));
});

test('create error with confirmed empty Stripe list may release hold', async () => {
  const stripeClient = {
    refunds: { list: async () => ({ data: [] }) },
  };
  const resolution = await resolveStripeRefundAfterCreateError(stripeClient, {
    refundId: 'r1',
    paymentIntentId: 'pi_x',
    stripeAmount: 1000,
    error: new Error('card_declined'),
  });
  assert.equal(resolution.safeToReleaseHold, true);
  assert.equal(resolution.stripeRefund, null);
});

test('Stripe re-query failure keeps hold (safeToReleaseHold false)', async () => {
  const stripeClient = {
    refunds: {
      list: async () => { throw new Error('stripe_down'); },
    },
  };
  const resolution = await resolveStripeRefundAfterCreateError(stripeClient, {
    refundId: 'r1',
    paymentIntentId: 'pi_x',
    stripeAmount: 1000,
    error: new Error('upstream 502'),
  });
  assert.equal(resolution.safeToReleaseHold, false);
  assert.equal(resolution.reason, 'stripe_requery_failed');
});

test('false local failure then webhook success re-debits (no double credit)', () => {
  const { db, userId, depositId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'false-fail',
    stripeRefundAmount: 1000,
  });
  // Bug simulation: local failure restored funds while Stripe actually succeeded.
  markRefundFailed(db, refund.id, 'idempotency noise / 502 mis-handled');
  assert.equal(db.wallets[0].balances[0].amount, 1000);
  assert.equal(refund.status, 'failed');

  applyStripeRefundObject(db, {
    id: 're_real',
    status: 'succeeded',
    metadata: { refundRequestId: refund.id },
  }, 'refund.updated');

  assert.equal(refund.status, 'succeeded');
  assert.equal(refund.walletDebited, true);
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.ok(db.ledger.some((l) => l.type === 'deposit_refund_release'));
  assert.ok(db.ledger.some((l) => l.type === 'deposit_refund_redebit'));
});

test('duplicate webhooks after redebit do not double-debit', () => {
  const { db, userId, depositId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'dup-wh',
    stripeRefundAmount: 1000,
  });
  markRefundFailed(db, refund.id, 'simulated false fail');
  const stripeRefund = {
    id: 're_dup',
    status: 'succeeded',
    metadata: { refundRequestId: refund.id },
  };
  applyStripeRefundObject(db, stripeRefund, 'refund.updated');
  applyStripeRefundObject(db, stripeRefund, 'refund.updated');
  applyStripeRefundObject(db, stripeRefund, 'charge.refunded');
  assert.equal(db.wallets[0].balances[0].amount, 0);
  const redebits = db.ledger.filter((l) => l.type === 'deposit_refund_redebit');
  assert.equal(redebits.length, 1);
});

test('simultaneous API settle + webhook: no double debit on normal success path', () => {
  const { db, userId, depositId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'race',
    stripeRefundAmount: 1000,
  });
  const stripeRefund = {
    id: 're_race',
    status: 'succeeded',
    metadata: { refundRequestId: refund.id },
  };
  markRefundSubmitted(db, refund.id, {
    stripeRefundId: stripeRefund.id,
    stripeStatus: 'succeeded',
    by: 'stripe_api',
  });
  applyStripeRefundObject(db, stripeRefund, 'refund.updated');
  applyStripeRefundObject(db, stripeRefund, 'charge.refunded');
  assert.equal(db.wallets[0].balances[0].amount, 0);
  const debits = db.ledger.filter((l) =>
    l.type === 'deposit_refund_debit' || l.type === 'deposit_refund_redebit'
  );
  assert.equal(debits.length, 1);
});

test('process crash after Stripe success: markRefundSubmitted recovers from requested', () => {
  const { db, userId, depositId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 500,
    idempotencyKey: 'crash',
    stripeRefundAmount: 500,
  });
  // Crash before markRefundSubmitted — hold still open, status requested.
  assert.equal(refund.status, 'requested');
  markRefundSubmitted(db, refund.id, {
    stripeRefundId: 're_crash',
    stripeStatus: 'succeeded',
    by: 'recovery',
  });
  assert.equal(refund.status, 'succeeded');
  assert.equal(db.wallets[0].balances[0].amount, 500); // 1000-500
  assert.equal(db.wallets[0].holdBalance.USD, 0);
});

test('database failure simulation: second settle is idempotent (walletDebited guard)', () => {
  const { db, userId, depositId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'dbfail',
    stripeRefundAmount: 1000,
  });
  markRefundSucceeded(db, refund.id, { stripeRefundId: 're_db' });
  const balAfterFirst = db.wallets[0].balances[0].amount;
  markRefundSucceeded(db, refund.id, { stripeRefundId: 're_db' });
  markRefundSubmitted(db, refund.id, { stripeRefundId: 're_db', stripeStatus: 'succeeded' });
  assert.equal(db.wallets[0].balances[0].amount, balAfterFirst);
  assert.equal(db.ledger.filter((l) => l.type === 'deposit_refund_debit').length, 1);
});

test('delayed webhook after API success is a no-op for balances', () => {
  const { db, userId, depositId } = makeDb();
  const { refund } = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'delay',
    stripeRefundAmount: 1000,
  });
  markRefundSubmitted(db, refund.id, {
    stripeRefundId: 're_delay',
    stripeStatus: 'succeeded',
    by: 'api',
  });
  const before = db.wallets[0].balances[0].amount;
  // Delayed webhook arrives later
  applyStripeRefundObject(db, {
    id: 're_delay',
    status: 'succeeded',
    metadata: { refundRequestId: refund.id },
  }, 'refund.updated');
  assert.equal(db.wallets[0].balances[0].amount, before);
});

test('duplicate client requests: same idempotency key replays without second hold', () => {
  const { db, userId, depositId } = makeDb();
  const a = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'same-key',
    stripeRefundAmount: 1000,
  });
  const b = createRefundRequest(db, userId, {
    depositTransactionId: depositId,
    amount: 1000,
    idempotencyKey: 'same-key',
    stripeRefundAmount: 1000,
  });
  assert.equal(b.replay, true);
  assert.equal(a.refund.id, b.refund.id);
  assert.equal(db.refundRequests.length, 1);
  assert.equal(db.wallets[0].balances[0].amount, 0);
  assert.equal(db.wallets[0].holdBalance.USD, 1000);
});

test('findStripeRefundForRequest matches metadata', async () => {
  const found = await findStripeRefundForRequest({
    refunds: {
      list: async () => ({
        data: [{
          id: 're_m',
          amount: 1000,
          status: 'succeeded',
          metadata: { egwalletRefundId: 'abc' },
        }],
      }),
    },
  }, { refundId: 'abc', paymentIntentId: 'pi_1', stripeAmount: 1000 });
  assert.equal(found.id, 're_m');
});

test('ledger narrative labels hold / temporary restoration / final debit', () => {
  const narrative = buildRefundLedgerNarrative([
    { id: '1', type: 'deposit_refund_hold', amount: 1000, balanceBefore: 1000, balanceAfter: 0, at: 1 },
    { id: '2', type: 'deposit_refund_release', amount: 1000, balanceBefore: 0, balanceAfter: 1000, at: 2 },
    { id: '3', type: 'deposit_refund_redebit', amount: 1000, balanceBefore: 1000, balanceAfter: 0, at: 3 },
  ]);
  assert.match(narrative[0].meaning, /Hold placed/i);
  assert.match(narrative[1].meaning, /temporarily restored/i);
  assert.match(narrative[2].meaning, /Recovery debit|re-debited/i);
});

test('idempotency error after success must not release when Stripe lists the refund', async () => {
  const stripeClient = {
    refunds: {
      list: async () => ({
        data: [{
          id: 're_idem',
          amount: 1000,
          status: 'succeeded',
          metadata: { refundRequestId: 'rid-1' },
        }],
      }),
    },
  };
  const resolution = await resolveStripeRefundAfterCreateError(stripeClient, {
    refundId: 'rid-1',
    paymentIntentId: 'pi_1',
    stripeAmount: 1000,
    error: Object.assign(
      new Error('Keys for idempotent requests can only be used with the same parameters'),
      { type: 'idempotency_error' }
    ),
  });
  assert.equal(resolution.safeToReleaseHold, false);
  assert.equal(resolution.stripeRefund.id, 're_idem');
});
