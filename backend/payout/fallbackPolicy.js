'use strict';

/**
 * Determines whether orchestrator may attempt the next adapter after a failure.
 * Preserves double-disbursement safety rules from the legacy payout engine.
 */

/**
 * @param {import('./types').ErrorClassification} classification
 * @param {object} attemptState
 * @param {boolean} attemptState.providerContacted
 * @param {string|null} attemptState.reference
 * @returns {boolean}
 */
function canFallbackToNextAdapter(classification, attemptState) {
  if (attemptState.reference) return false;

  if (classification.kind === 'ambiguous') return false;
  if (classification.providerContacted && classification.kind !== 'permanent') {
    return false;
  }

  if (classification.kind === 'permanent' && !classification.providerContacted) {
    return true;
  }

  if (classification.kind === 'permanent' && classification.providerContacted) {
    return classification.definitiveRejection === true;
  }

  if (classification.kind === 'retryable' && !classification.providerContacted) {
    return true;
  }

  return false;
}

/**
 * Whether the same adapter may retry once before fallback.
 * @param {import('./types').ErrorClassification} classification
 * @param {number} attemptsOnAdapter
 */
function canRetrySameAdapter(classification, attemptsOnAdapter) {
  if (attemptsOnAdapter >= 1) return false;
  return classification.kind === 'retryable' && !classification.providerContacted;
}

module.exports = {
  canFallbackToNextAdapter,
  canRetrySameAdapter,
};
