'use strict';

const { resolveCorridorDefinition } = require('./config/loadPayoutConfig');

const DEFAULT_MAX_LATENCY_MS = 10_000;

/**
 * Scores and ranks adapter candidates for a corridor.
 * Uses health, success rate, latency, availability, and cost — never vendor identity.
 */
class ProviderRouter {
  /**
   * @param {import('./providerRegistry').ProviderRegistry} registry
   * @param {object} config
   */
  constructor(registry, config) {
    this.registry = registry;
    this.config = config;
    this.weights = config.routingWeights || {
      health: 0.35,
      successRate: 0.25,
      latency: 0.2,
      availability: 0.15,
      cost: 0.05,
    };
  }

  /**
   * @param {{ country: string, currency: string, method: string }} key
   * @returns {import('./types').PayoutCorridor|null}
   */
  resolveCorridor(key) {
    return resolveCorridorDefinition(this.config, key);
  }

  /**
   * Rank configured candidates for a corridor (fastest/healthiest/most reliable first).
   * @param {import('./types').PayoutCorridor} corridor
   * @returns {import('./types').RankedCandidate[]}
   */
  rankCandidates(corridor) {
    if (!corridor || !corridor.candidates?.length) return [];

    const ranked = [];
    for (const candidate of corridor.candidates) {
      const adapter = this.registry.get(candidate.adapterId);
      if (!adapter) continue;
      if (!adapter.supportsCorridor(corridor)) continue;

      const health = this.registry.getHealthSnapshot(candidate.adapterId, adapter);
      if (!health.configured) continue;
      if (health.circuitOpen) continue;

      const score = this._scoreCandidate(candidate, health);
      ranked.push({
        adapterId: candidate.adapterId,
        score,
        priority: candidate.priority ?? 999,
        health,
      });
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.priority - b.priority;
    });

    return ranked;
  }

  /**
   * @param {import('./types').AdapterCandidate} candidate
   * @param {import('./types').AdapterHealthSnapshot} health
   */
  _scoreCandidate(candidate, health) {
    const w = this.weights;
    const healthScore = health.circuitOpen ? 0 : 1;
    const successScore = health.successRate;
    const latencyScore = 1 - Math.min(1, health.latencyP95Ms / DEFAULT_MAX_LATENCY_MS);
    const availabilityScore = health.availability;
    const costWeight = candidate.costWeight ?? 0.5;
    const costScore = 1 - Math.min(1, costWeight);

    return (
      w.health * healthScore
      + w.successRate * successScore
      + w.latency * latencyScore
      + w.availability * availabilityScore
      + w.cost * costScore
    );
  }

  /**
   * Whether any rail is ready for this corridor (pre-hold gate for future wiring).
   * @param {{ country: string, currency: string, method: string }} key
   */
  isCorridorReady(key) {
    const corridor = this.resolveCorridor(key);
    if (!corridor) return false;
    return this.rankCandidates(corridor).length > 0;
  }

  /**
   * Public corridor metadata for mobile (no adapter or vendor names).
   * @param {{ country: string, currency: string, method: string }} key
   */
  getCorridorMetadata(key) {
    const corridor = this.resolveCorridor(key);
    if (!corridor) return null;

    return {
      corridorId: corridor.corridorId,
      country: corridor.country,
      currency: corridor.currency,
      method: corridor.method,
      requiredFields: corridor.requiredFields,
      amountRules: corridor.amountRules,
      available: this.rankCandidates(corridor).length > 0,
    };
  }
}

module.exports = {
  ProviderRouter,
  DEFAULT_MAX_LATENCY_MS,
};
