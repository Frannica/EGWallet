'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canFallbackToNextAdapter,
  canRetrySameAdapter,
} = require('../../payout/fallbackPolicy');

test('canFallbackToNextAdapter allows fallback on permanent pre-contact failure', () => {
  assert.equal(
    canFallbackToNextAdapter(
      { kind: 'permanent', code: 'NOT_CONFIGURED', providerContacted: false },
      { providerContacted: false, reference: null },
    ),
    true,
  );
});

test('canFallbackToNextAdapter blocks fallback on ambiguous errors', () => {
  assert.equal(
    canFallbackToNextAdapter(
      { kind: 'ambiguous', code: 'TIMEOUT', providerContacted: true },
      { providerContacted: true, reference: null },
    ),
    false,
  );
});

test('canFallbackToNextAdapter blocks fallback when reference exists', () => {
  assert.equal(
    canFallbackToNextAdapter(
      { kind: 'permanent', code: 'REJECTED', providerContacted: true },
      { providerContacted: true, reference: 'ref-123' },
    ),
    false,
  );
});

test('canRetrySameAdapter allows one retry for retryable errors', () => {
  assert.equal(
    canRetrySameAdapter({ kind: 'retryable', code: 'NETWORK', providerContacted: false }, 0),
    true,
  );
  assert.equal(
    canRetrySameAdapter({ kind: 'retryable', code: 'NETWORK', providerContacted: false }, 1),
    false,
  );
});

test('canFallbackToNextAdapter blocks fallback on permanent contact without definitive rejection', () => {
  assert.equal(
    canFallbackToNextAdapter(
      { kind: 'permanent', code: 'REJECTED', providerContacted: true },
      { providerContacted: true, reference: null },
    ),
    false,
  );
});

test('canFallbackToNextAdapter allows fallback on definitive rejection after contact', () => {
  assert.equal(
    canFallbackToNextAdapter(
      {
        kind: 'permanent',
        code: 'REJECTED',
        providerContacted: true,
        definitiveRejection: true,
      },
      { providerContacted: true, reference: null },
    ),
    true,
  );
});
