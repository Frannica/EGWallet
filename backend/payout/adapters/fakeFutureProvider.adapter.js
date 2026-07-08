'use strict';

const { assertProviderAdapter, createAdapterBase } = require('./ProviderAdapter');

/**
 * Test-only future provider plug-in. Demonstrates that new rails require only
 * this file + configuration — no changes to Router, Registry, or Orchestrator.
 */
function createFakeFutureProviderAdapter(options = {}) {
  const id = options.id || 'rail_future_demo';
  const base = createAdapterBase(id);

  const adapter = {
    ...base,
    id,
    isConfigured() {
      return true;
    },
    supportsCorridor() {
      return true;
    },
    validateDestination(withdrawal, corridor) {
      const errors = [];
      for (const field of corridor.requiredFields || []) {
        if (!field.required) continue;
        const val = withdrawal[field.name];
        if (val === undefined || val === null || String(val).trim() === '') {
          errors.push(`missing:${field.name}`);
        }
      }
      return errors.length ? { valid: false, errors } : { valid: true };
    },
    async disburse(withdrawal, ctx) {
      return {
        success: true,
        settled: true,
        reference: `future-${ctx.idempotencyKey}`,
        status: 'paid',
        raw: { plugIn: id, corridor: ctx.corridor.corridorId },
      };
    },
    async queryStatus(reference) {
      if (!reference) return { status: 'unknown', reference: null };
      return { status: 'paid', reference };
    },
  };

  assertProviderAdapter(adapter);
  return adapter;
}

module.exports = createFakeFutureProviderAdapter;
module.exports.createFakeFutureProviderAdapter = createFakeFutureProviderAdapter;
