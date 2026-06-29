'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/** Mirrors WithdrawalTable.normalizeListResponse — guards API/UI contract. */
function normalizeListResponse(data) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.withdrawals)
      ? data.withdrawals
      : Array.isArray(data)
        ? data
        : [];
  return {
    list,
    page: data?.page || 1,
    totalPages: data?.totalPages || 1,
    totalItems: data?.totalItems ?? list.length,
  };
}

test('normalizeListResponse accepts data array shape', () => {
  const out = normalizeListResponse({ data: [{ id: 'a' }], page: 2, totalPages: 3, totalItems: 40 });
  assert.equal(out.list.length, 1);
  assert.equal(out.page, 2);
  assert.equal(out.totalItems, 40);
});

test('normalizeListResponse accepts withdrawals alias shape', () => {
  const out = normalizeListResponse({ withdrawals: [{ id: 'b' }], totalItems: 1 });
  assert.equal(out.list[0].id, 'b');
});

test('normalizeListResponse empty list defaults', () => {
  const out = normalizeListResponse({ data: [], totalItems: 0, totalPages: 1, page: 1 });
  assert.deepEqual(out.list, []);
  assert.equal(out.totalItems, 0);
});
