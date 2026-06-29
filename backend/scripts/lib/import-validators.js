'use strict';

const REQUIRED_TOP_LEVEL_KEYS = [
  'users',
  'wallets',
  'transactions',
  'paymentRequests',
  'virtualCards',
  'virtualCardCharges',
  'budgets',
  'devices',
  'supportTickets',
  'refreshTokens',
  'auditLog',
  'employers',
  'employerEmployees',
  'payrollBatches',
  'demoIntents',
  'notifications',
  'passwordResetTokens',
  'idempotencyRecords',
  'withdrawals',
  'ledger',
  'kycIdentityClaims',
  'payoutLocks',
  'rates',
];

function ensureArray(value, key) {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for "${key}"`);
  }
}

function validateRootShape(db) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    throw new Error('Input file must contain a JSON object');
  }

  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in db)) {
      throw new Error(`Missing top-level key: "${key}"`);
    }
  }

  ensureArray(db.users, 'users');
  ensureArray(db.wallets, 'wallets');
  ensureArray(db.transactions, 'transactions');
  ensureArray(db.paymentRequests, 'paymentRequests');
  ensureArray(db.virtualCards, 'virtualCards');
  ensureArray(db.virtualCardCharges, 'virtualCardCharges');
  ensureArray(db.budgets, 'budgets');
  ensureArray(db.devices, 'devices');
  ensureArray(db.supportTickets, 'supportTickets');
  ensureArray(db.refreshTokens, 'refreshTokens');
  ensureArray(db.auditLog, 'auditLog');
  ensureArray(db.employers, 'employers');
  ensureArray(db.employerEmployees, 'employerEmployees');
  ensureArray(db.payrollBatches, 'payrollBatches');
  ensureArray(db.demoIntents, 'demoIntents');
  ensureArray(db.notifications, 'notifications');
  ensureArray(db.passwordResetTokens, 'passwordResetTokens');
  ensureArray(db.idempotencyRecords, 'idempotencyRecords');
  ensureArray(db.withdrawals, 'withdrawals');
  ensureArray(db.ledger, 'ledger');
  ensureArray(db.payoutLocks, 'payoutLocks');

  if (!db.kycIdentityClaims || typeof db.kycIdentityClaims !== 'object' || Array.isArray(db.kycIdentityClaims)) {
    throw new Error('Expected object for "kycIdentityClaims"');
  }

  if (!db.rates || typeof db.rates !== 'object' || Array.isArray(db.rates)) {
    throw new Error('Expected object for "rates"');
  }
  if (!db.rates.values || typeof db.rates.values !== 'object' || Array.isArray(db.rates.values)) {
    throw new Error('Expected object for "rates.values"');
  }
}

module.exports = {
  validateRootShape,
};
