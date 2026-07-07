'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KYC_TIERS,
  getEffectiveKycTier,
  isFullKyc,
  getTierLimitsForUser,
} = require('../kycLimits');

test('full KYC tier 2 requires kycTier >= 2 and kycStatus approved', () => {
  assert.equal(getEffectiveKycTier({ kycTier: 2, kycStatus: 'approved' }), 2);
  assert.equal(isFullKyc({ kycTier: 2, kycStatus: 'approved' }), true);
  assert.equal(getEffectiveKycTier({ kycTier: 2, kycStatus: 'pending' }), 1);
  assert.equal(isFullKyc({ kycTier: 2, kycStatus: 'pending' }), false);
  assert.equal(getEffectiveKycTier({ kycTier: 1, kycStatus: 'approved' }), 1);
  assert.equal(getEffectiveKycTier({ kycTier: 0, kycStatus: 'approved' }), 0);
});

test('verified tier daily send limit is $5,000', () => {
  assert.equal(KYC_TIERS[2].dailyLimit, 5000);
  assert.equal(KYC_TIERS[2].weeklyLimit, 25000);
  assert.equal(KYC_TIERS[2].monthlyLimit, 50000);
});

test('getTierLimitsForUser marks send scope and fullKyc', () => {
  const full = getTierLimitsForUser({ kycTier: 2, kycStatus: 'approved' });
  assert.equal(full.dailyLimit, 5000);
  assert.equal(full.scope, 'send');
  assert.equal(full.fullKyc, true);
  assert.equal(full.tierLevel, 2);

  const pending = getTierLimitsForUser({ kycTier: 2, kycStatus: 'pending' });
  assert.equal(pending.dailyLimit, 2000);
  assert.equal(pending.fullKyc, false);
  assert.equal(pending.tierLevel, 1);
});
