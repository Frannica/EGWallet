'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireDatabaseUrl, runNodeScript } = require('./helpers/test-db');

test('db:migrate is idempotent', () => {
  requireDatabaseUrl();

  const first = runNodeScript('db/migrate.js');
  assert.equal(first.status, 0, `first migrate failed: ${first.stderr || first.stdout}`);

  const second = runNodeScript('db/migrate.js');
  assert.equal(second.status, 0, `second migrate failed: ${second.stderr || second.stdout}`);
  assert.match(second.stdout, /skip|applied/);
});
