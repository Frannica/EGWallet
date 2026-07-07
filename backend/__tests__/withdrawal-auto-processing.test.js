'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');

function extractWithdrawalsBlock() {
  const match = indexSource.match(/app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);/);
  assert.ok(match, 'POST /withdrawals route block not found');
  return match[0];
}

test('POST /withdrawals auto-advances without admin approval in all environments', () => {
  const block = extractWithdrawalsBlock();
  assert.doesNotMatch(block, /NODE_ENV\s*!==\s*'production'[\s\S]*advanceToProcessing/);
  assert.match(block, /advanceToProcessing\(db,\s*withdrawal\.id\)/);
});

test('POST /withdrawals dispatches executePayout when no admin intervention required', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /_withdrawNeedsAdminReview/);
  assert.match(block, /if \(!_withdrawNeedsAdminReview && _capturedWithdrawalId\)/);
  assert.match(block, /executePayout\(_capturedWithdrawalId/);
});

test('POST /withdrawals uses isPayoutProviderReady for production provider check', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /isPayoutProviderReady\(country/);
  assert.doesNotMatch(block, /stripeReady\s*=\s*false/);
});

test('POST /withdrawals blocks restricted accounts via policy', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /isAccountRestricted\(withdrawUser\)/);
  assert.match(block, /requiresAdminIntervention\(withdrawUser,\s*db\)/);
});

test('POST /withdrawals does not apply send KYC limits', () => {
  const block = extractWithdrawalsBlock();
  assert.doesNotMatch(block, /checkKYCLimits\(withdrawUser/);
  assert.doesNotMatch(block, /updateLimitTracking\(withdrawUser/);
});
