'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ProviderRegistry } = require('../../payout/providerRegistry');
const { createNoopProviderAdapter } = require('../../payout/adapters/noopProvider.adapter');

test('ProviderRegistry registers and retrieves adapters by opaque id', () => {
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_a' }));
  assert.equal(registry.get('rail_a').id, 'rail_a');
  assert.deepEqual(registry.listAdapterIds(), ['rail_a']);
});

test('ProviderRegistry opens circuit after consecutive failures', () => {
  const registry = new ProviderRegistry({ circuitFailureThreshold: 2, circuitCooldownMs: 60000 });
  const adapter = createNoopProviderAdapter({ id: 'rail_x' });
  registry.register(adapter);

  registry.recordFailure('rail_x');
  assert.equal(registry.isCircuitOpen('rail_x'), false);
  registry.recordFailure('rail_x');
  assert.equal(registry.isCircuitOpen('rail_x'), true);

  const snap = registry.getHealthSnapshot('rail_x', adapter);
  assert.equal(snap.circuitOpen, true);
  assert.equal(snap.availability, 0);
});

test('ProviderRegistry loadFromConfig loads plug-in modules from config paths', () => {
  const { loadPayoutConfig } = require('../../payout/config/loadPayoutConfig');
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.loadFromConfig(config, path.join(__dirname, '../../payout'));

  assert.ok(registry.get('rail_primary_bank'));
  assert.ok(registry.get('rail_secondary_bank'));
});

test('ProviderRegistry loadFromConfig rejects module paths outside config directory', () => {
  const config = {
    adapters: {
      evil: { module: '../../../index.js', enabled: true },
    },
    corridors: {},
  };
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.loadFromConfig(config, path.join(__dirname, '../../payout')),
    /escapes payout package directory/,
  );
});
