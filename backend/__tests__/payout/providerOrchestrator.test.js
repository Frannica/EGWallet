'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPayoutStack,
  ProviderRegistry,
  ProviderRouter,
  ProviderOrchestrator,
} = require('../../payout');
const { createNoopProviderAdapter } = require('../../payout/adapters/noopProvider.adapter');
const { loadPayoutConfig } = require('../../payout/config/loadPayoutConfig');

test('ProviderOrchestrator completes paid outcome on successful rail', async () => {
  const { orchestrator } = createPayoutStack();
  const result = await orchestrator.execute({
    id: 'wd-test-1',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'paid');
  assert.ok(result.reference);
  assert.ok(result.adapterId);
  assert.ok(result.attempts.length >= 1);
});

test('ProviderOrchestrator falls back when primary rail fails permanently', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({
    id: 'rail_primary_bank',
    mode: 'fail',
  }));
  registry.register(createNoopProviderAdapter({
    id: 'rail_secondary_bank',
    mode: 'paid',
  }));

  const router = new ProviderRouter(registry, config);
  const orchestrator = new ProviderOrchestrator(registry, router);

  const result = await orchestrator.execute({
    id: 'wd-test-2',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'paid');
  assert.equal(result.adapterId, 'rail_secondary_bank');
  assert.ok(result.attempts.length >= 2);
});

test('ProviderOrchestrator returns reconcile on ambiguous failure', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({
    id: 'rail_primary_bank',
    mode: 'throw_ambiguous',
  }));
  registry.register(createNoopProviderAdapter({
    id: 'rail_secondary_bank',
    mode: 'paid',
  }));

  const router = new ProviderRouter(registry, config);
  const orchestrator = new ProviderOrchestrator(registry, router);

  const result = await orchestrator.execute({
    id: 'wd-test-3',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'reconcile');
  assert.equal(result.adapterId, 'rail_primary_bank');
});

test('ProviderOrchestrator returns failed when corridor not configured', async () => {
  const { orchestrator } = createPayoutStack();
  const result = await orchestrator.execute({
    id: 'wd-test-4',
    country: 'ZZ',
    currency: 'ZZZ',
    method: 'bank',
    amount: 100,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failureReason, 'CORRIDOR_NOT_CONFIGURED');
});
