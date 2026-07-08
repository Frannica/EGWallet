'use strict';

const { assertProviderAdapter, createAdapterBase } = require('./ProviderAdapter');

/**
 * No-op adapter for tests and development. Simulates configurable outcomes without external APIs.
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {boolean} [options.configured]
 * @param {Set<string>} [options.supportedCorridorIds]
 * @param {'paid'|'pending'|'fail'|'throw_ambiguous'} [options.mode]
 */
function createNoopProviderAdapter(options = {}) {
  const id = options.id || 'rail_noop';
  const base = createAdapterBase(id);
  const supported = options.supportedCorridorIds || null;
  const mode = options.mode || 'paid';

  const adapter = {
    ...base,
    id,
    isConfigured() {
      return options.configured !== false;
    },
    supportsCorridor(corridor) {
      if (!this.isConfigured()) return false;
      if (!supported) return true;
      return supported.has(corridor.corridorId);
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
      if (mode === 'fail') {
        const err = new Error('simulated permanent rejection');
        err.providerContacted = true;
        throw err;
      }
      if (mode === 'throw_ambiguous') {
        const err = new Error('simulated ambiguous timeout');
        err.providerContacted = true;
        throw err;
      }
      const reference = `ref-${ctx.idempotencyKey}`;
      return {
        success: true,
        settled: mode === 'paid',
        reference,
        status: mode === 'paid' ? 'paid' : 'pending',
        raw: { simulated: true, withdrawalId: withdrawal.id },
      };
    },
    async queryStatus(reference) {
      if (!reference) return { status: 'unknown', reference: null };
      if (mode === 'fail') return { status: 'failed', reference };
      if (mode === 'pending' || mode === 'throw_ambiguous') {
        return { status: 'pending', reference };
      }
      return { status: 'paid', reference };
    },
    classifyError(err) {
      if (mode === 'fail') {
        return {
          kind: 'permanent',
          code: 'SIMULATED_REJECT',
          providerContacted: true,
          definitiveRejection: true,
        };
      }
      if (mode === 'throw_ambiguous') {
        return { kind: 'ambiguous', code: 'SIMULATED_AMBIGUOUS', providerContacted: true };
      }
      return base.classifyError(err);
    },
  };

  assertProviderAdapter(adapter);
  return adapter;
}

/** Default export used when config loads this module as a plug-in factory. */
module.exports = createNoopProviderAdapter;
module.exports.createNoopProviderAdapter = createNoopProviderAdapter;
