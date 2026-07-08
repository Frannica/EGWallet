'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default.corridors.json');

/**
 * Load payout routing configuration from JSON.
 * Vendor-specific integrations are registered only via adapter module paths in config.
 *
 * @param {string} [configPath]
 * @returns {object}
 */
function loadPayoutConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  if (!config || typeof config !== 'object') {
    throw new Error('Payout config must be an object');
  }
  if (!config.adapters || typeof config.adapters !== 'object') {
    throw new Error('Payout config requires adapters map');
  }
  if (!config.corridors || typeof config.corridors !== 'object') {
    throw new Error('Payout config requires corridors map');
  }

  config.routingWeights = config.routingWeights || {
    health: 0.35,
    successRate: 0.25,
    latency: 0.2,
    availability: 0.15,
    cost: 0.05,
  };

  return config;
}

/**
 * Build canonical corridor id from key parts.
 * @param {string} country
 * @param {string} currency
 * @param {string} method
 */
function buildCorridorId(country, currency, method) {
  return `${String(country).toUpperCase()}-${String(currency).toUpperCase()}-${method}`;
}

/**
 * Resolve corridor definition from country/currency/method.
 * @param {object} config
 * @param {{ country: string, currency: string, method: string }} key
 */
function resolveCorridorDefinition(config, key) {
  const corridorId = buildCorridorId(key.country, key.currency, key.method);
  const def = config.corridors[corridorId];
  if (!def) return null;

  return {
    corridorId,
    country: def.country || key.country,
    currency: def.currency || key.currency,
    method: def.method || key.method,
    requiredFields: def.requiredFields || [],
    amountRules: def.amountRules || { minorUnits: true },
    candidates: def.candidates || [],
  };
}

module.exports = {
  loadPayoutConfig,
  buildCorridorId,
  resolveCorridorDefinition,
  DEFAULT_CONFIG_PATH,
};
