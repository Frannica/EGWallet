'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const policySource = fs.readFileSync(path.join(__dirname, '..', 'adminInterventionPolicy.js'), 'utf8');

const MONEY_ROUTES = [
  { name: 'P2P send', pattern: /app\.post\('\/transactions',[\s\S]*?enforceMoneyOperationPolicy/ },
  { name: 'Exchange', pattern: /app\.post\('\/exchange',[\s\S]*?enforceMoneyOperationPolicy/ },
  { name: 'Pay request', pattern: /app\.post\('\/payment-requests\/:id\/pay',[\s\S]*?enforceMoneyOperationPolicy/ },
  { name: 'QR pay', pattern: /app\.post\('\/qr\/pay',[\s\S]*?enforceMoneyOperationPolicy/ },
  { name: 'Bulk payroll', pattern: /app\.post\('\/employer\/bulk-payment',[\s\S]*?enforceMoneyOperationPolicy/ },
];

test('adminInterventionPolicy documents permanent intervention rule', () => {
  assert.match(policySource, /PERMANENT PRODUCT RULE/);
  assert.match(policySource, /Fraud or risk is detected/);
  assert.match(policySource, /AML \/ compliance requires review/);
  assert.match(policySource, /Sanctions match or hold/);
  assert.match(policySource, /Court order \/ legal hold/);
  assert.match(policySource, /restricted or frozen/);
  assert.match(policySource, /Do not add routine admin-approval gates outside this module/);
});

test('money routes enforce adminInterventionPolicy', () => {
  for (const route of MONEY_ROUTES) {
    assert.match(indexSource, route.pattern, `${route.name} must call enforceMoneyOperationPolicy`);
  }
});

test('withdrawals auto-process by default but hold for fraud/AML intervention', () => {
  const block = indexSource.match(/app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);/);
  assert.ok(block, 'withdrawals route not found');
  assert.match(block[0], /requiresAdminIntervention/);
  assert.match(block[0], /_withdrawNeedsAdminReview/);
  assert.match(block[0], /advanceToProcessing\(db,\s*withdrawal\.id\)/);
  assert.doesNotMatch(block[0], /NODE_ENV\s*!==\s*'production'[\s\S]*advanceToProcessing/);
});

test('no blanket production admin gate on withdrawals', () => {
  assert.doesNotMatch(indexSource, /withdrawals stay pending_review for admin approval/i);
  assert.doesNotMatch(indexSource, /require admin approval before processing/i);
});

test('requiresApproval is never true on payroll requests', () => {
  assert.doesNotMatch(indexSource, /requiresApproval:\s*true/);
});

test('no verificationStatus !== verified employer admin gate remains', () => {
  assert.doesNotMatch(indexSource, /verificationStatus !== 'verified'/);
});
