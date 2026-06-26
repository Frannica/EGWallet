'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getCount,
  requireDatabaseUrl,
  runNodeScript,
} = require('./helpers/test-db');

const sampleFile = path.join(__dirname, 'fixtures', 'sample-db.json');
const mismatchFile = path.join(__dirname, 'fixtures', 'sample-db-mismatch.json');

test('import + parity happy path', async () => {
  requireDatabaseUrl();

  const migrate = runNodeScript('db/migrate.js');
  assert.equal(migrate.status, 0, `migrate failed: ${migrate.stderr || migrate.stdout}`);

  const importResult = runNodeScript('scripts/import-db-json.js', ['--file', sampleFile, '--truncate']);
  assert.equal(importResult.status, 0, `import failed: ${importResult.stderr || importResult.stdout}`);

  const parity = runNodeScript('scripts/verify-parity.js', ['--file', sampleFile, '--strict']);
  assert.equal(parity.status, 0, `parity failed: ${parity.stderr || parity.stdout}`);
});

test('import dry-run does not write data', async () => {
  requireDatabaseUrl();
  const before = await getCount('users');
  const dryRun = runNodeScript('scripts/import-db-json.js', ['--file', sampleFile, '--dry-run']);
  assert.equal(dryRun.status, 0, `dry-run failed: ${dryRun.stderr || dryRun.stdout}`);
  const after = await getCount('users');
  assert.equal(before, after);
});

test('import refuses rerun without truncate', () => {
  requireDatabaseUrl();
  const once = runNodeScript('scripts/import-db-json.js', ['--file', sampleFile, '--truncate']);
  assert.equal(once.status, 0, `setup import failed: ${once.stderr || once.stdout}`);

  const second = runNodeScript('scripts/import-db-json.js', ['--file', sampleFile]);
  assert.notEqual(second.status, 0);
  assert.match(`${second.stderr}${second.stdout}`, /not empty|truncate/i);
});

test('import failure rolls back transaction', async () => {
  requireDatabaseUrl();
  const baseline = runNodeScript('scripts/import-db-json.js', ['--file', sampleFile, '--truncate']);
  assert.equal(baseline.status, 0, `baseline import failed: ${baseline.stderr || baseline.stdout}`);
  const beforeUsers = await getCount('users');

  const invalidDb = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
  invalidDb.wallets[0].userId = '99999999-9999-4999-8999-999999999999';
  const tempPath = path.join(os.tmpdir(), `phase0-invalid-${Date.now()}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(invalidDb, null, 2), 'utf8');

  const failingImport = runNodeScript('scripts/import-db-json.js', ['--file', tempPath, '--truncate']);
  assert.notEqual(failingImport.status, 0);

  const afterUsers = await getCount('users');
  assert.equal(afterUsers, beforeUsers, 'row count changed after failed import');
});

test('parity mismatch exits non-zero', () => {
  requireDatabaseUrl();
  const baseline = runNodeScript('scripts/import-db-json.js', ['--file', sampleFile, '--truncate']);
  assert.equal(baseline.status, 0, `baseline import failed: ${baseline.stderr || baseline.stdout}`);

  const parity = runNodeScript('scripts/verify-parity.js', ['--file', mismatchFile, '--strict']);
  assert.notEqual(parity.status, 0);
  assert.match(`${parity.stderr}${parity.stdout}`, /mismatch|failed|fatal/i);
});
