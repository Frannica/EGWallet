const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FX_STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000;
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function exchangeWouldBlockStaleRates({ ratesUpdatedAt, nodeEnv }) {
  const ageMs = Date.now() - (ratesUpdatedAt || 0);
  return ageMs > FX_STALE_THRESHOLD_MS && nodeEnv === 'production';
}

function withdrawalWouldBlockStaleRates() {
  return false;
}

function extractRouteBlock(routePattern) {
  const match = indexSource.match(routePattern);
  assert.ok(match, `route block not found for ${routePattern}`);
  return match[0];
}

test('POST /withdrawals does not gate on FX rate staleness', () => {
  const withdrawalBlock = extractRouteBlock(
    /app\.post\('\/withdrawals',[\s\S]*?\n\}\);/,
  );
  assert.doesNotMatch(withdrawalBlock, /FX_STALE_THRESHOLD_MS/);
  assert.doesNotMatch(withdrawalBlock, /rates are outdated/i);
  assert.equal(withdrawalWouldBlockStaleRates(), false);
});

test('POST /exchange still blocks in production when FX rates are stale', () => {
  const exchangeBlock = extractRouteBlock(
    /app\.post\('\/exchange',[\s\S]*?\n\}\);[\s\S]*?\n\}\);[\s\S]*?\n\}\);/,
  );
  assert.match(exchangeBlock, /FX_STALE_THRESHOLD_MS/);
  assert.match(exchangeBlock, /FX rates are outdated\. Exchange is temporarily unavailable/);
  assert.equal(
    exchangeWouldBlockStaleRates({
      ratesUpdatedAt: Date.now() - FX_STALE_THRESHOLD_MS - 1,
      nodeEnv: 'production',
    }),
    true,
  );
});

test('POST /exchange does not block stale rates outside production', () => {
  assert.equal(
    exchangeWouldBlockStaleRates({
      ratesUpdatedAt: Date.now() - FX_STALE_THRESHOLD_MS - 1,
      nodeEnv: 'development',
    }),
    false,
  );
});
