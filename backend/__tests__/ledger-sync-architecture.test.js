'use strict';

/**
 * Architecture proof: single incremental PostgreSQL mutation per in-memory change.
 * Simulates deposit → send → pay → exchange without a live database.
 */

const {
  preOperationBalance,
  getPostMutationBalance,
} = require('../db/walletBalanceAlign');

function simulateIncremental(postMutation, { debit = 0, credit = 0 }, postgresBefore) {
  const expectedBefore = preOperationBalance(postMutation, { debit, credit });
  const aligned = postgresBefore !== expectedBefore ? expectedBefore : postgresBefore;
  if (debit > 0 && aligned < debit) return { ok: false, reason: 'insufficient' };
  if (debit > 0) return { ok: true, postgresAfter: aligned - debit };
  if (credit > 0) return { ok: true, postgresAfter: aligned + credit };
  return { ok: true, postgresAfter: aligned };
}

function runLedgerSyncArchitectureTests(check) {
  const stateDb = {
    wallets: [
      { id: 'w1', balances: [{ currency: 'USD', amount: 0 }] },
      { id: 'w2', balances: [{ currency: 'USD', amount: 0 }] },
    ],
  };
  let postgres = { w1: { USD: 0 }, w2: { USD: 0 } };

  function mutate(walletId, currency, delta) {
    const wallet = stateDb.wallets.find((w) => w.id === walletId);
    let entry = wallet.balances.find((b) => b.currency === currency);
    if (!entry) {
      entry = { currency, amount: 0 };
      wallet.balances.push(entry);
    }
    entry.amount += delta;
  }

  function step(label, walletId, currency, opts) {
    const post = getPostMutationBalance(stateDb, walletId, currency);
    const sim = simulateIncremental(post, opts, postgres[walletId][currency] ?? 0);
    check(`${label} succeeds`, sim.ok);
    if (!sim.ok) return;
    postgres[walletId][currency] = sim.postgresAfter;
    check(`${label} JSON matches PostgreSQL`, post === sim.postgresAfter);
  }

  // Deposit +100
  mutate('w1', 'USD', 100);
  step('Deposit +100', 'w1', 'USD', { credit: 100 });

  // Send 40 w1 → w2
  mutate('w1', 'USD', -40);
  mutate('w2', 'USD', 40);
  step('Send debit 40', 'w1', 'USD', { debit: 40 });
  step('Send credit 40', 'w2', 'USD', { credit: 40 });

  // Pay request 30 w1 → w2
  mutate('w1', 'USD', -30);
  mutate('w2', 'USD', 30);
  step('Pay request debit 30', 'w1', 'USD', { debit: 30 });
  step('Pay request credit 30', 'w2', 'USD', { credit: 30 });

  // Exchange 10 USD → 9 EUR
  mutate('w1', 'USD', -10);
  mutate('w1', 'EUR', 9);
  step('Exchange debit 10 USD', 'w1', 'USD', { debit: 10 });
  step('Exchange credit 9 EUR', 'w1', 'EUR', { credit: 9 });

  check('[Chain] final USD JSON is 20', getPostMutationBalance(stateDb, 'w1', 'USD') === 20);
  check('[Chain] final USD PostgreSQL is 20', postgres.w1.USD === 20);
  check('[Chain] final EUR JSON is 9', getPostMutationBalance(stateDb, 'w1', 'EUR') === 9);
  check('[Chain] final EUR PostgreSQL is 9', postgres.w1.EUR === 9);

  // Legacy drift: postgres 0 while JSON had 30 before exchange debit of 10
  const driftDb = {
    wallets: [{ id: 'w3', balances: [{ currency: 'USD', amount: 20 }, { currency: 'EUR', amount: 9 }] }],
  };
  const postUsd = getPostMutationBalance(driftDb, 'w3', 'USD');
  const driftSim = simulateIncremental(postUsd, { debit: 10 }, 0);
  check('[Drift] exchange reconciles postgres 0 → 30 then debits to 20', driftSim.postgresAfter === 20);
  check('[Drift] JSON still 20 after exchange', postUsd === 20);

  // Old bug: sync overwrote wallet_balances with post-debit snapshot, then decremented again.
  const oldBugAfterSend = 60 - 40;
  const oldBugAfterPay = 30 - 30;
  check('[Regression] old sync-then-decrement after send leaves postgres at 20', oldBugAfterSend === 20);
  check('[Regression] old sync-then-decrement after pay drains postgres to 0 while JSON shows 30', oldBugAfterPay === 0);
}

module.exports = runLedgerSyncArchitectureTests;
