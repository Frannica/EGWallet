'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDestination } = require('../../payout/destinationValidator');

const ngBankCorridor = {
  corridorId: 'NG-NGN-bank',
  country: 'NG',
  currency: 'NGN',
  method: 'bank',
  requiredFields: [
    { name: 'bankCode', required: true },
    { name: 'accountNumber', required: true },
    { name: 'accountHolderName', required: true },
  ],
  amountRules: { minorUnits: true, step: 1 },
};

test('validateDestination passes complete withdrawal', () => {
  const result = validateDestination({
    amount: 150000,
    bankCode: '033',
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  }, ngBankCorridor);
  assert.equal(result.valid, true);
});

test('validateDestination fails missing bankCode', () => {
  const result = validateDestination({
    amount: 150000,
    accountNumber: '0000000000',
    accountHolderName: 'Test User',
  }, ngBankCorridor);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('bankCode')));
});

test('validateDestination enforces XAF step multiples', () => {
  const xafCorridor = {
    corridorId: 'CM-XAF-mobile_money',
    country: 'CM',
    currency: 'XAF',
    method: 'mobile_money',
    requiredFields: [{ name: 'accountNumber', required: true }],
    amountRules: { minorUnits: true, step: 5 },
  };
  const bad = validateDestination({ amount: 653, accountNumber: '1' }, xafCorridor);
  assert.equal(bad.valid, false);
  const ok = validateDestination({ amount: 655, accountNumber: '1' }, xafCorridor);
  assert.equal(ok.valid, true);
});
