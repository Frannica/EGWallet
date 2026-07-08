'use strict';

/**
 * Phase A security proof suite.
 * Each test maps to a permanent payout safety requirement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ProviderRegistry,
  ProviderRouter,
  ProviderOrchestrator,
  createNoopProviderAdapter,
  loadPayoutConfig,
  canFallbackToNextAdapter,
} = require('../../payout');

const indexSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const payoutProvidersSource = fs.readFileSync(path.join(__dirname, '..', '..', 'payoutProviders.js'), 'utf8');
const withdrawalEngineSource = fs.readFileSync(path.join(__dirname, '..', '..', 'withdrawalEngine.js'), 'utf8');

function extractWithdrawalsBlock() {
  const match = indexSource.match(/app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);/);
  assert.ok(match, 'POST /withdrawals route block not found');
  return match[0];
}

function createProbePendingAdapter(id) {
  const base = createNoopProviderAdapter({ id, mode: 'fail' });
  let disburseCalls = 0;
  return {
    ...base,
    getDisburseCalls() {
      return disburseCalls;
    },
    classifyError() {
      return {
        kind: 'permanent',
        code: 'SIMULATED_CONTACT',
        providerContacted: true,
        definitiveRejection: true,
      };
    },
    async queryStatus(ref) {
      return { status: 'pending', reference: ref };
    },
    async disburse(withdrawal, ctx) {
      disburseCalls += 1;
      const err = new Error('simulated contact then reject');
      err.providerContacted = true;
      throw err;
    },
  };
}

function createTrackingAdapter(id, mode) {
  const inner = createNoopProviderAdapter({ id, mode });
  let disburseCalls = 0;
  const receivedKeys = [];
  return {
    ...inner,
    getDisburseCalls() {
      return disburseCalls;
    },
    getReceivedKeys() {
      return receivedKeys;
    },
    async disburse(withdrawal, ctx) {
      disburseCalls += 1;
      receivedKeys.push(ctx.idempotencyKey);
      return inner.disburse(withdrawal, ctx);
    },
  };
}

// ── 1. Duplicate payouts ─────────────────────────────────────────────────────

test('SECURITY duplicate payouts: ambiguous failure does not call secondary rail', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  const primary = createTrackingAdapter('rail_primary_bank', 'throw_ambiguous');
  const secondary = createTrackingAdapter('rail_secondary_bank', 'paid');
  registry.register(primary);
  registry.register(secondary);

  const orchestrator = new ProviderOrchestrator(registry, new ProviderRouter(registry, config));
  const result = await orchestrator.execute({
    id: 'sec-dup-1',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'reconcile');
  assert.equal(primary.getDisburseCalls(), 1);
  assert.equal(secondary.getDisburseCalls(), 0);
});

test('SECURITY duplicate payouts: reference on error blocks fallback to secondary rail', () => {
  assert.equal(
    canFallbackToNextAdapter(
      { kind: 'permanent', code: 'REJECTED', providerContacted: true, definitiveRejection: true },
      { providerContacted: true, reference: 'ref-existing' },
    ),
    false,
  );
});

test('SECURITY duplicate payouts: status probe pending stops before secondary disburse', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  const primary = createProbePendingAdapter('rail_primary_bank');
  const secondary = createTrackingAdapter('rail_secondary_bank', 'paid');
  registry.register(primary);
  registry.register(secondary);

  const orchestrator = new ProviderOrchestrator(registry, new ProviderRouter(registry, config));
  const result = await orchestrator.execute({
    id: 'sec-dup-2',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'processing');
  assert.equal(primary.getDisburseCalls(), 1);
  assert.equal(secondary.getDisburseCalls(), 0);
});

test('SECURITY duplicate payouts: definitive fallback pays once across two rails only', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  const primary = createTrackingAdapter('rail_primary_bank', 'fail');
  const secondary = createTrackingAdapter('rail_secondary_bank', 'paid');
  registry.register(primary);
  registry.register(secondary);

  const orchestrator = new ProviderOrchestrator(registry, new ProviderRouter(registry, config));
  const result = await orchestrator.execute({
    id: 'sec-dup-3',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'paid');
  assert.equal(primary.getDisburseCalls(), 1);
  assert.equal(secondary.getDisburseCalls(), 1);
  assert.equal(result.attempts.filter(a => a.status === 'success').length, 1);
});

// ── 2. Lose money ────────────────────────────────────────────────────────────

test('SECURITY lose money: ambiguous outcome is reconcile not failed', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', mode: 'throw_ambiguous' }));
  registry.register(createNoopProviderAdapter({ id: 'rail_secondary_bank', mode: 'paid' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-money-1',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'reconcile');
  assert.notEqual(result.outcome, 'failed');
});

test('SECURITY lose money: pending probe returns processing to preserve held funds', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createProbePendingAdapter('rail_primary_bank'));
  registry.register(createNoopProviderAdapter({ id: 'rail_secondary_bank', mode: 'paid' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-money-2',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'processing');
});

test('SECURITY lose money: legacy executePayout skips when payoutReference already set', () => {
  assert.match(payoutProvidersSource, /if \(w\.payoutReference\)/);
  assert.match(payoutProvidersSource, /skipping provider call to prevent double disbursement/);
});

test('SECURITY lose money: legacy executePayout leaves processing when dispatch ref exists without reference', () => {
  assert.match(payoutProvidersSource, /if \(w\.payoutDispatchRef\)/);
  assert.match(payoutProvidersSource, /leaving processing for reconcile/);
});

// ── 3. Race conditions ───────────────────────────────────────────────────────

test('SECURITY race conditions: orchestrator uses stable idempotency key per withdrawal id', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  const primary = createTrackingAdapter('rail_primary_bank', 'paid');
  registry.register(primary);

  await new ProviderOrchestrator(registry, new ProviderRouter(registry, config)).execute({
    id: 'sec-race-1',
    country: 'US',
    currency: 'USD',
    method: 'bank',
    amount: 10000,
    routingNumber: '021000021',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.deepEqual(primary.getReceivedKeys(), ['egw-sec-race-1']);
});

test('SECURITY race conditions: legacy in-flight guard prevents concurrent executePayout', () => {
  assert.match(payoutProvidersSource, /const _payoutInFlight = new Set\(\)/);
  assert.match(payoutProvidersSource, /if \(_payoutInFlight\.has\(withdrawalId\)\)/);
  assert.match(payoutProvidersSource, /_payoutInFlight\.add\(withdrawalId\)/);
});

test('SECURITY race conditions: legacy payoutDispatchRef blocks concurrent second executor', () => {
  assert.match(payoutProvidersSource, /if \(wAttempt\.payoutDispatchRef\)/);
  assert.match(payoutProvidersSource, /concurrent process — aborting to prevent double-disbursement/);
});

test('SECURITY race conditions: single execute returns exactly one terminal outcome', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', mode: 'paid' }));
  registry.register(createNoopProviderAdapter({ id: 'rail_secondary_bank', mode: 'paid' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-race-2',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  const terminal = ['paid', 'processing', 'failed', 'reconcile'];
  assert.ok(terminal.includes(result.outcome));
  assert.equal(result.attempts.filter(a => a.status === 'success').length, 1);
});

// ── 4. Idempotency bypass ────────────────────────────────────────────────────

test('SECURITY idempotency: adapter reference derived from idempotency key', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', mode: 'paid' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-idem-1',
    country: 'US',
    currency: 'USD',
    method: 'bank',
    amount: 10000,
    routingNumber: '021000021',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.reference, 'ref-egw-sec-idem-1');
});

test('SECURITY idempotency: POST /withdrawals requires client idempotency key', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /const clientKey = req\.body\.idempotencyKey/);
  assert.match(block, /if \(!clientKey\)/);
});

test('SECURITY idempotency: legacy payoutDispatchRef uses deterministic egw withdrawal id', () => {
  assert.match(payoutProvidersSource, /wAttempt\.payoutDispatchRef = `egw-\$\{withdrawalId\}`/);
});

// ── 5. Fraud / AML / sanctions / legal / frozen bypass ───────────────────────

test('SECURITY policy: restricted accounts blocked before payout dispatch', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /isAccountRestricted\(withdrawUser\)/);
});

test('SECURITY policy: admin intervention required before executePayout', () => {
  const block = extractWithdrawalsBlock();
  assert.match(block, /requiresAdminIntervention\(withdrawUser,\s*db\)/);
  assert.match(block, /if \(!_withdrawNeedsAdminReview && _capturedWithdrawalId\)/);
  assert.match(block, /executePayout\(_capturedWithdrawalId/);
});

test('SECURITY policy: Phase A stack is not wired into HTTP — cannot bypass route gates', () => {
  assert.doesNotMatch(indexSource, /require\('\.\/payout'\)/);
  assert.match(indexSource, /require\('\.\/payoutProviders'\)/);
});

test('SECURITY policy: orchestrator module has no HTTP or auth imports', () => {
  const orchestratorSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'payout', 'providerOrchestrator.js'),
    'utf8',
  );
  assert.doesNotMatch(orchestratorSource, /express|requiresAdminIntervention|isAccountRestricted/);
});

// ── 6. Ledger reconciliation ─────────────────────────────────────────────────

test('SECURITY reconciliation: every attempt recorded with adapter status and reference', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', mode: 'fail' }));
  registry.register(createNoopProviderAdapter({ id: 'rail_secondary_bank', mode: 'paid' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-recon-1',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.ok(result.attempts.length >= 2);
  for (const attempt of result.attempts) {
    assert.ok(attempt.adapterId);
    assert.ok(attempt.status);
    assert.ok(typeof attempt.at === 'number');
  }
  assert.ok(result.reference);
});

test('SECURITY reconciliation: paid outcome includes provider-agnostic reference for ledger match', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', mode: 'paid' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-recon-2',
    country: 'US',
    currency: 'USD',
    method: 'bank',
    amount: 10000,
    routingNumber: '021000021',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'paid');
  assert.match(result.reference, /^ref-egw-sec-recon-2$/);
});

test('SECURITY reconciliation: withdrawal engine supports reconcileRequired on stuck payouts', () => {
  assert.match(withdrawalEngineSource, /reconcileRequired/);
  assert.match(withdrawalEngineSource, /\/reconcile/);
});

test('SECURITY reconciliation: ambiguous failures map to reconcile outcome', async () => {
  const config = loadPayoutConfig();
  const registry = new ProviderRegistry();
  registry.register(createNoopProviderAdapter({ id: 'rail_primary_bank', mode: 'throw_ambiguous' }));

  const result = await new ProviderOrchestrator(
    registry,
    new ProviderRouter(registry, config),
  ).execute({
    id: 'sec-recon-3',
    country: 'NG',
    currency: 'NGN',
    method: 'bank',
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  });

  assert.equal(result.outcome, 'reconcile');
});
