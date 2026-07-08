'use strict';

/**
 * Generic payout error classification helpers.
 * Vendor-specific classifiers live inside adapter plug-ins only.
 */

/**
 * @param {Error|null|undefined} err
 * @returns {import('./types').ErrorClassification}
 */
function classifyGenericError(err) {
  if (!err) {
    return { kind: 'permanent', code: 'UNKNOWN', providerContacted: false };
  }

  if (err.providerContacted === true) {
    if (err.kind === 'ambiguous') {
      return { kind: 'ambiguous', code: err.code || 'AMBIGUOUS', providerContacted: true };
    }
    return { kind: 'ambiguous', code: err.code || 'CONTACTED', providerContacted: true };
  }

  const msg = (err.message || '').toLowerCase();
  const retryableCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH']);

  if (err.code && retryableCodes.has(err.code)) {
    return { kind: 'retryable', code: 'NETWORK', providerContacted: false };
  }

  if (msg.includes('not configured') || msg.includes('missing')) {
    return { kind: 'permanent', code: 'NOT_CONFIGURED', providerContacted: false };
  }

  if (msg.includes('timeout')) {
    return { kind: 'ambiguous', code: 'TIMEOUT', providerContacted: true };
  }

  return { kind: 'permanent', code: 'REJECTED', providerContacted: false };
}

module.exports = {
  classifyGenericError,
};
