'use strict';

const { validateDestination } = require('./destinationValidator');
const { canFallbackToNextAdapter, canRetrySameAdapter } = require('./fallbackPolicy');
const { classifyGenericError } = require('./payoutErrorClassifier');

/**
 * ProviderOrchestrator — dispatches withdrawals to ranked adapter plug-ins.
 * Does not import withdrawalEngine or vendor SDKs. Phase A: standalone; Phase B wires to HTTP.
 */
class ProviderOrchestrator {
  /**
   * @param {import('./providerRegistry').ProviderRegistry} registry
   * @param {import('./providerRouter').ProviderRouter} router
   * @param {object} [options]
   * @param {object} [options.logger]
   */
  constructor(registry, router, options = {}) {
    this.registry = registry;
    this.router = router;
    this.logger = options.logger || console;
  }

  /**
   * Execute payout for a withdrawal against ranked adapters.
   * @param {object} withdrawal Must include id, amount, country, currency, method
   * @returns {Promise<import('./types').OrchestratorResult>}
   */
  async execute(withdrawal) {
    const key = {
      country: withdrawal.country || withdrawal.destinationCountry,
      currency: withdrawal.currency,
      method: normalizeMethod(withdrawal.method),
    };

    const corridor = this.router.resolveCorridor(key);
    if (!corridor) {
      return {
        outcome: 'failed',
        adapterId: null,
        reference: null,
        attempts: [],
        failureReason: 'CORRIDOR_NOT_CONFIGURED',
      };
    }

    const destCheck = validateDestination(withdrawal, corridor);
    if (!destCheck.valid) {
      return {
        outcome: 'failed',
        adapterId: null,
        reference: null,
        attempts: [],
        failureReason: `DESTINATION_INVALID:${destCheck.errors.join(',')}`,
      };
    }

    const ranked = this.router.rankCandidates(corridor);
    if (!ranked.length) {
      return {
        outcome: 'failed',
        adapterId: null,
        reference: null,
        attempts: [],
        failureReason: 'NO_RAIL_AVAILABLE',
      };
    }

    const attempts = [];
    const idempotencyKey = `egw-${withdrawal.id}`;

    for (const candidate of ranked) {
      const adapter = this.registry.get(candidate.adapterId);
      if (!adapter) continue;

      const adapterValidation = adapter.validateDestination(withdrawal, corridor);
      if (!adapterValidation.valid) {
        attempts.push(buildAttempt(candidate.adapterId, 'skipped', null, 'DESTINATION_INVALID', null));
        continue;
      }

      let triesOnAdapter = 0;
      let continueAdapter = true;

      while (continueAdapter) {
        continueAdapter = false;
        const started = Date.now();

        try {
          const result = await adapter.disburse(withdrawal, {
            idempotencyKey,
            corridor,
            logger: this.logger,
          });

          this.registry.recordSuccess(candidate.adapterId, Date.now() - started);

          if (result.settled && result.status === 'paid') {
            attempts.push(buildAttempt(candidate.adapterId, 'success', result.reference, null, null));
            return {
              outcome: 'paid',
              adapterId: candidate.adapterId,
              reference: result.reference,
              attempts,
            };
          }

          attempts.push(buildAttempt(candidate.adapterId, 'pending', result.reference, null, null));
          return {
            outcome: 'processing',
            adapterId: candidate.adapterId,
            reference: result.reference,
            attempts,
          };
        } catch (err) {
          this.registry.recordFailure(candidate.adapterId);
          const classification = typeof adapter.classifyError === 'function'
            ? adapter.classifyError(err)
            : classifyGenericError(err);

          attempts.push(buildAttempt(
            candidate.adapterId,
            'failed',
            null,
            classification.code,
            classification.kind,
          ));

          if (canRetrySameAdapter(classification, triesOnAdapter)) {
            triesOnAdapter += 1;
            continueAdapter = true;
            continue;
          }

          const attemptState = {
            providerContacted: classification.providerContacted,
            reference: err.reference || null,
          };

          if (canFallbackToNextAdapter(classification, attemptState)) {
            if (classification.providerContacted) {
              const probeRef = attemptState.reference || `ref-${idempotencyKey}`;
              try {
                const statusResult = await adapter.queryStatus(probeRef);
                if (statusResult.status === 'paid') {
                  attempts.push(buildAttempt(candidate.adapterId, 'success', statusResult.reference, null, null));
                  return {
                    outcome: 'paid',
                    adapterId: candidate.adapterId,
                    reference: statusResult.reference,
                    attempts,
                  };
                }
                if (statusResult.status === 'pending') {
                  attempts.push(buildAttempt(candidate.adapterId, 'pending', statusResult.reference, null, null));
                  return {
                    outcome: 'processing',
                    adapterId: candidate.adapterId,
                    reference: statusResult.reference,
                    attempts,
                  };
                }
              } catch (_probeErr) {
                return {
                  outcome: 'reconcile',
                  adapterId: candidate.adapterId,
                  reference: null,
                  attempts,
                  failureReason: 'STATUS_PROBE_FAILED',
                };
              }
            }
            break;
          }

          return {
            outcome: classification.kind === 'ambiguous' ? 'reconcile' : 'failed',
            adapterId: candidate.adapterId,
            reference: null,
            attempts,
            failureReason: classification.code,
          };
        }
      }
    }

    return {
      outcome: 'failed',
      adapterId: null,
      reference: null,
      attempts,
      failureReason: 'ALL_RAILS_EXHAUSTED',
    };
  }
}

function normalizeMethod(method) {
  if (method === 'mobile') return 'mobile_money';
  if (method === 'debit' || method === 'credit') return 'debit_card';
  return method;
}

function buildAttempt(adapterId, status, reference, errorCode, errorKind) {
  return {
    adapterId,
    at: Date.now(),
    status,
    reference,
    errorCode,
    errorKind,
  };
}

module.exports = {
  ProviderOrchestrator,
  normalizeMethod,
};
