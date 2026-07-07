'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('employer registration returns verified status (no admin operator step)', () => {
  const block = indexSource.match(/app\.post\('\/employer\/register',[\s\S]*?res\.json\(\{[\s\S]*?\}\);\s*\n\s*\}\)/);
  assert.ok(block, 'employer register route not found');
  assert.match(block[0], /verificationStatus:\s*'verified'/);
  assert.match(block[0], /verifiedBy:\s*'auto'/);
  assert.doesNotMatch(block[0], /verificationStatus:\s*'pending'/);
});

test('employer payroll endpoints use employerCanOperate (only rejected employers blocked)', () => {
  assert.match(indexSource, /function employerCanOperate\(employer\)/);
  assert.doesNotMatch(indexSource, /verificationStatus !== 'verified'/);
  assert.match(indexSource, /employerCanOperate\(/);
});

test('payroll payment requests do not flag requiresApproval', () => {
  assert.match(indexSource, /requiresApproval:\s*false/);
  assert.doesNotMatch(indexSource, /requiresApproval:\s*true/);
});
