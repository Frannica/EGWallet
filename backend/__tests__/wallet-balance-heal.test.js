'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  setJsonAvailableBalance,
  setJsonHoldBalance,
  healJsonBalancesFromPostgres,
} = require('../db/walletBalanceHeal');

describe('walletBalanceHeal', () => {
  test('setJsonAvailableBalance updates existing currency', () => {
    const db = {
      wallets: [{ id: 'w1', balances: [{ currency: 'USD', amount: 500 }] }],
    };
    assert.equal(setJsonAvailableBalance(db, 'w1', 'USD', 1000), true);
    assert.equal(db.wallets[0].balances[0].amount, 1000);
    assert.equal(setJsonAvailableBalance(db, 'w1', 'USD', 1000), false);
  });

  test('setJsonAvailableBalance creates missing currency entry', () => {
    const db = { wallets: [{ id: 'w1', balances: [] }] };
    assert.equal(setJsonAvailableBalance(db, 'w1', 'EUR', 5), true);
    assert.equal(db.wallets[0].balances.find((b) => b.currency === 'EUR').amount, 5);
  });

  test('setJsonHoldBalance writes and clears holds', () => {
    const db = { wallets: [{ id: 'w1', balances: [], holdBalance: { USD: 100 } }] };
    assert.equal(setJsonHoldBalance(db, 'w1', 'USD', 0), true);
    assert.equal(db.wallets[0].holdBalance.USD, undefined);
    assert.equal(setJsonHoldBalance(db, 'w1', 'XAF', 6000), true);
    assert.equal(db.wallets[0].holdBalance.XAF, 6000);
  });

  test('healJsonBalancesFromPostgres overwrites JSON from fake pool', async () => {
    const db = {
      wallets: [
        {
          id: 'w1',
          balances: [
            { currency: 'USD', amount: 999 },
            { currency: 'XAF', amount: 0 },
          ],
          holdBalance: { USD: 50 },
        },
      ],
    };
    const fakePool = {
      async query(sql) {
        if (sql.includes('wallet_balances')) {
          return {
            rowCount: 2,
            rows: [
              { wallet_id: 'w1', currency: 'USD', amount: 1000 },
              { wallet_id: 'w1', currency: 'XAF', amount: 6000 },
            ],
          };
        }
        return {
          rowCount: 1,
          rows: [{ wallet_id: 'w1', currency: 'USD', amount: 0 }],
        };
      },
    };
    const result = await healJsonBalancesFromPostgres(db, { dbPool: fakePool });
    assert.ok(result.changed >= 2);
    assert.equal(db.wallets[0].balances.find((b) => b.currency === 'USD').amount, 1000);
    assert.equal(db.wallets[0].balances.find((b) => b.currency === 'XAF').amount, 6000);
    assert.equal(db.wallets[0].holdBalance.USD, undefined);
  });
});
