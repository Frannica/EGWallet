'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('checkKYCLimits uses effective KYC tier (full KYC requires approval)', () => {
  assert.match(indexSource, /getEffectiveKycTier\(user\)/);
});

test('POST /withdrawals route excludes send limit enforcement', () => {
  const block = indexSource.match(/app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);/);
  assert.ok(block, 'withdrawals route not found');
  assert.doesNotMatch(block[0], /checkKYCLimits\(withdrawUser/);
  assert.doesNotMatch(block[0], /updateLimitTracking\(withdrawUser/);
});

test('auth responses expose send-scoped tier limits', () => {
  assert.match(indexSource, /tierLimits: getTierLimitsForUser/);
});
