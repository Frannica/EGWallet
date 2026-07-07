'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitDepositConfirmPostgres } = require('../../db/depositConfirmPostgres');
const { commitP2PSendPostgres } = require('../../db/p2pSendPostgres');
const { commitPaymentRequestPayPostgres } = require('../../db/paymentRequestPayPostgres');
const { commitExchangePostgres } = require('../../db/exchangePostgres');
const { getPostMutationBalance } = require('../../db/walletBalanceAlign');

function requireDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required');
  }
}

function buildStateDb(ids, balancesByWallet) {
  return {
    _dbVersion: 0,
    users: [
      { id: ids.users[0], email: `${ids.users[0]}@ledger.test`, passwordHash: 'x', region: 'US', role: 'individual', createdAt: Date.now() },
      { id: ids.users[1], email: `${ids.users[1]}@ledger.test`, passwordHash: 'x', region: 'US', role: 'individual', createdAt: Date.now() },
    ],
    wallets: [
      {
        id: ids.wallets[0],
        userId: ids.users[0],
        balances: balancesByWallet[ids.wallets[0]] || [{ currency: 'USD', amount: 0 }],
        createdAt: Date.now(),
        maxLimitUSD: 250000,
      },
      {
        id: ids.wallets[1],
        userId: ids.users[1],
        balances: balancesByWallet[ids.wallets[1]] || [{ currency: 'USD', amount: 0 }],
        createdAt: Date.now(),
        maxLimitUSD: 250000,
      },
    ],
    paymentRequests: [
      {
        id: ids.requests[0],
        requesterId: ids.users[1],
        walletId: ids.wallets[1],
        amount: 30,
        currency: 'USD',
        memo: 'ledger chain',
        status: 'pending',
        type: 'personal_request',
        createdAt: Date.now(),
      },
    ],
    transactions: [],
    ledger: [],
    rates: { values: { USD: 1, EUR: 0.92 }, updatedAt: Date.now() },
  };
}

async function readPgBalance(client, walletId, currency) {
  const row = await client.query(
    'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
    [walletId, currency]
  );
  return row.rowCount > 0 ? Number(row.rows[0].amount) : 0;
}

async function cleanup(client, ids) {
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM ledger WHERE wallet_id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM payment_requests WHERE id = ANY($1::uuid[])', [ids.requests]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::uuid[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

function txPayload(id, fromWalletId, toWalletId, amount, currency, memo) {
  return {
    id,
    fromWalletId,
    toWalletId,
    amount,
    currency,
    debitAmount: amount,
    debitCurrency: currency,
    senderCrossCurrency: false,
    receivedAmount: amount,
    receivedCurrency: currency,
    wasConverted: false,
    fxFeeAmount: 0,
    sendFeeAmount: 0,
    memo,
    status: 'completed',
    timestamp: Date.now(),
  };
}

test('deposit → send → pay request → exchange keeps JSON and PostgreSQL aligned', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [uuidv4()],
    transactions: [uuidv4(), uuidv4(), uuidv4(), uuidv4()],
  };

  try {
    let stateDb = buildStateDb(ids, {
      [ids.wallets[0]]: [{ currency: 'USD', amount: 0 }],
      [ids.wallets[1]]: [{ currency: 'USD', amount: 0 }],
    });

    // 1) Deposit 100 minor ($1.00)
    const payerWallet = stateDb.wallets.find((w) => w.id === ids.wallets[0]);
    payerWallet.balances[0].amount += 100;
    stateDb.transactions.push({
      id: ids.transactions[0],
      type: 'deposit',
      fromWalletId: null,
      toWalletId: ids.wallets[0],
      amount: 100,
      currency: 'USD',
      receivedAmount: 100,
      receivedCurrency: 'USD',
      status: 'completed',
      timestamp: Date.now(),
      stripeIntentId: `pi-ledger-${ids.transactions[0]}`,
    });

    const depositRes = await commitDepositConfirmPostgres({
      walletId: ids.wallets[0],
      currency: 'USD',
      netCredited: 100,
      tx: stateDb.transactions[0],
      userId: ids.users[0],
      intentId: stateDb.transactions[0].stripeIntentId,
      stateDb,
    });
    assert.equal(depositRes.replay, undefined);

    let jsonUsd = getPostMutationBalance(stateDb, ids.wallets[0], 'USD');
    let pgUsd = await readPgBalance(client, ids.wallets[0], 'USD');
    assert.equal(jsonUsd, 100);
    assert.equal(pgUsd, 100);

    // 2) Send 40 minor
    payerWallet.balances[0].amount -= 40;
    const receiverWallet = stateDb.wallets.find((w) => w.id === ids.wallets[1]);
    receiverWallet.balances[0].amount += 40;

    const sendRes = await commitP2PSendPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 40,
      receivedCurrency: 'USD',
      receivedAmount: 40,
      tx: txPayload(ids.transactions[1], ids.wallets[0], ids.wallets[1], 40, 'USD', 'ledger-send'),
      clientKey: `ledger-send-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb,
      recipientUserId: ids.users[1],
    });
    assert.equal(sendRes.insufficientFunds, false);

    jsonUsd = getPostMutationBalance(stateDb, ids.wallets[0], 'USD');
    pgUsd = await readPgBalance(client, ids.wallets[0], 'USD');
    assert.equal(jsonUsd, 60);
    assert.equal(pgUsd, 60);

    // 3) Pay request 30 minor
    payerWallet.balances[0].amount -= 30;
    receiverWallet.balances[0].amount += 30;
    stateDb.paymentRequests[0].status = 'paid';

    const payRes = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      debitCurrency: 'USD',
      debitAmount: 30,
      requestCurrency: 'USD',
      requestAmount: 30,
      tx: txPayload(ids.transactions[2], ids.wallets[0], ids.wallets[1], 30, 'USD', 'ledger-pay'),
      clientKey: `ledger-pay-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      payerLimitTracking: null,
      employerPayrollLimitTracking: null,
      employerId: null,
      stateDb,
    });
    assert.equal(payRes.insufficientFunds, undefined);

    jsonUsd = getPostMutationBalance(stateDb, ids.wallets[0], 'USD');
    pgUsd = await readPgBalance(client, ids.wallets[0], 'USD');
    assert.equal(jsonUsd, 30);
    assert.equal(pgUsd, 30);

    // 4) Exchange 10 USD minor → EUR (netReceived 9 minor after fee in test payload)
    const fromBal = payerWallet.balances.find((b) => b.currency === 'USD');
    fromBal.amount -= 10;
    let eurBal = payerWallet.balances.find((b) => b.currency === 'EUR');
    const netReceived = 9;
    if (eurBal) eurBal.amount += netReceived;
    else payerWallet.balances.push({ currency: 'EUR', amount: netReceived });

    const exchangeRes = await commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amount: 10,
      netReceived,
      tx: {
        id: ids.transactions[3],
        type: 'exchange',
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[0],
        amount: 10,
        currency: 'USD',
        receivedAmount: netReceived,
        receivedCurrency: 'EUR',
        wasConverted: true,
        fxFeeAmount: 1,
        sendFeeAmount: 0,
        memo: '',
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: `ledger-ex-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb,
    });
    assert.equal(exchangeRes.insufficientFunds, false);

    jsonUsd = getPostMutationBalance(stateDb, ids.wallets[0], 'USD');
    pgUsd = await readPgBalance(client, ids.wallets[0], 'USD');
    const jsonEur = getPostMutationBalance(stateDb, ids.wallets[0], 'EUR');
    const pgEur = await readPgBalance(client, ids.wallets[0], 'EUR');
    assert.equal(jsonUsd, 20);
    assert.equal(pgUsd, 20);
    assert.equal(jsonEur, 9);
    assert.equal(pgEur, 9);
  } finally {
    await cleanup(client, ids);
    client.release();
  }
});

test('reconciles legacy postgres drift (0) to JSON truth before exchange', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    users: [uuidv4()],
    wallets: [uuidv4()],
    transactions: [uuidv4()],
  };

  try {
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at)
       VALUES ($1, $2, 'x', 'US', 'individual', NOW())`,
      [ids.users[0], `${ids.users[0]}@drift.test`]
    );
    await client.query(
      `INSERT INTO wallets (id, user_id, created_at, max_limit_usd)
       VALUES ($1, $2, NOW(), 250000)`,
      [ids.wallets[0], ids.users[0]]
    );
    await client.query(
      `INSERT INTO wallet_balances (wallet_id, currency, amount)
       VALUES ($1, 'USD', 0)`,
      [ids.wallets[0]]
    );

    const stateDb = {
      wallets: [
        {
          id: ids.wallets[0],
          userId: ids.users[0],
          balances: [{ currency: 'USD', amount: 20 }],
          createdAt: Date.now(),
        },
      ],
    };

    const wallet = stateDb.wallets[0];
    wallet.balances[0].amount -= 10;
    wallet.balances.push({ currency: 'EUR', amount: 9 });

    const result = await commitExchangePostgres({
      walletId: ids.wallets[0],
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amount: 10,
      netReceived: 9,
      tx: {
        id: ids.transactions[0],
        type: 'exchange',
        fromWalletId: ids.wallets[0],
        toWalletId: ids.wallets[0],
        amount: 10,
        currency: 'USD',
        receivedAmount: 9,
        receivedCurrency: 'EUR',
        wasConverted: true,
        fxFeeAmount: 1,
        status: 'completed',
        timestamp: Date.now(),
      },
      clientKey: `ledger-drift-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      senderLimitTracking: null,
      stateDb,
    });

    assert.equal(result.insufficientFunds, false);
    assert.equal(await readPgBalance(client, ids.wallets[0], 'USD'), 20);
    assert.equal(await readPgBalance(client, ids.wallets[0], 'EUR'), 9);
    assert.equal(getPostMutationBalance(stateDb, ids.wallets[0], 'USD'), 20);
    assert.equal(getPostMutationBalance(stateDb, ids.wallets[0], 'EUR'), 9);
  } finally {
    await client.query('DELETE FROM ledger WHERE wallet_id = ANY($1::uuid[])', [ids.wallets]);
    await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
    await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::uuid[])', [ids.wallets]);
    await client.query('DELETE FROM wallets WHERE id = ANY($1::uuid[])', [ids.wallets]);
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
    client.release();
  }
});
