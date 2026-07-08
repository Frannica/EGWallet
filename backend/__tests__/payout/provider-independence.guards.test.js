'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAYOUT_ROOT = path.join(__dirname, '..', '..', 'payout');
const CORE_DIRS = ['', 'config', 'adapters'];
const FORBIDDEN_VENDOR_PATTERN = /stripe|kora|flutterwave|thunes|wise|paystack|gimac|terrapay|dwolla|tabapay|mangopay|modulr|rapyd|xendit/i;

function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('core payout modules contain no payment-vendor names', () => {
  const files = listJsFiles(PAYOUT_ROOT);
  assert.ok(files.length > 0, 'expected payout module files');

  for (const file of files) {
    const rel = path.relative(PAYOUT_ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    if (FORBIDDEN_VENDOR_PATTERN.test(content)) {
      assert.fail(`Vendor name found in payout core file: ${rel}`);
    }
  }
});

test('core payout module filenames are provider-independent', () => {
  const files = listJsFiles(PAYOUT_ROOT);
  for (const file of files) {
    const base = path.basename(file);
    assert.doesNotMatch(base, FORBIDDEN_VENDOR_PATTERN, `filename: ${base}`);
  }
});

test('ProviderAdapter contract file exists and exports assertProviderAdapter', () => {
  const mod = require('../../payout/adapters/ProviderAdapter');
  assert.equal(typeof mod.assertProviderAdapter, 'function');
});

test('payout index exports generic orchestration API only', () => {
  const mod = require('../../payout');
  assert.equal(typeof mod.ProviderRegistry, 'function');
  assert.equal(typeof mod.ProviderRouter, 'function');
  assert.equal(typeof mod.ProviderOrchestrator, 'function');
  assert.equal(typeof mod.createPayoutStack, 'function');
  assert.equal(mod.Stripe, undefined);
  assert.equal(mod.Kora, undefined);
});

test('index.js still uses legacy payoutProviders — Phase A does not wire new stack', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.doesNotMatch(indexSource, /require\('\.\/payout'\)/);
  assert.match(indexSource, /require\('\.\/payoutProviders'\)/);
});

test('withdrawalEngine remains untouched by payout module imports', () => {
  const engineSource = fs.readFileSync(path.join(__dirname, '..', '..', 'withdrawalEngine.js'), 'utf8');
  assert.doesNotMatch(engineSource, /require\('\.\/payout/);
});
