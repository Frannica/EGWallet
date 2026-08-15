'use strict';
/**
 * Proves debit/credit card withdrawal methods are rejected before any
 * wallet hold or payout dispatch. EGWallet has no capability to push funds
 * to an arbitrary user-entered card — those UI options were removed, and
 * this backend gate is the hard backstop for stale clients.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const sendSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'screens', 'SendScreen.tsx'),
  'utf8'
);

test('backend ALLOWED_WITHDRAWAL_METHODS excludes debit and credit', () => {
  assert.match(
    indexSource,
    /ALLOWED_WITHDRAWAL_METHODS\s*=\s*new Set\(\[\s*['"]bank['"]\s*,\s*['"]mobile['"]\s*\]\)/
  );
  assert.doesNotMatch(
    indexSource,
    /ALLOWED_WITHDRAWAL_METHODS\s*=\s*new Set\(\[[^\]]*['"]debit['"]/
  );
  assert.doesNotMatch(
    indexSource,
    /ALLOWED_WITHDRAWAL_METHODS\s*=\s*new Set\(\[[^\]]*['"]credit['"]/
  );
});

test('backend returns CARD_WITHDRAWAL_UNSUPPORTED before any hold for debit/credit', () => {
  assert.match(indexSource, /CARD_WITHDRAWAL_UNSUPPORTED/);
  assert.match(
    indexSource,
    /method === ['"]debit['"]\s*\|\|\s*method === ['"]credit['"]/
  );

  // Scope ordering checks to the POST /withdrawals handler body.
  const start = indexSource.indexOf("app.post('/withdrawals'");
  assert.ok(start > 0, 'POST /withdrawals handler must exist');
  const handler = indexSource.slice(start, start + 20000);
  const rejectIdx = handler.indexOf('CARD_WITHDRAWAL_UNSUPPORTED');
  const holdIdx = handler.indexOf('await withBalanceMutex(async () => {');
  const createIdx = handler.indexOf('createWithdrawal(db, req.user.userId');
  assert.ok(rejectIdx > 0, 'CARD_WITHDRAWAL_UNSUPPORTED must exist inside /withdrawals');
  assert.ok(holdIdx > rejectIdx, 'card rejection must precede withBalanceMutex in /withdrawals');
  assert.ok(createIdx > rejectIdx, 'card rejection must precede createWithdrawal');
});

test('backend never routes debit/credit into Kora or Stripe Connect payout', () => {
  // koraPayout only accepts mobile → mobile_money, else bank_account.
  // Card methods must never reach executePayout — prove the gate exists.
  const withdrawalsHandler = indexSource.slice(
    indexSource.indexOf("app.post('/withdrawals'"),
    indexSource.indexOf("app.post('/withdrawals'") + 8000
  );
  assert.match(withdrawalsHandler, /CARD_WITHDRAWAL_UNSUPPORTED/);
  assert.match(withdrawalsHandler, /return res\.status\(400\)/);
});

test('SendScreen no longer offers debit or credit withdrawal methods', () => {
  assert.doesNotMatch(sendSource, /setWithdrawalMethod\(['"]debit['"]\)/);
  assert.doesNotMatch(sendSource, /setWithdrawalMethod\(['"]credit['"]\)/);
  assert.doesNotMatch(sendSource, /withdrawalMethod === ['"]debit['"]/);
  assert.doesNotMatch(sendSource, /withdrawalMethod === ['"]credit['"]/);
  assert.doesNotMatch(sendSource, /withdrawalCardNumber/);
  assert.doesNotMatch(sendSource, /t\(['"]send\.debitCard['"]\)/);
  assert.doesNotMatch(sendSource, /t\(['"]send\.creditCard['"]\)/);
  // Default method must be a real payout path.
  assert.match(sendSource, /useState<'bank'\s*\|\s*'mobile'>\('mobile'\)/);
});

test('SendScreen never collects card PAN/expiry for withdrawals', () => {
  assert.doesNotMatch(sendSource, /placeholder="1234 5678 9012 3456"/);
  assert.doesNotMatch(sendSource, /setWithdrawalCardExpiry/);
  assert.doesNotMatch(sendSource, /cardExpiry:\s*withdrawalCardExpiry/);
});
