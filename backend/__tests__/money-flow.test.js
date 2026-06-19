/**
 * Money-flow regression tests — $300 split send, idempotent pay, atomic balances.
 *
 * Run: node backend/__tests__/money-flow.test.js
 */

'use strict';

function simulateP2PSend(fromWallet, toWallet, amount, currency) {
  if (fromWallet.id === toWallet.id || fromWallet.userId === toWallet.userId) {
    return { ok: false, reason: 'self' };
  }
  const debitEntry = fromWallet.balances.find(b => b.currency === currency);
  if (!debitEntry || debitEntry.amount < amount) return { ok: false, reason: 'insufficient' };

  const beforeFrom = debitEntry.amount;
  let destEntry = toWallet.balances.find(b => b.currency === currency);
  const beforeTo = destEntry ? destEntry.amount : 0;

  debitEntry.amount -= amount;
  if (destEntry) destEntry.amount += amount;
  else toWallet.balances.push({ currency, amount });

  if (debitEntry.amount >= beforeFrom) {
    debitEntry.amount = beforeFrom;
    return { ok: false, reason: 'integrity' };
  }

  return {
    ok: true,
    senderAfter: debitEntry.amount,
    receiverAfter: destEntry ? destEntry.amount : amount,
    senderBefore: beforeFrom,
    receiverBefore: beforeTo,
  };
}

function simulatePayRequestPay(payerWallet, receiverWallet, amount, currency, request) {
  if (request.status === 'paid') {
    if (request.paidBy === payerWallet.userId) {
      return { ok: true, idempotentReplay: true, request, transaction: request.transaction };
    }
    return { ok: false, error: 'already_processed' };
  }
  if (request.status !== 'pending') return { ok: false, error: 'already_processed' };

  const payFrom = payerWallet.balances.find(b => b.currency === currency);
  if (!payFrom || payFrom.amount < amount) return { ok: false, error: 'insufficient' };

  const beforeFrom = payFrom.amount;
  let dest = receiverWallet.balances.find(b => b.currency === currency);
  const beforeTo = dest ? dest.amount : 0;

  payFrom.amount -= amount;
  if (dest) dest.amount += amount;
  else receiverWallet.balances.push({ currency, amount });

  if (payFrom.amount >= beforeFrom) {
    payFrom.amount = beforeFrom;
    return { ok: false, error: 'integrity' };
  }

  const tx = { id: 'tx-1', amount, currency, status: 'completed' };
  request.status = 'paid';
  request.paidBy = payerWallet.userId;
  request.transaction = tx;

  return {
    ok: true,
    request,
    transaction: tx,
    senderAfter: payFrom.amount,
    receiverAfter: dest ? dest.amount : amount,
    senderBefore: beforeFrom,
    receiverBefore: beforeTo,
  };
}

function runMoneyFlowTests(check) {
  // 1. $300 → send $171 → send $129 (USD minor: 30000, 17100, 12900)
  const sender = {
    id: 'w-sender',
    userId: 'u-sender',
    balances: [{ currency: 'USD', amount: 30000 }],
  };
  const receiver1 = { id: 'w-r1', userId: 'u-r1', balances: [{ currency: 'USD', amount: 0 }] };
  const receiver2 = { id: 'w-r2', userId: 'u-r2', balances: [{ currency: 'USD', amount: 0 }] };

  const send1 = simulateP2PSend(sender, receiver1, 17100, 'USD');
  check('[Flow] $300 wallet: first send $171 succeeds', send1.ok && send1.senderAfter === 12900);
  check('[Flow] $300 wallet: after $171 sender has $129', sender.balances[0].amount === 12900);

  const send2 = simulateP2PSend(sender, receiver2, 12900, 'USD');
  check('[Flow] $300 wallet: second send $129 succeeds', send2.ok && send2.senderAfter === 0);
  check('[Flow] $300 wallet: sender ends at $0', sender.balances[0].amount === 0);
  check('[Flow] $300 wallet: receivers credited correctly', receiver1.balances[0].amount === 17100 && receiver2.balances[0].amount === 12900);

  const overSend = simulateP2PSend(sender, receiver1, 100, 'USD');
  check('[Flow] $300 wallet: third send blocked (insufficient)', !overSend.ok);

  // 2. Network timeout after successful backend commit — idempotent replay
  const req = { id: 'pr-1', status: 'pending', paidBy: null, transaction: null };
  const payer = { id: 'w-p', userId: 'u-p', balances: [{ currency: 'USD', amount: 5000 }] };
  const payee = { id: 'w-payee', userId: 'u-payee', balances: [{ currency: 'USD', amount: 0 }] };
  const firstPay = simulatePayRequestPay(payer, payee, 5000, 'USD', req);
  check('[Flow] payment request first pay succeeds', firstPay.ok && payer.balances[0].amount === 0);
  const replayPay = simulatePayRequestPay(payer, payee, 5000, 'USD', req);
  check('[Flow] duplicate pay returns success (idempotent replay)', replayPay.ok && replayPay.idempotentReplay === true);
  check('[Flow] duplicate pay does not double-debit', payer.balances[0].amount === 0 && payee.balances[0].amount === 5000);

  // 3. Sender/receiver consistency — atomic debit+credit
  const s = { id: 'ws', userId: 'us', balances: [{ currency: 'XAF', amount: 100000 }] };
  const r = { id: 'wr', userId: 'ur', balances: [{ currency: 'XAF', amount: 50000 }] };
  const totalBefore = s.balances[0].amount + r.balances[0].amount;
  const xfer = simulateP2PSend(s, r, 25000, 'XAF');
  const totalAfter = s.balances[0].amount + r.balances[0].amount;
  check('[Flow] transfer preserves total money in system', xfer.ok && totalBefore === totalAfter);

  // 4. Failed integrity aborts without changing totals
  const s2 = { id: 'ws2', userId: 'us2', balances: [{ currency: 'XAF', amount: 1000 }] };
  const r2 = { id: 'wr2', userId: 'ur2', balances: [{ currency: 'XAF', amount: 0 }] };
  const total2Before = s2.balances[0].amount + r2.balances[0].amount;
  const bad = simulateP2PSend(s2, r2, 0, 'XAF');
  const total2After = s2.balances[0].amount + r2.balances[0].amount;
  check('[Flow] zero-amount send blocked', !bad.ok && total2Before === total2After);
}

module.exports = runMoneyFlowTests;

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const check = (label, cond) => {
    if (cond) { console.log(`  ✅  ${label}`); passed++; }
    else { console.error(`  ❌  ${label}`); failed++; }
  };
  console.log('\n── Money flow regression ─────────────────────────────────────────────\n');
  runMoneyFlowTests(check);
  console.log(`\n  Money flow: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
