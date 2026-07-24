'use strict';

/**
 * SAFE, AUTHORITATIVE balance lock/read.
 *
 * PostgreSQL `wallet_balances` is the single source of truth for money.
 * This locks the row and returns the TRUE current amount.
 *
 * There is exactly ONE moment where JSON is allowed to influence Postgres:
 * the very first time a wallet/currency row is created (a pre-migration
 * wallet that has never been touched in the relational ledger before, so
 * there is no existing authoritative Postgres value to protect — JSON is
 * the only record of its history). `backfill`, if provided, supplies that
 * one-time seed value. Once the row exists, it is READ and adjusted with
 * relative deltas only — it is never again overwritten from JSON. This is
 * the fix for the dual-write desync bug: a stale or corrupted JSON blob
 * (e.g. after a crash between a Postgres COMMIT and the next
 * `saveAppState`) can no longer silently roll back a correct,
 * already-committed Postgres balance, because Postgres is never rewritten
 * from JSON once it has a real row.
 *
 * @param {object} backfill - optional { stateDb, pendingDebit, pendingCredit }
 *   used ONLY to seed a brand-new row on first creation.
 */
async function lockWalletBalanceRow(client, walletId, currency, backfill) {
  const row = await client.query(
    'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
    [walletId, currency]
  );
  if (row.rowCount === 0) {
    // Never seed a negative balance — if the JSON snapshot the caller
    // passed in doesn't actually reflect its own post-mutation contract
    // (e.g. an incomplete test fixture, or a currency credited for the
    // very first time), 0 is the only safe floor. wallet_balances also has
    // a DB-level CHECK(amount >= 0) that would otherwise reject the insert.
    const raw = backfill
      ? preOperationBalance(getPostMutationBalance(backfill.stateDb, walletId, currency), {
          debit: backfill.pendingDebit || 0,
          credit: backfill.pendingCredit || 0,
        })
      : 0;
    const seed = Math.max(0, raw);
    await client.query(
      'INSERT INTO wallet_balances(wallet_id, currency, amount) VALUES ($1, $2, $3)',
      [walletId, currency, seed]
    );
    return seed;
  }
  return Number(row.rows[0].amount);
}

/** Same as lockWalletBalanceRow but for the wallet_holds table (withdrawal holds). */
async function lockWalletHoldRow(client, walletId, currency) {
  const row = await client.query(
    'SELECT amount FROM wallet_holds WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
    [walletId, currency]
  );
  if (row.rowCount === 0) {
    await client.query(
      'INSERT INTO wallet_holds(wallet_id, currency, amount) VALUES ($1, $2, 0)',
      [walletId, currency]
    );
    return 0;
  }
  return Number(row.rows[0].amount);
}

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
 * @deprecated DANGEROUS — do not call this for new code. It reconstructs a
 * "pre-operation" balance from the JSON state and OVERWRITES the Postgres
 * `wallet_balances` row to match whenever they differ. That means Postgres
 * (the authoritative ledger) can be corrupted by a stale/out-of-sync JSON
 * blob. Kept only so historical tests of the pure helpers above continue to
 * compile against this module. Use `lockWalletBalanceRow` instead, which
 * never rewrites Postgres from JSON.
 *
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
  lockWalletBalanceRow,
  lockWalletHoldRow,
};
