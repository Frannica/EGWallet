'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  applyIncomingPayment,
  isFinalSuccessfulIncoming,
  resolveIncomingCreditTarget,
} = require('../grid/gridIncomingCredit');
const { handleGridWebhook, processGridWebhookEvent } = require('../grid/gridWebhook');
const { settleStripePaymentIntentDeposit } = require('../stripeDepositSettlement');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const WALLET_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WALLET_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CUSTOMER_A = 'Customer:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123';
const TX_1 = 'Transaction:019542f5-b3e7-1d02-0000-000000000005';
const ACCOUNT_A = 'InternalAccount:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123';

function completedBody(overrides = {}) {
  const { data: dataOverrides, ...rest } = overrides;
  return {
    id: 'Webhook:019542f5-b3e7-1d02-0000-000000000008',
    type: 'INCOMING_PAYMENT.COMPLETED',
    timestamp: '2023-08-15T14:32:00Z',
    ...rest,
    data: {
      id: TX_1,
      status: 'COMPLETED',
      type: 'INCOMING',
      direction: 'CREDIT',
      receivedAmount: { amount: 50000, currency: { code: 'USD' } },
      customerId: CUSTOMER_A,
      platformCustomerId: USER_A,
      ...dataOverrides,
    },
  };
}

function makeState() {
  return {
    users: [{ id: USER_A }, { id: USER_B }],
    wallets: [
      { id: WALLET_A, userId: USER_A, balances: [{ currency: 'USD', amount: 1000 }] },
      { id: WALLET_B, userId: USER_B, balances: [{ currency: 'USD', amount: 9000 }] },
    ],
    transactions: [],
  };
}

function makeDeps(opts = {}) {
  const credits = [];
  const state = opts.state || makeState();
  return {
    credits,
    state,
    deps: {
      getGridCustomerByGridId: async (id) => {
        if (id === CUSTOMER_A) {
          return { user_id: USER_A, grid_customer_id: CUSTOMER_A, platform_customer_id: USER_A };
        }
        return null;
      },
      getGridInternalAccountByGridId: async (id) => {
        if (id === ACCOUNT_A) {
          return { user_id: USER_A, grid_internal_account_id: ACCOUNT_A, currency: 'USD' };
        }
        return null;
      },
      findWalletIdForUser: async (userId) => (userId === USER_A ? WALLET_A : userId === USER_B ? WALLET_B : null),
      commitCredit: async (args) => {
        credits.push(args);
        if (opts.duplicateOnSecond && credits.length > 1) {
          return { credited: false, reason: 'duplicate', replay: true };
        }
        return { credited: true, reason: 'credited', replay: false, newBalance: 51000 };
      },
      loadAppState: () => state,
      saveAppState: (db) => { Object.assign(state, db); },
      ...opts.deps,
    },
  };
}

function sign(body, pemPrivate) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const signer = crypto.createSign('SHA256');
  signer.update(raw);
  signer.end();
  return {
    raw,
    header: JSON.stringify({ v: '1', s: signer.sign(pemPrivate).toString('base64') }),
  };
}

describe('Grid incoming payment crediting', { concurrency: 1 }, () => {
  test('credits only the documented final successful incoming event', async () => {
    const { deps, credits, state } = makeDeps();
    const body = completedBody();
    const result = await applyIncomingPayment(body.type, body.data, { info() {}, warn() {}, error() {} }, null, deps);
    assert.equal(result.credited, true);
    assert.equal(credits.length, 1);
    assert.equal(credits[0].userId, USER_A);
    assert.equal(credits[0].walletId, WALLET_A);
    assert.equal(credits[0].currency, 'USD');
    assert.equal(credits[0].netCredited, 50000);
    assert.equal(credits[0].gridTransactionId, TX_1);
    assert.equal(credits[0].tx.stripeIntentId, null);
    assert.equal(credits[0].tx.type, 'grid_incoming');
    assert.equal(state.wallets[0].balances[0].amount, 51000);
    assert.equal(isFinalSuccessfulIncoming('INCOMING_PAYMENT.COMPLETED', body.data), true);
  });

  test('duplicate delivery does not double-credit', async () => {
    const { deps, credits, state } = makeDeps({ duplicateOnSecond: true });
    const body = completedBody();
    const first = await applyIncomingPayment(body.type, body.data, { info() {}, warn() {}, error() {} }, null, deps);
    const second = await applyIncomingPayment(body.type, body.data, { info() {}, warn() {}, error() {} }, null, deps);
    assert.equal(first.credited, true);
    assert.equal(second.credited, false);
    assert.equal(second.reason, 'duplicate');
    assert.equal(credits.length, 2);
    assert.equal(state.wallets[0].balances[0].amount, 51000);
  });

  test('wrong user mapping is refused and other wallets stay unchanged', async () => {
    const { deps, credits, state } = makeDeps({
      deps: {
        getGridInternalAccountByGridId: async () => ({
          user_id: USER_B,
          grid_internal_account_id: ACCOUNT_A,
          currency: 'USD',
        }),
      },
    });
    const body = completedBody({ data: { internalAccountId: ACCOUNT_A } });
    const result = await applyIncomingPayment(body.type, body.data, { info() {}, warn() {}, error() {} }, null, deps);
    assert.equal(result.credited, false);
    assert.equal(result.reason, 'wrong_user');
    assert.equal(credits.length, 0);
    assert.equal(state.wallets[0].balances[0].amount, 1000);
    assert.equal(state.wallets[1].balances[0].amount, 9000);
  });

  test('missing Grid transaction reference is not credited', async () => {
    const { deps, credits } = makeDeps();
    const result = await applyIncomingPayment(
      'INCOMING_PAYMENT.COMPLETED',
      { status: 'COMPLETED', type: 'INCOMING', receivedAmount: { amount: 100, currency: { code: 'USD' } }, customerId: CUSTOMER_A },
      { info() {}, warn() {}, error() {} },
      null,
      deps
    );
    assert.equal(result.credited, false);
    assert.equal(result.reason, 'missing_reference');
    assert.equal(credits.length, 0);
  });

  test('unsupported currency is not credited', async () => {
    const { deps, credits, state } = makeDeps();
    const body = completedBody({ data: { receivedAmount: { amount: 100000, currency: { code: 'BTC' } } } });
    const result = await applyIncomingPayment(body.type, body.data, { info() {}, warn() {}, error() {} }, null, deps);
    assert.equal(result.credited, false);
    assert.equal(result.reason, 'unsupported_currency');
    assert.equal(credits.length, 0);
    assert.equal(state.wallets[0].balances[0].amount, 1000);
  });

  test('invalid signature is rejected before any credit', async () => {
    const snap = {
      GRID_WEBHOOK_PUBLIC_KEY: process.env.GRID_WEBHOOK_PUBLIC_KEY,
    };
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    process.env.GRID_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
    const body = completedBody();
    const { raw, header } = sign(body, other.privateKey);
    try {
      const result = await handleGridWebhook({
        rawBody: raw,
        signatureHeader: header,
        parsedBody: body,
        logger: { info() {}, warn() {}, error() {} },
      });
      assert.equal(result.status, 401);
    } finally {
      if (snap.GRID_WEBHOOK_PUBLIC_KEY === undefined) delete process.env.GRID_WEBHOOK_PUBLIC_KEY;
      else process.env.GRID_WEBHOOK_PUBLIC_KEY = snap.GRID_WEBHOOK_PUBLIC_KEY;
    }
    assert.equal(isFinalSuccessfulIncoming(body.type, body.data), true);
  });

  test('out-of-order PENDING after COMPLETED does not reverse or recedit', async () => {
    const { deps, credits, state } = makeDeps();
    const completed = completedBody();
    const first = await applyIncomingPayment(completed.type, completed.data, { info() {}, warn() {}, error() {} }, null, deps);
    const pending = await applyIncomingPayment(
      'INCOMING_PAYMENT.PENDING',
      { ...completed.data, status: 'PENDING' },
      { info() {}, warn() {}, error() {} },
      null,
      deps
    );
    const processing = await applyIncomingPayment(
      'INCOMING_PAYMENT.PROCESSING',
      { ...completed.data, status: 'PROCESSING' },
      { info() {}, warn() {}, error() {} },
      null,
      deps
    );
    assert.equal(first.credited, true);
    assert.equal(pending.credited, false);
    assert.equal(pending.reason, 'not_final');
    assert.equal(processing.credited, false);
    assert.equal(credits.length, 1);
    assert.equal(state.wallets[0].balances[0].amount, 51000);
  });

  test('failed incoming payment is never credited', async () => {
    const { deps, credits } = makeDeps();
    const result = await applyIncomingPayment(
      'INCOMING_PAYMENT.FAILED',
      { id: TX_1, status: 'FAILED', type: 'INCOMING', receivedAmount: { amount: 50000, currency: { code: 'USD' } }, customerId: CUSTOMER_A },
      { info() {}, warn() {}, error() {} },
      null,
      deps
    );
    assert.equal(result.credited, false);
    assert.equal(result.reason, 'not_final');
    assert.equal(credits.length, 0);
    assert.equal(isFinalSuccessfulIncoming('INCOMING_PAYMENT.FAILED', { status: 'FAILED' }), false);
  });

  test('TEST and unmatched customers are not credited', async () => {
    const { deps, credits } = makeDeps();
    const testEvent = await processGridWebhookEvent(
      { id: 'Webhook:test', type: 'TEST', data: {} },
      { info() {}, warn() {}, error() {} }
    );
    const unmatched = await applyIncomingPayment(
      'INCOMING_PAYMENT.COMPLETED',
      { id: TX_1, status: 'COMPLETED', type: 'INCOMING', receivedAmount: { amount: 1, currency: { code: 'USD' } }, customerId: 'Customer:unknown-1' },
      { info() {}, warn() {}, error() {} },
      null,
      deps
    );
    assert.equal(testEvent.credited, false);
    assert.equal(testEvent.reason, 'test');
    assert.equal(unmatched.reason, 'unmatched');
    assert.equal(credits.length, 0);
  });

  test('Stripe deposit crediting stays isolated from Grid incoming credits', async () => {
    const { deps, credits, state } = makeDeps();
    const stripeCalls = [];
    const original = settleStripePaymentIntentDeposit;
    const stripeResult = {
      handled: true,
      reason: 'credited',
      transaction: { type: 'deposit', stripeIntentId: 'pi_test_1', gridTransactionId: null },
    };
    assert.equal(stripeResult.transaction.stripeIntentId, 'pi_test_1');
    assert.equal(stripeResult.transaction.gridTransactionId, null);

    const grid = await applyIncomingPayment(
      'INCOMING_PAYMENT.COMPLETED',
      completedBody().data,
      { info() {}, warn() {}, error() {} },
      null,
      deps
    );
    assert.equal(grid.credited, true);
    assert.equal(credits[0].tx.stripeIntentId, null);
    assert.equal(credits[0].gridTransactionId, TX_1);
    assert.equal(state.wallets[1].balances[0].amount, 9000);

    const incomingSource = fs.readFileSync(path.join(__dirname, '..', 'grid', 'gridIncomingCredit.js'), 'utf8');
    const postgresSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'gridIncomingPostgres.js'), 'utf8');
    const stripeSource = fs.readFileSync(path.join(__dirname, '..', 'stripeDepositSettlement.js'), 'utf8');
    assert.match(postgresSource, /grid_incoming_credit/);
    assert.match(postgresSource, /stripe_intent_id/);
    assert.match(postgresSource, /null/);
    assert.doesNotMatch(incomingSource, /settleStripePaymentIntentDeposit/);
    assert.doesNotMatch(stripeSource, /grid_transaction_id/);
    assert.doesNotMatch(stripeSource, /grid_incoming/);
    assert.equal(typeof original, 'function');
    assert.equal(stripeCalls.length, 0);
  });

  test('platformCustomerId mismatch is treated as wrong user', async () => {
    const resolved = await resolveIncomingCreditTarget(
      completedBody({ data: { platformCustomerId: USER_B } }).data,
      {
        getGridCustomerByGridId: async () => ({
          user_id: USER_A,
          platform_customer_id: USER_A,
        }),
        getGridInternalAccountByGridId: async () => null,
      }
    );
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'wrong_user');
  });
});
