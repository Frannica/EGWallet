'use strict';
/**
 * Admin intervention policy — PERMANENT PRODUCT RULE
 *
 * Admin review is required ONLY when:
 *   1. Fraud or risk is detected
 *   2. AML / compliance requires review
 *   3. The account is restricted
 *
 * All other money operations run automatically (within KYC limits, balance, etc.).
 * Do not add routine admin-approval gates outside this module.
 */

const INTERVENTION_REASONS = Object.freeze({
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FRAUD_RISK:         'FRAUD_RISK',
  AML_COMPLIANCE:     'AML_COMPLIANCE',
});

/** Account cannot move money at all. */
function isAccountRestricted(user) {
  if (!user) return true;
  if (user.status === 'deleted') return true;
  if (user.accountStatus === 'suspended' || user.accountStatus === 'locked') return true;
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

/**
 * Returns why admin must intervene before money leaves the platform.
 * Restricted accounts are handled separately via isAccountRestricted (hard block).
 */
function getAdminInterventionReasons(user, db) {
  const reasons = [];
  if (hasFraudRisk(user, db)) reasons.push(INTERVENTION_REASONS.FRAUD_RISK);
  if (requiresAmlComplianceReview(user)) reasons.push(INTERVENTION_REASONS.AML_COMPLIANCE);
  return reasons;
}

function requiresAdminIntervention(user, db) {
  const reasons = getAdminInterventionReasons(user, db);
  return { required: reasons.length > 0, reasons };
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
    const code = user.accountStatus === 'suspended'
      ? 'ACCOUNT_SUSPENDED'
      : 'ACCOUNT_LOCKED';
    return {
      status: 403,
      body: {
        error: code === 'ACCOUNT_SUSPENDED'
          ? 'Account suspended. Contact support.'
          : 'Account locked. Contact support.',
        code,
      },
    };
  }

  const intervention = requiresAdminIntervention(user, db);
  if (intervention.required) {
    const code = intervention.reasons.includes(INTERVENTION_REASONS.FRAUD_RISK)
      ? 'FRAUD_REVIEW_REQUIRED'
      : 'COMPLIANCE_REVIEW_REQUIRED';
    return {
      status: 403,
      body: {
        error: code === 'FRAUD_REVIEW_REQUIRED'
          ? 'This operation requires a security review. Contact support.'
          : 'This operation requires compliance review. Contact support.',
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
  getAdminInterventionReasons,
  requiresAdminIntervention,
  blockMoneyOperation,
};
