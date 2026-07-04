'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const cacheSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'stripe', 'stripePublishableKeyCache.ts'),
  'utf8',
);

test('fee-info returns publishableKey for StripeProvider pre-warm', () => {
  const block = indexSource.match(/app\.get\('\/deposits\/fee-info'[\s\S]*?app\.post\('\/deposits\/create-intent'/);
  assert.ok(block);
  assert.match(block[0], /publishableKey:\s*stripeClient/);
});

test('publishable key cache rejects invalid keys', () => {
  assert.match(cacheSource, /pk_\(test\|live\)_/);
  assert.match(cacheSource, /readCachedStripePublishableKey/);
});

module.exports = function depositStripePrewarm(check) {
  check(
    '[Deposit] fee-info exposes publishableKey for SDK pre-warm',
    /app\.get\('\/deposits\/fee-info'[\s\S]*publishableKey:/.test(indexSource),
  );
  check(
    '[Deposit] mobile caches publishable key locally',
    cacheSource.includes('cacheStripePublishableKey') &&
    cacheSource.includes('readCachedStripePublishableKey'),
  );
};
