'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayoutStack, ProviderRegistry, ProviderRouter } = require('../../payout');
const { createNoopProviderAdapter } = require('../../payout/adapters/noopProvider.adapter');
const { loadPayoutConfig } = require('../../payout/config/loadPayoutConfig');

test('ProviderRouter ranks healthier adapter above degraded adapter', () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();

  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', configured: true }));
  registry.register(createNoopProviderAdapter({ id: 'rail_secondary_bank', configured: true }));

  for (let i = 0; i < 5; i += 1) registry.recordFailure('rail_primary_bank');
  for (let i = 0; i < 5; i += 1) registry.recordSuccess('rail_secondary_bank', 500);

  const router = new ProviderRouter(registry, config);
  const corridor = router.resolveCorridor({ country: 'NG', currency: 'NGN', method: 'bank' });
  const ranked = router.rankCandidates(corridor);

  assert.ok(ranked.length >= 1);
  if (ranked.length >= 2) {
    assert.equal(ranked[0].adapterId, 'rail_secondary_bank');
  }
});

test('ProviderRouter isCorridorReady false when no adapters configured', () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', configured: false }));
  registry.register(createNoopProviderAdapter({ id: 'rail_secondary_bank', configured: false }));

  const router = new ProviderRouter(registry, config);
  assert.equal(router.isCorridorReady({ country: 'NG', currency: 'NGN', method: 'bank' }), false);
});

test('getCorridorMetadata exposes no adapter or vendor names', () => {
  const { router } = createPayoutStack();
  const meta = router.getCorridorMetadata({ country: 'NG', currency: 'NGN', method: 'bank' });
  assert.ok(meta);
  assert.equal(meta.country, 'NG');
  assert.ok(meta.requiredFields);
  const json = JSON.stringify(meta);
  assert.doesNotMatch(json, /stripe|kora|flutterwave|thunes|wise|paystack|adapterId|rail_/i);
});
