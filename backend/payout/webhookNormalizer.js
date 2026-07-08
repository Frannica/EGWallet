'use strict';

/**
 * Normalizes adapter webhook payloads into internal settlement events.
 * Phase A: contract + passthrough from adapter.parseWebhook only.
 */

/**
 * @param {import('./types').ProviderAdapter} adapter
 * @param {Buffer|string} rawBody
 * @param {object} headers
 * @returns {import('./types').WebhookParseResult|null}
 */
function normalizeWebhook(adapter, rawBody, headers) {
  if (!adapter || typeof adapter.parseWebhook !== 'function') return null;
  return adapter.parseWebhook(rawBody, headers);
}

module.exports = {
  normalizeWebhook,
};
