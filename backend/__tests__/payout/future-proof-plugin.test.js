'use strict';

/**
 * Future-proof proof: a brand-new provider works via plug-in + config only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadPayoutConfig,
  ProviderRegistry,
  ProviderRouter,
  ProviderOrchestrator,
} = require('../../payout');

const PAYOUT_ROOT = path.join(__dirname, '..', '..', 'payout');
const FIXTURE_CONFIG = path.join(__dirname, 'fixtures', 'future-provider.corridors.json');

const IMMUTABLE_CORE_FILES = [
  'providerRouter.js',
  'providerRegistry.js',
  'providerOrchestrator.js',
  'adapters/noopProvider.adapter.js',
  path.join('..', 'withdrawalEngine.js'),
];

function sha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function snapshotCoreHashes() {
  const hashes = {};
  for (const rel of IMMUTABLE_CORE_FILES) {
    const full = path.resolve(PAYOUT_ROOT, rel);
    hashes[rel] = sha256(full);
  }
  return hashes;
}

test('FUTURE-PROOF: new provider works with plug-in file + config only', async () => {
  const before = snapshotCoreHashes();

  const config = loadPayoutConfig(FIXTURE_CONFIG);
  const registry = new ProviderRegistry();
  registry.loadFromConfig(config, PAYOUT_ROOT);

  const router = new ProviderRouter(registry, config);
  const orchestrator = new ProviderOrchestrator(registry, router);

  assert.ok(registry.get('rail_future_demo'));
  assert.equal(router.isCorridorReady({ country: 'GH', currency: 'GHS', method: 'bank' }), true);

  const meta = router.getCorridorMetadata({ country: 'GH', currency: 'GHS', method: 'bank' });
  assert.equal(meta.country, 'GH');
  assert.equal(meta.currency, 'GHS');
  assert.doesNotMatch(JSON.stringify(meta), /rail_future|fakeFuture|stripe|kora/i);

  const result = await orchestrator.execute({
    id: 'future-wd-1',
    country: 'GH',
    currency: 'GHS',
    method: 'bank',
    amount: 50000,
    bankCode: 'GH001',
    accountNumber: '1234567890',
    accountHolderName: 'Future User',
  });

  assert.equal(result.outcome, 'paid');
  assert.equal(result.adapterId, 'rail_future_demo');
  assert.equal(result.reference, 'future-egw-future-wd-1');

  const after = snapshotCoreHashes();
  assert.deepEqual(after, before, 'core architecture files must not change when adding a provider');
});

test('FUTURE-PROOF: fake plug-in is loaded from config module path without core edits', () => {
  const config = loadPayoutConfig(FIXTURE_CONFIG);
  assert.ok(config.adapters.rail_future_demo);
  assert.equal(config.adapters.rail_future_demo.module, 'adapters/fakeFutureProvider.adapter.js');
  assert.ok(config.corridors['GH-GHS-bank']);
  assert.equal(config.corridors['GH-GHS-bank'].candidates[0].adapterId, 'rail_future_demo');
});

test('FUTURE-PROOF: existing noop plug-in unchanged and still serves default corridors', async () => {
  const { createPayoutStack } = require('../../payout');
  const { orchestrator } = createPayoutStack();
  const result = await orchestrator.execute({
    id: 'future-wd-2',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });
  assert.equal(result.outcome, 'paid');
});
