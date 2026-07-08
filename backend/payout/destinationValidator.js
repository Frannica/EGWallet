'use strict';

/**
 * Validates withdrawal destination fields and amount rules for a corridor.
 * Provider-independent — rules come from configuration only.
 */

/**
 * @param {object} withdrawal
 * @param {import('./types').PayoutCorridor} corridor
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDestination(withdrawal, corridor) {
  const errors = [];

  for (const field of corridor.requiredFields || []) {
    if (!field.required) continue;
    const val = withdrawal[field.name];
    if (val === undefined || val === null || String(val).trim() === '') {
      errors.push(`missing:${field.name}`);
    }
  }

  const amount = withdrawal.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    errors.push('invalid:amount');
  }

  const rules = corridor.amountRules || {};
  if (rules.step && amount % rules.step !== 0) {
    errors.push(`invalid:amount_step:${rules.step}`);
  }
  if (rules.minMinor != null && amount < rules.minMinor) {
    errors.push(`invalid:amount_min:${rules.minMinor}`);
  }
  if (rules.maxMinor != null && amount > rules.maxMinor) {
    errors.push(`invalid:amount_max:${rules.maxMinor}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateDestination,
};
