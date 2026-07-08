'use strict';

/**
 * Provider-independent payout domain — public entry point.
 * Vendor integrations exist only as config-loaded adapter plug-ins.
 */

const { loadPayoutConfig, buildCorridorId, resolveCorridorDefinition } = require('./config/loadPayoutConfig');
const { ProviderRegistry } = require('./providerRegistry');
const { ProviderRouter } = require('./providerRouter');
const { ProviderOrchestrator } = require('./providerOrchestrator');
const { validateDestination } = require('./destinationValidator');
const { canFallbackToNextAdapter, canRetrySameAdapter } = require('./fallbackPolicy');
const { classifyGenericError } = require('./payoutErrorClassifier');
const { normalizeWebhook } = require('./webhookNormalizer');
const { assertProviderAdapter, createAdapterBase } = require('./adapters/ProviderAdapter');
const { createNoopProviderAdapter } = require('./adapters/noopProvider.adapter');

/**
 * Bootstrap a fully wired payout stack from JSON config (tests / future HTTP wiring).
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {object} [options.config] Pre-parsed config (overrides file)
 * @param {import('./providerRegistry').ProviderRegistry} [options.registry]
 */
function createPayoutStack(options = {}) {
  const config = options.config || loadPayoutConfig(options.configPath);
  const registry = options.registry || new ProviderRegistry();
  if (!options.registry) {
    registry.loadFromConfig(config, __dirname);
  }
  const router = new ProviderRouter(registry, config);
  const orchestrator = new ProviderOrchestrator(registry, router, { logger: options.logger });
  return { config, registry, router, orchestrator };
}

module.exports = {
  loadPayoutConfig,
  buildCorridorId,
  resolveCorridorDefinition,
  ProviderRegistry,
  ProviderRouter,
  ProviderOrchestrator,
  validateDestination,
  canFallbackToNextAdapter,
  canRetrySameAdapter,
  classifyGenericError,
  normalizeWebhook,
  assertProviderAdapter,
  createAdapterBase,
  createNoopProviderAdapter,
  createPayoutStack,
};
