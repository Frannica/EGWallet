'use strict';

/**
 * Provider-independent payout domain types (JSDoc contracts).
 * No payment-vendor names belong in this module or sibling core modules.
 */

/**
 * @typedef {'bank'|'mobile_money'|'debit_card'|'credit_card'|'wallet'} PayoutMethod
 */

/**
 * @typedef {Object} PayoutCorridorKey
 * @property {string} country ISO-3166-1 alpha-2
 * @property {string} currency ISO-4217
 * @property {PayoutMethod} method
 */

/**
 * @typedef {Object} PayoutCorridor
 * @property {string} corridorId Stable id e.g. "NG-NGN-bank"
 * @property {string} country
 * @property {string} currency
 * @property {PayoutMethod} method
 * @property {PayoutFieldSpec[]} [requiredFields]
 * @property {AmountRules} [amountRules]
 */

/**
 * @typedef {Object} PayoutFieldSpec
 * @property {string} name
 * @property {boolean} required
 * @property {string} [labelKey] i18n key for mobile — never a vendor name
 */

/**
 * @typedef {Object} AmountRules
 * @property {boolean} minorUnits
 * @property {number} [step] e.g. 5 for currencies requiring multiples
 * @property {number} [minMinor]
 * @property {number} [maxMinor]
 */

/**
 * @typedef {Object} AdapterCandidate
 * @property {string} adapterId Opaque config id
 * @property {number} priority Lower = tried earlier when scores tie
 * @property {number} [costWeight] 0-1, higher = prefer lower cost when enabled
 */

/**
 * @typedef {Object} RankedCandidate
 * @property {string} adapterId
 * @property {number} score Composite routing score
 * @property {number} priority
 * @property {AdapterHealthSnapshot} health
 */

/**
 * @typedef {Object} AdapterHealthSnapshot
 * @property {boolean} configured
 * @property {boolean} circuitOpen
 * @property {number} successRate 0-1 rolling window
 * @property {number} latencyP95Ms
 * @property {number} availability 0-1
 * @property {number|null} lastSuccessAt epoch ms
 * @property {number|null} lastFailureAt epoch ms
 */

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} id Opaque adapter id matching config
 * @property {() => boolean} isConfigured
 * @property {(corridor: PayoutCorridor) => boolean} supportsCorridor
 * @property {(withdrawal: object, corridor: PayoutCorridor) => { valid: boolean, errors?: string[] }} validateDestination
 * @property {(withdrawal: object, ctx: DisburseContext) => Promise<DisburseResult>} disburse
 * @property {(reference: string) => Promise<StatusQueryResult>} queryStatus
 * @property {(rawBody: Buffer|string, headers: object) => WebhookParseResult|null} parseWebhook
 * @property {(err: Error) => ErrorClassification} classifyError
 */

/**
 * @typedef {Object} DisburseContext
 * @property {string} idempotencyKey
 * @property {PayoutCorridor} corridor
 * @property {object} [logger]
 */

/**
 * @typedef {Object} DisburseResult
 * @property {boolean} success
 * @property {boolean} settled True only when funds confirmed disbursed
 * @property {string|null} reference Provider-agnostic external reference
 * @property {'pending'|'paid'|'failed'} status
 * @property {object} [raw] Internal audit only — never expose to mobile clients
 */

/**
 * @typedef {Object} StatusQueryResult
 * @property {'unknown'|'absent'|'pending'|'paid'|'failed'} status
 * @property {string|null} reference
 */

/**
 * @typedef {Object} WebhookParseResult
 * @property {string} withdrawalId
 * @property {'pending'|'paid'|'failed'} status
 * @property {string|null} reference
 * @property {string} [eventId]
 */

/**
 * @typedef {'retryable'|'permanent'|'ambiguous'} ErrorKind
 */

/**
 * @typedef {Object} ErrorClassification
 * @property {ErrorKind} kind
 * @property {string} code Opaque internal code
 * @property {boolean} providerContacted
 * @property {boolean} [definitiveRejection] True only when provider confirmed no disbursement was created
 */

/**
 * @typedef {Object} OrchestratorResult
 * @property {'paid'|'processing'|'failed'|'reconcile'} outcome
 * @property {string|null} adapterId Winning adapter (internal only)
 * @property {string|null} reference
 * @property {PayoutAttemptRecord[]} attempts
 * @property {string|null} [failureReason]
 */

/**
 * @typedef {Object} PayoutAttemptRecord
 * @property {string} adapterId
 * @property {number} at epoch ms
 * @property {'success'|'pending'|'failed'|'skipped'} status
 * @property {string|null} reference
 * @property {string|null} errorCode
 * @property {ErrorKind|null} errorKind
 */

module.exports = {};
