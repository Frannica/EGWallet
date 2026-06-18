/**
 * Send integrity tests — proves P2P transfer debits sender and credits receiver.
 * Simulates the fixed POST /transactions balance mutation rules from backend/index.js.
 *
 * Run: node backend/__tests__/send-integrity.test.js
 */

'use strict';

function coerceMinorAmount(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function getWalletBalanceEntry(wallet, currency, { create = false } = {}) {
  if (!wallet.balances) wallet.balances = [];
  let entry = wallet.balances.find(b => b.currency === currency);
  if (!entry && create) {
    entry = { currency, amount: 0 };
    wallet.balances.push(entry);
  }
  if (entry) entry.amount = coerceMinorAmount(entry.amount);
  return entry || null;
}

function normalizeWalletBalances(wallet) {
  if (!wallet?.balances) return;
  for (const b of wallet.balances) b.amount = coerceMinorAmount(b.amount);
}

function simulateP2PSend(fromWallet, toWallet, amount, currency) {
  if (fromWallet.id === toWallet.id || fromWallet.userId === toWallet.userId) {
    return { ok: false, reason: 'self' };
  }
  normalizeWalletBalances(fromWallet);
  normalizeWalletBalances(toWallet);

  let debitEntry = getWalletBalanceEntry(fromWallet, currency);
  if (!debitEntry || debitEntry.amount < amount) {
    const richest = (fromWallet.balances || []).reduce((best, b) => {
      if (!best || b.amount > best.amount) return b;
      return best;
    }, null);
    if (!richest || richest.amount < amount) {
      return { ok: false, reason: 'insufficient' };
    }
    debitEntry = richest;
  }

  const originalFrom = debitEntry.amount;
  let destEntry = getWalletBalanceEntry(toWallet, currency);
  const originalDest = destEntry ? destEntry.amount : 0;

  if (fromWallet === toWallet && debitEntry === destEntry) {
    return { ok: false, reason: 'same_ref' };
  }

  debitEntry.amount -= amount;
  if (destEntry) destEntry.amount += amount;
  else {
    destEntry = { currency, amount };
    toWallet.balances.push(destEntry);
  }

  if (debitEntry.amount >= originalFrom || amount <= 0) {
    debitEntry.amount = originalFrom;
    if (destEntry) destEntry.amount = originalDest;
    return { ok: false, reason: 'integrity' };
  }

  return {
    ok: true,
    senderBefore: originalFrom,
    senderAfter: debitEntry.amount,
    receiverBefore: originalDest,
    receiverAfter: destEntry.amount,
  };
}

function simulateOldBuggySameWalletSend(wallet, amount, currency) {
  // Old POST /transactions did not block fromWalletId === toWalletId.
  const fromBalance = wallet.balances.find(b => b.currency === currency) || { currency, amount: 0 };
  if (fromBalance.amount < amount) return { ok: false, reason: 'insufficient' };

  const destBalance = wallet.balances.find(b => b.currency === currency);
  const before = wallet.balances[0].amount;

  fromBalance.amount -= amount;
  if (destBalance) destBalance.amount += amount;

  return {
    ok: true,
    before,
    after: wallet.balances[0].amount,
    sameRef: fromBalance === destBalance,
  };
}

function simulateOldBuggyCrossCurrencySend(fromWallet, toWallet, amount, sendCurrency) {
  // Old code only debited exact send currency — no richest-bucket fallback.
  const fromBalance = fromWallet.balances.find(b => b.currency === sendCurrency) || { currency: sendCurrency, amount: 0 };
  if (fromBalance.amount < amount) return { ok: false, reason: 'insufficient', detached: !fromWallet.balances.includes(fromBalance) };

  const destBalance = toWallet.balances.find(b => b.currency === sendCurrency);
  fromBalance.amount -= amount;
  if (destBalance) destBalance.amount += amount;
  else toWallet.balances.push({ currency: sendCurrency, amount });

  const realEntry = fromWallet.balances.find(b => b.currency === sendCurrency);
  return {
    ok: true,
    senderWalletAmount: realEntry ? realEntry.amount : 0,
    receiverWalletAmount: destBalance ? destBalance.amount : amount,
    detached: !fromWallet.balances.includes(fromBalance),
  };
}

function runSendIntegrityTests(check) {
  const phones = Array.from({ length: 7 }, (_, i) => ({
    userId: `user-${i + 1}`,
    wallet: {
      id: `wallet-${i + 1}`,
      userId: `user-${i + 1}`,
      balances: [{ currency: 'XAF', amount: 100000 }],
    },
  }));

  for (let i = 0; i < phones.length; i++) {
    const from = phones[i];
    const to = phones[(i + 1) % phones.length];
    const sendAmt = 5000 + i * 100;
    const beforeFrom = from.wallet.balances[0].amount;
    const beforeTo = to.wallet.balances[0].amount;
    const toNum = ((i + 1) % 7) + 1;

    const result = simulateP2PSend(from.wallet, to.wallet, sendAmt, 'XAF');
    check(`[P2P] Phone ${i + 1} → Phone ${toNum}: transfer succeeds`, result.ok);
    check(
      `[P2P] Phone ${i + 1} → Phone ${toNum}: sender debited`,
      result.ok && result.senderAfter === beforeFrom - sendAmt,
    );
    check(
      `[P2P] Phone ${i + 1} → Phone ${toNum}: receiver credited`,
      result.ok && result.receiverAfter === beforeTo + sendAmt,
    );
  }

  const selfWallet = { id: 'w1', userId: 'u1', balances: [{ currency: 'XAF', amount: 50000 }] };
  check('[P2P] Same wallet id blocked', !simulateP2PSend(selfWallet, selfWallet, 1000, 'XAF').ok);
  check(
    '[P2P] Same user different wallet id blocked',
    !simulateP2PSend(
      { id: 'w1', userId: 'u1', balances: [{ currency: 'XAF', amount: 50000 }] },
      { id: 'w2', userId: 'u1', balances: [{ currency: 'XAF', amount: 0 }] },
      1000,
      'XAF',
    ).ok,
  );

  const oldSelf = simulateOldBuggySameWalletSend(selfWallet, 10000, 'XAF');
  check('[P2P] Old bug: same-wallet send nets to zero', oldSelf.ok && oldSelf.before === oldSelf.after && oldSelf.sameRef);
  check(
    '[P2P] Old bug: cross-currency send blocked (detached zero balance)',
    !simulateOldBuggyCrossCurrencySend(
      { id: 'sa', userId: 'ua', balances: [{ currency: 'USD', amount: 5000000 }] },
      { id: 'rb', userId: 'ub', balances: [{ currency: 'XAF', amount: 0 }] },
      10000,
      'XAF',
    ).ok,
  );
  check(
    '[P2P] Fixed code: cross-currency debits richest bucket',
    simulateP2PSend(
      { id: 'sc', userId: 'uc', balances: [{ currency: 'USD', amount: 5000000 }] },
      { id: 'td', userId: 'ud', balances: [{ currency: 'XAF', amount: 0 }] },
      10000,
      'XAF',
    ).ok,
  );

  const strWallet = { id: 'ws', userId: 'us', balances: [{ currency: 'XAF', amount: '50000' }] };
  const strTo = { id: 'wt', userId: 'ut', balances: [{ currency: 'XAF', amount: 0 }] };
  const strResult = simulateP2PSend(strWallet, strTo, 10000, 'XAF');
  check('[P2P] String balance amounts coerced and debited', strResult.ok && strWallet.balances[0].amount === 40000);
}

module.exports = runSendIntegrityTests;

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const check = (label, cond) => {
    if (cond) { console.log(`  ✅  ${label}`); passed++; }
    else { console.error(`  ❌  ${label}`); failed++; }
  };
  console.log('\n── Send integrity (P2P simulation) ─────────────────────────────────────\n');
  runSendIntegrityTests(check);
  console.log(`\n  Send integrity: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
