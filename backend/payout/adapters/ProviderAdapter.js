'use strict';

/**
 * Validates that an object implements the ProviderAdapter contract.
 * @param {object} adapter
 * @returns {asserts adapter is import('./types').ProviderAdapter}
 */
function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('ProviderAdapter must be an object');
  }
  const required = [
    'id',
    'isConfigured',
    'supportsCorridor',
    'validateDestination',
    'disburse',
    'queryStatus',
    'parseWebhook',
    'classifyError',
  ];
  for (const key of required) {
    if (typeof adapter[key] !== 'function' && key !== 'id') {
      throw new TypeError(`ProviderAdapter missing function: ${key}`);
    }
  }
  if (typeof adapter.id !== 'string' || !adapter.id) {
    throw new TypeError('ProviderAdapter.id must be a non-empty string');
  }
}

/**
 * Base helpers shared by concrete adapter plug-ins (loaded from config only).
 */
function createAdapterBase(id) {
  return {
    id,
    classifyError(err) {
      const msg = (err && err.message) || '';
      if (err && err.code === 'ENOTFOUND') {
        return { kind: 'retryable', code: 'NETWORK', providerContacted: false };
      }
      if (err && err.providerContacted === true) {
        return { kind: 'ambiguous', code: 'PROVIDER_AMBIGUOUS', providerContacted: true };
      }
      if (msg.includes('not configured')) {
        return { kind: 'permanent', code: 'NOT_CONFIGURED', providerContacted: false };
      }
      return { kind: 'permanent', code: 'DISBURSE_REJECTED', providerContacted: !!err.providerContacted };
    },
    parseWebhook() {
      return null;
    },
  };
}

module.exports = {
  assertProviderAdapter,
  createAdapterBase,
};
