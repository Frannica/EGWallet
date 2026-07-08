'use strict';

const path = require('path');
const { assertProviderAdapter } = require('./adapters/ProviderAdapter');

const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
const DEFAULT_LATENCY_BASELINE_MS = 3_000;

/**
 * Registry for payout adapter plug-ins. Core code never imports vendor modules directly —
 * adapters are loaded from configuration module paths only.
 */
class ProviderRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.circuitFailureThreshold]
   * @param {number} [options.circuitCooldownMs]
   */
  constructor(options = {}) {
    this._adapters = new Map();
    this._health = new Map();
    this._circuitFailureThreshold = options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this._circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
  }

  /** @param {import('./types').ProviderAdapter} adapter */
  register(adapter) {
    assertProviderAdapter(adapter);
    this._adapters.set(adapter.id, adapter);
    if (!this._health.has(adapter.id)) {
      this._health.set(adapter.id, this._freshHealth());
    }
    return this;
  }

  /** @param {string} adapterId */
  get(adapterId) {
    return this._adapters.get(adapterId) || null;
  }

  /** @returns {string[]} */
  listAdapterIds() {
    return [...this._adapters.keys()];
  }

  /**
   * Load adapter plug-ins declared in config.adapters.
   * @param {object} config
   * @param {string} [configBaseDir]
   */
  loadFromConfig(config, configBaseDir) {
    const base = path.resolve(configBaseDir || __dirname);
    for (const [adapterId, entry] of Object.entries(config.adapters || {})) {
      if (!entry || entry.enabled === false) continue;
      if (!entry.module) {
        throw new Error(`Adapter ${adapterId} missing module path in config`);
      }
      const modPath = path.resolve(base, entry.module);
      const rel = path.relative(base, modPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Adapter ${adapterId} module path escapes payout package directory`);
      }
      const factory = require(modPath);
      const instance = typeof factory === 'function'
        ? factory({ id: adapterId, configured: true })
        : factory;
      if (!instance.id) instance.id = adapterId;
      this.register(instance);
    }
    return this;
  }

  _freshHealth() {
    return {
      configured: true,
      circuitOpen: false,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 1,
      latencyP95Ms: DEFAULT_LATENCY_BASELINE_MS,
      latencySamples: [],
      availability: 1,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
  }

  _getHealth(adapterId) {
    if (!this._health.has(adapterId)) {
      this._health.set(adapterId, this._freshHealth());
    }
    return this._health.get(adapterId);
  }

  /** Re-open circuit after cooldown. */
  _maybeCloseCircuit(adapterId) {
    const h = this._getHealth(adapterId);
    if (!h.circuitOpen) return;
    if (Date.now() - h.circuitOpenedAt >= this._circuitCooldownMs) {
      h.circuitOpen = false;
      h.consecutiveFailures = 0;
      h.circuitOpenedAt = null;
    }
  }

  isCircuitOpen(adapterId) {
    this._maybeCloseCircuit(adapterId);
    return this._getHealth(adapterId).circuitOpen;
  }

  /** @returns {import('./types').AdapterHealthSnapshot} */
  getHealthSnapshot(adapterId, adapter) {
    this._maybeCloseCircuit(adapterId);
    const h = this._getHealth(adapterId);
    const configured = adapter ? adapter.isConfigured() : false;
    return {
      configured,
      circuitOpen: h.circuitOpen,
      successRate: h.successRate,
      latencyP95Ms: h.latencyP95Ms,
      availability: configured && !h.circuitOpen ? h.availability : 0,
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
    };
  }

  recordSuccess(adapterId, latencyMs = DEFAULT_LATENCY_BASELINE_MS) {
    const h = this._getHealth(adapterId);
    h.successCount += 1;
    h.consecutiveFailures = 0;
    h.lastSuccessAt = Date.now();
    h.latencySamples.push(latencyMs);
    if (h.latencySamples.length > 100) h.latencySamples.shift();
    h.latencyP95Ms = this._percentile(h.latencySamples, 0.95);
    const total = h.successCount + h.failureCount;
    h.successRate = total ? h.successCount / total : 1;
    h.availability = Math.min(1, 0.5 + h.successRate * 0.5);
  }

  recordFailure(adapterId) {
    const h = this._getHealth(adapterId);
    h.failureCount += 1;
    h.consecutiveFailures += 1;
    h.lastFailureAt = Date.now();
    const total = h.successCount + h.failureCount;
    h.successRate = total ? h.successCount / total : 0;
    h.availability = Math.max(0, h.successRate * 0.8);
    if (h.consecutiveFailures >= this._circuitFailureThreshold) {
      h.circuitOpen = true;
      h.circuitOpenedAt = Date.now();
    }
  }

  _percentile(samples, p) {
    if (!samples.length) return DEFAULT_LATENCY_BASELINE_MS;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
  }
}

module.exports = {
  ProviderRegistry,
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_COOLDOWN_MS,
};
