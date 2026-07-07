'use strict';

function getPostMutationBalance(stateDb, walletId, currency) {
  const wallet = (stateDb?.wallets || []).find((w) => w.id === walletId);
  if (!wallet) return 0;
  const entry = (wallet.balances || []).find((b) => b.currency === currency);
  return Number(entry?.amount ?? 0);
}

function preOperationBalance(postMutation, { debit = 0, credit = 0 } = {}) {
  return Number(postMutation) + Number(debit) - Number(credit);
}

/**
 * Align wallet_balances to the pre-operation amount implied by in-memory state (JSON)
 * before a single incremental debit/credit in PostgreSQL.
 *
 * stateDb reflects post-mutation balances (after index.js applies the in-memory change).
 */
async function alignWalletBalanceBeforeMutation(
  client,
  walletId,
  currency,
  stateDb,
  { pendingDebit = 0, pendingCredit = 0 } = {}
) {
  const row = await client.query(
    'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
    [walletId, currency]
  );

  if (!stateDb) {
    if (row.rowCount === 0) {
      await client.query(
        'INSERT INTO wallet_balances(wallet_id, currency, amount) VALUES ($1, $2, 0)',
        [walletId, currency]
      );
      return { amount: 0, created: true, reconciled: false };
    }
    return {
      amount: Number(row.rows[0].amount),
      created: false,
      reconciled: false,
    };
  }

  const postMutation = getPostMutationBalance(stateDb, walletId, currency);
  const expectedBefore = preOperationBalance(postMutation, {
    debit: pendingDebit,
    credit: pendingCredit,
  });

  if (row.rowCount === 0) {
    await client.query(
      'INSERT INTO wallet_balances(wallet_id, currency, amount) VALUES ($1, $2, $3)',
      [walletId, currency, expectedBefore]
    );
    return { amount: expectedBefore, created: true, reconciled: false };
  }

  const current = Number(row.rows[0].amount);
  if (current !== expectedBefore) {
    await client.query(
      'UPDATE wallet_balances SET amount = $1 WHERE wallet_id = $2 AND currency = $3',
      [expectedBefore, walletId, currency]
    );
    return { amount: expectedBefore, created: false, reconciled: true };
  }

  return { amount: expectedBefore, created: false, reconciled: false };
}

module.exports = {
  getPostMutationBalance,
  preOperationBalance,
  alignWalletBalanceBeforeMutation,
};
