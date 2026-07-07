'use strict';

/**
 * KYC send limits — withdrawals are NOT subject to these caps.
 * Full KYC (tier 2 benefits) requires kycTier >= 2 AND kycStatus === 'approved'.
 */

const KYC_TIERS = {
  0: { name: 'Starter',   dailyLimit: 300,   weeklyLimit: 1000,  monthlyLimit: 2000  },
  1: { name: 'Basic KYC', dailyLimit: 2000,  weeklyLimit: 5000,  monthlyLimit: 10000 },
  2: { name: 'Verified',  dailyLimit: 5000,  weeklyLimit: 25000, monthlyLimit: 50000 },
};

/** Tier used for send/exchange/pay limit enforcement and display. */
function getEffectiveKycTier(user) {
  if (!user) return 0;
  const tier = user.kycTier || 0;
  if (tier >= 2 && user.kycStatus === 'approved') return 2;
  if (tier >= 1) return 1;
  return 0;
}

function isFullKyc(user) {
  return (user?.kycTier || 0) >= 2 && user?.kycStatus === 'approved';
}

function getTierLimitsForUser(user) {
  const effectiveTier = getEffectiveKycTier(user);
  return {
    ...KYC_TIERS[effectiveTier],
    tierLevel: effectiveTier,
    scope: 'send',
    fullKyc: isFullKyc(user),
  };
}

module.exports = {
  KYC_TIERS,
  getEffectiveKycTier,
  isFullKyc,
  getTierLimitsForUser,
};
