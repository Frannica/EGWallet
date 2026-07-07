'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  INTERVENTION_REASONS,
  isAccountRestricted,
  hasFraudRisk,
  requiresAmlComplianceReview,
  requiresAdminIntervention,
  blockMoneyOperation,
} = require('../adminInterventionPolicy');

const baseUser = {
  id: 'u1',
  accountStatus: 'active',
  kycStatus: 'approved',
  riskFlags: undefined,
};

const emptyDb = { fraudAlerts: [], disputes: [] };

test('isAccountRestricted blocks suspended, locked, and timed lock', () => {
  assert.equal(isAccountRestricted({ ...baseUser, accountStatus: 'suspended' }), true);
  assert.equal(isAccountRestricted({ ...baseUser, accountStatus: 'locked' }), true);
  assert.equal(isAccountRestricted({ ...baseUser, lockedUntil: Date.now() + 60_000 }), true);
  assert.equal(isAccountRestricted(baseUser), false);
});

test('hasFraudRisk detects flags, holds, alerts, and disputes', () => {
  assert.equal(hasFraudRisk({ ...baseUser, riskFlags: ['multiple_accounts_same_device'] }, emptyDb), true);
  assert.equal(hasFraudRisk({ ...baseUser, fraudHold: true }, emptyDb), true);
  assert.equal(
    hasFraudRisk(baseUser, { fraudAlerts: [{ userId: 'u1', status: 'open' }], disputes: [] }),
    true,
  );
  assert.equal(
    hasFraudRisk(baseUser, { fraudAlerts: [], disputes: [{ userId: 'u1', status: 'investigating' }] }),
    true,
  );
  assert.equal(hasFraudRisk(baseUser, emptyDb), false);
});

test('requiresAmlComplianceReview detects compliance holds and under_review KYC', () => {
  assert.equal(requiresAmlComplianceReview({ ...baseUser, complianceHold: true }), true);
  assert.equal(requiresAmlComplianceReview({ ...baseUser, amlHold: true }), true);
  assert.equal(requiresAmlComplianceReview({ ...baseUser, kycStatus: 'under_review' }), true);
  assert.equal(requiresAmlComplianceReview(baseUser), false);
});

test('requiresAdminIntervention only for fraud/risk and AML — not normal users', () => {
  assert.deepEqual(requiresAdminIntervention(baseUser, emptyDb), { required: false, reasons: [] });
  const fraud = requiresAdminIntervention({ ...baseUser, fraudHold: true }, emptyDb);
  assert.equal(fraud.required, true);
  assert.ok(fraud.reasons.includes(INTERVENTION_REASONS.FRAUD_RISK));
  const aml = requiresAdminIntervention({ ...baseUser, kycStatus: 'under_review' }, emptyDb);
  assert.equal(aml.required, true);
  assert.ok(aml.reasons.includes(INTERVENTION_REASONS.AML_COMPLIANCE));
});

test('blockMoneyOperation returns 403 for restricted and review-required users', () => {
  const restricted = blockMoneyOperation({ ...baseUser, accountStatus: 'suspended' }, emptyDb);
  assert.equal(restricted.status, 403);
  assert.equal(restricted.body.code, 'ACCOUNT_SUSPENDED');

  const fraud = blockMoneyOperation({ ...baseUser, fraudHold: true }, emptyDb);
  assert.equal(fraud.status, 403);
  assert.equal(fraud.body.code, 'FRAUD_REVIEW_REQUIRED');

  const aml = blockMoneyOperation({ ...baseUser, amlHold: true }, emptyDb);
  assert.equal(aml.status, 403);
  assert.equal(aml.body.code, 'COMPLIANCE_REVIEW_REQUIRED');

  assert.equal(blockMoneyOperation(baseUser, emptyDb), null);
});
