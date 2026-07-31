'use strict';
/**
 * Ensures published Terms markdown states exact current Kora corridors and gates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const termsPath = path.join(__dirname, '..', '..', 'legal', 'TERMS_OF_SERVICE.md');
const terms = fs.readFileSync(termsPath, 'utf8');

test('Terms list all eight Kora cash-out countries with methods', () => {
  assert.match(terms, /Nigeria/i);
  assert.match(terms, /Kenya/i);
  assert.match(terms, /South Africa/i);
  assert.match(terms, /Ghana/i);
  assert.match(terms, /Ivory Coast|Côte d'Ivoire/i);
  assert.match(terms, /Cameroon/i);
  assert.match(terms, /Egypt/i);
  assert.match(terms, /Tanzania/i);
  assert.match(terms, /Bank transfer \*\*and\*\* mobile money/i);
  assert.ok(terms.includes('Bank transfer') && terms.includes('Mobile money'));
  assert.ok(terms.includes('| NG |'));
});

test('Terms state GQ unsupported and XAF/XOF do not imply payout', () => {
  assert.match(terms, /Equatorial Guinea \(GQ\)/i);
  assert.match(terms, /not\*\* currently supported for cash withdrawal/i);
  assert.match(terms, /XAF/);
  assert.match(terms, /XOF/);
  assert.match(terms, /does \*\*not\*\* establish payout support/i);
});

test('Terms state US/UK/EU unavailable while Stripe Connect disabled', () => {
  assert.match(terms, /United States/);
  assert.match(terms, /United Kingdom/);
  assert.match(terms, /European/);
  assert.match(terms, /Stripe Connect is disabled/i);
});

test('Terms distinguish refund-to-original-card from withdrawal', () => {
  assert.match(terms, /refund-to-original-card/i);
  assert.match(terms, /deposit reversal/i);
  assert.match(terms, /not\*\* a general withdrawal method/i);
});

test('Terms require disclosed recovery before deposit', () => {
  assert.match(terms, /clearly disclosed and functioning method to recover/i);
});
