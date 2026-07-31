'use strict';
/**
 * Run INSIDE the production container (railway ssh):
 *   E2E_USER_IDS=id1,id2,id3 node scripts/patchE2EKycJsonInContainer.js
 */
const { loadAppState, saveAppState } = require('../db/appStateStore');

const ids = String(process.env.E2E_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!ids.length) {
  console.error('E2E_USER_IDS required');
  process.exit(2);
}

const db = loadAppState();
let n = 0;
for (const u of db.users || []) {
  if (ids.includes(u.id)) {
    u.kycTier = 2;
    u.kycStatus = 'approved';
    n += 1;
  }
}
if (n) saveAppState(db);
console.log(JSON.stringify({ patched: n, ids }));
process.exit(n === ids.length ? 0 : 3);
