'use strict';

const ZERO_DECIMAL = new Set([
  'XAF', 'XOF', 'JPY', 'KRW', 'VND', 'CLP', 'UGX', 'RWF', 'GNF', 'BIF', 'DJF', 'KMF', 'MGA', 'PYG', 'VUV',
]);

function decimalsFor(currency) {
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 0 : 2;
}

/** Minimum deposit in major units: $1 / €1 or 100 FCFA-style units. */
function minDepositMajor(currency) {
  return decimalsFor(currency) === 0 ? 100 : 1;
}

function minDepositMinor(currency) {
  const major = minDepositMajor(currency);
  const d = decimalsFor(currency);
  return Math.round(major * Math.pow(10, d));
}

module.exports = {
  decimalsFor,
  minDepositMajor,
  minDepositMinor,
};
