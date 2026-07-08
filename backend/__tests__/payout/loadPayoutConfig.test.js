'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  loadPayoutConfig,
  buildCorridorId,
  resolveCorridorDefinition,
} = require('../../payout/config/loadPayoutConfig');

test('buildCorridorId normalizes country and currency', () => {
  assert.equal(buildCorridorId('ng', 'ngn', 'bank'), 'NG-NGN-bank');
});

test('loadPayoutConfig loads default corridors without vendor names in adapter ids', () => {
  const config = loadPayoutConfig();
  assert.ok(config.adapters.rail_primary_bank);
  assert.ok(config.corridors['NG-NGN-bank']);
  for (const id of Object.keys(config.adapters)) {
    assert.doesNotMatch(id, /stripe|kora|flutterwave|thunes|wise|paystack|gimac|terrapay/i);
  }
});

test('resolveCorridorDefinition returns required fields for NG bank', () => {
  const config = loadPayoutConfig();
  const corridor = resolveCorridorDefinition(config, {
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
  });
  assert.equal(corridor.corridorId, 'NG-NGN-bank');
  assert.ok(corridor.requiredFields.some(f => f.name === 'bankCode'));
});

test('resolveCorridorDefinition returns null for unknown corridor', () => {
  const config = loadPayoutConfig();
  const corridor = resolveCorridorDefinition(config, {
    country: 'XX',
    currency: 'XXX',
    method: 'bank',
  });
  assert.equal(corridor, null);
});
