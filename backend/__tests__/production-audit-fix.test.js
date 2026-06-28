'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function extractRouteBlock(routePattern) {
  const match = indexSource.match(routePattern);
  assert.ok(match, `route block not found for ${routePattern}`);
  return match[0];
}

const PERSONAL_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function findDuplicatePersonalPaymentRequest(paymentRequests, {
  requesterId,
  amount,
  currency,
  recipientUserId = null,
  now = Date.now(),
}) {
  const normalizedCur = (currency || '').toUpperCase();
  return (paymentRequests || []).find((r) =>
    r.requesterId === requesterId &&
    r.type !== 'payroll_request' &&
    !r.targetEmployerId &&
    !r.employerId &&
    r.status === 'pending' &&
    r.amount === amount &&
    (r.currency || '').toUpperCase() === normalizedCur &&
    (r.recipientUserId || null) === (recipientUserId || null) &&
    (now - (r.createdAt || 0)) < PERSONAL_DUPLICATE_WINDOW_MS
  ) || null;
}

test('POST /deposits/confirm PG failure does not leak persistErr.message to client', () => {
  const block = extractRouteBlock(
    /app\.post\('\/deposits\/confirm',[\s\S]*?\n\}\);[\s\S]*?\n\}\);[\s\S]*?\n\}\);/,
  );
  assert.doesNotMatch(block, /message:\s*persistErr\.message/);
  assert.doesNotMatch(block, /json\(\{\s*error:\s*persistErr\.message/);
  assert.match(block, /error:\s*t\('error_transaction_persist'/);
});

test('POST /withdrawals PG failure does not leak pgErr.message to client', () => {
  const block = extractRouteBlock(
    /app\.post\('\/withdrawals',[\s\S]*?\n\}\);[\s\S]*?\n\}\);[\s\S]*?\n\}\);/,
  );
  assert.doesNotMatch(block, /return res\.status\(500\)\.json\(\{ error: pgErr\.message \}\)/);
  assert.match(block, /return res\.status\(500\)\.json\(\{ error: t\('error_transaction_persist'/);
});

test('duplicate personal pending payment request is blocked within window', () => {
  const now = Date.now();
  const requesterId = 'user-a';
  const requests = [{
    id: 'pr-1',
    requesterId,
    type: 'personal_request',
    amount: 5000,
    currency: 'USD',
    status: 'pending',
    recipientUserId: 'user-b',
    createdAt: now - 1000,
  }];

  const dup = findDuplicatePersonalPaymentRequest(requests, {
    requesterId,
    amount: 5000,
    currency: 'USD',
    recipientUserId: 'user-b',
    now,
  });
  assert.ok(dup);
  assert.equal(dup.id, 'pr-1');
});

test('employer/payroll duplicate guard still uses employer fields only', () => {
  const employerBlock = extractRouteBlock(
    /\/\/ High-3: Duplicate request prevention \(24-hour window\)\.[\s\S]*?existingRequestId: recentRequests\[0\]\.id[\s\S]*?\}\);/,
  );
  assert.match(employerBlock, /targetEmployerId|employerId/);
  assert.match(employerBlock, /payroll_request|targetEmployer/);

  const personalBlock = extractRouteBlock(
    /\/\/ Non-employer \(personal\) request path — block duplicate pending requests within 24h\.[\s\S]*?existingRequestId: duplicatePersonal\.id[\s\S]*?\}\);/,
  );
  assert.match(personalBlock, /r\.type !== 'payroll_request'/);
  assert.doesNotMatch(personalBlock, /targetEmployerId === targetEmployer/);
});

test('resolved/cancelled/paid personal request can be created again later', () => {
  const now = Date.now();
  const requesterId = 'user-a';
  const base = {
    requesterId,
    type: 'personal_request',
    amount: 5000,
    currency: 'USD',
    recipientUserId: 'user-b',
    createdAt: now - 1000,
  };

  for (const status of ['paid', 'cancelled', 'rejected']) {
    const dup = findDuplicatePersonalPaymentRequest([{ ...base, id: `pr-${status}`, status }], {
      requesterId,
      amount: 5000,
      currency: 'USD',
      recipientUserId: 'user-b',
      now,
    });
    assert.equal(dup, null, `expected no duplicate for status=${status}`);
  }

  const expiredPending = findDuplicatePersonalPaymentRequest(
    [{ ...base, id: 'pr-old', status: 'pending', createdAt: now - PERSONAL_DUPLICATE_WINDOW_MS - 1 }],
    { requesterId, amount: 5000, currency: 'USD', recipientUserId: 'user-b', now },
  );
  assert.equal(expiredPending, null);
});

test('payroll_request pending duplicate is not blocked by personal guard', () => {
  const now = Date.now();
  const requests = [{
    id: 'pr-payroll',
    requesterId: 'worker-1',
    type: 'payroll_request',
    targetEmployerId: 'emp-1',
    amount: 5000,
    currency: 'USD',
    status: 'pending',
    createdAt: now - 1000,
  }];

  const dup = findDuplicatePersonalPaymentRequest(requests, {
    requesterId: 'worker-1',
    amount: 5000,
    currency: 'USD',
    now,
  });
  assert.equal(dup, null);
});
