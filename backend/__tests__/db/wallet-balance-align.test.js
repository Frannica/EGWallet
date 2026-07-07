'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preOperationBalance, getPostMutationBalance } = require('../../db/walletBalanceAlign');

test('preOperationBalance recovers pre-debit amount from post-mutation state', () => {
  assert.equal(preOperationBalance(30, { debit: 10 }), 40);
  assert.equal(preOperationBalance(70, { credit: 20 }), 50);
  assert.equal(preOperationBalance(100, { debit: 40, credit: 10 }), 130);
});

test('getPostMutationBalance reads wallet snapshot', () => {
  const stateDb = {
    wallets: [
      {
        id: 'w1',
        balances: [{ currency: 'USD', amount: 30 }, { currency: 'EUR', amount: 5 }],
      },
    ],
  };
  assert.equal(getPostMutationBalance(stateDb, 'w1', 'USD'), 30);
  assert.equal(getPostMutationBalance(stateDb, 'w1', 'EUR'), 5);
  assert.equal(getPostMutationBalance(stateDb, 'missing', 'USD'), 0);
});
