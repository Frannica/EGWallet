'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = fs.readFileSync(path.join(ROOT, 'backend', 'index.js'), 'utf8');
const LOCAL = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'localBalance.ts'), 'utf8');
const TXNS = fs.readFileSync(path.join(ROOT, 'src', 'api', 'transactions.ts'), 'utf8');

module.exports = function phase16(check) {
  check(
    '[Send] POST /transactions blocks same wallet id (prevents net-zero double-spend)',
    BACKEND.includes('fromWalletId === toWalletId') &&
    BACKEND.includes('error_cannot_send_to_self'),
  );
  check(
    '[Send] POST /transactions uses getWalletBalanceEntry (no detached balance object)',
    BACKEND.includes('function getWalletBalanceEntry') &&
    BACKEND.includes('getWalletBalanceEntry(fromWallet, currency)') &&
    !BACKEND.includes("|| { currency, amount: 0 }"),
  );
  check(
    '[Send] POST /transactions integrity check — sender balance must decrease',
    BACKEND.includes('sender balance did not decrease') &&
    BACKEND.includes('debitEntry.amount >= originalFromAmount'),
  );
  check(
    '[Send] POST /transactions blocks debitEntry === destBalance same reference',
    BACKEND.includes('debitEntry === destBalance'),
  );
  check(
    '[Send] sendTransaction reconciles with idempotency retry after transport failure',
    TXNS.includes('const retry = await postOnce()') &&
    TXNS.includes('30000'),
  );
  check(
    '[LocalBalance] zero-reset guard only applies with active debit protection',
    LOCAL.includes('hasDebitRecord) {') &&
    LOCAL.includes('b.amount === 0 && localAmt !== undefined && localAmt > 0 && hasDebitRecord'),
  );
};
