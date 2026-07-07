'use strict';
/**
 * Admin intervention policy — PERMANENT PRODUCT RULE
 *
 * Admin review is required ONLY when:
 *   1. Fraud or risk is detected
 *   2. AML / compliance requires review
 *   3. Sanctions match or hold
 *   4. Court order / legal hold
 *   5. The account is restricted or frozen
 *
 * All other money operations run automatically (within send KYC limits, balance, etc.).
 * Do not add routine admin-approval gates outside this module.
 */

const INTERVENTION_REASONS = Object.freeze({
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FRAUD_RISK:         'FRAUD_RISK',
  AML_COMPLIANCE:     'AML_COMPLIANCE',
  SANCTIONS:          'SANCTIONS',
  LEGAL_HOLD:         'LEGAL_HOLD',
});

/** Account cannot move money at all. */
function isAccountRestricted(user) {
  if (!user) return true;
  if (user.status === 'deleted') return true;
  if (user.accountStatus === 'suspended' || user.accountStatus === 'locked' || user.accountStatus === 'frozen') {
    return true;
  }
  if (user.lockedUntil && user.lockedUntil > Date.now()) return true;
  return false;
}

function hasOpenFraudAlert(db, userId) {
  return (db.fraudAlerts || []).some(
    a => a.userId === userId && a.status !== 'closed' && a.status !== 'resolved',
  );
}

function hasOpenDispute(db, userId) {
  return (db.disputes || []).some(
    d => d.userId === userId && ['open', 'investigating', 'under_review'].includes(d.status),
  );
}

function hasFraudRisk(user, db) {
  if (!user) return false;
  if (user.fraudHold === true) return true;
  if (Array.isArray(user.riskFlags) && user.riskFlags.length > 0) return true;
  if (hasOpenFraudAlert(db, user.id)) return true;
  if (hasOpenDispute(db, user.id)) return true;
  return false;
}

function requiresAmlComplianceReview(user) {
  if (!user) return false;
  if (user.complianceHold === true || user.amlHold === true) return true;
  if (user.kycStatus === 'under_review') return true;
  return false;
}

function requiresSanctionsReview(user) {
  if (!user) return false;
  if (user.sanctionsHold === true) return true;
  if (user.sanctionsMatch === true) return true;
  return false;
}

function requiresLegalHoldReview(user) {
  if (!user) return false;
  if (user.courtOrderHold === true) return true;
  if (user.legalHold === true) return true;
  return false;
}

/**
 * Returns why admin must intervene before money leaves the platform.
 * Restricted/frozen accounts are handled separately via isAccountRestricted (hard block).
 */
function getAdminInterventionReasons(user, db) {
  const reasons = [];
  if (hasFraudRisk(user, db)) reasons.push(INTERVENTION_REASONS.FRAUD_RISK);
  if (requiresAmlComplianceReview(user)) reasons.push(INTERVENTION_REASONS.AML_COMPLIANCE);
  if (requiresSanctionsReview(user)) reasons.push(INTERVENTION_REASONS.SANCTIONS);
  if (requiresLegalHoldReview(user)) reasons.push(INTERVENTION_REASONS.LEGAL_HOLD);
  return reasons;
}

function requiresAdminIntervention(user, db) {
  const reasons = getAdminInterventionReasons(user, db);
  return { required: reasons.length > 0, reasons };
}

function interventionBlockCode(reasons) {
  if (reasons.includes(INTERVENTION_REASONS.FRAUD_RISK)) return 'FRAUD_REVIEW_REQUIRED';
  if (reasons.includes(INTERVENTION_REASONS.SANCTIONS)) return 'SANCTIONS_REVIEW_REQUIRED';
  if (reasons.includes(INTERVENTION_REASONS.LEGAL_HOLD)) return 'LEGAL_HOLD_REVIEW_REQUIRED';
  return 'COMPLIANCE_REVIEW_REQUIRED';
}

function interventionBlockMessage(code) {
  switch (code) {
    case 'FRAUD_REVIEW_REQUIRED':
      return 'This operation requires a security review. Contact support.';
    case 'SANCTIONS_REVIEW_REQUIRED':
      return 'This operation requires sanctions review. Contact support.';
    case 'LEGAL_HOLD_REVIEW_REQUIRED':
      return 'This operation is subject to a legal hold. Contact support.';
    default:
      return 'This operation requires compliance review. Contact support.';
  }
}

/**
 * Hard block for money movement. Returns an HTTP payload or null when allowed.
 */
function blockMoneyOperation(user, db, lang = 'en') {
  if (!user) {
    return {
      status: 404,
      body: { error: 'User not found', code: 'USER_NOT_FOUND' },
    };
  }

  if (isAccountRestricted(user)) {
    let code = 'ACCOUNT_LOCKED';
    let error = 'Account locked. Contact support.';
    if (user.accountStatus === 'suspended') {
      code = 'ACCOUNT_SUSPENDED';
      error = 'Account suspended. Contact support.';
    } else if (user.accountStatus === 'frozen') {
      code = 'ACCOUNT_FROZEN';
      error = 'Account frozen. Contact support.';
    }
    return {
      status: 403,
      body: { error, code },
    };
  }

  const intervention = requiresAdminIntervention(user, db);
  if (intervention.required) {
    const code = interventionBlockCode(intervention.reasons);
    return {
      status: 403,
      body: {
        error: interventionBlockMessage(code),
        code,
        reasons: intervention.reasons,
      },
    };
  }

  return null;
}

module.exports = {
  INTERVENTION_REASONS,
  isAccountRestricted,
  hasFraudRisk,
  requiresAmlComplianceReview,
  requiresSanctionsReview,
  requiresLegalHoldReview,
  getAdminInterventionReasons,
  requiresAdminIntervention,
  blockMoneyOperation,
};
