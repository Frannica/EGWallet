/**
 * EGWallet Regression Test Runner
 *
 * Usage:  node __tests__/run-all.js
 * npm:    npm test
 *
 * Zero external dependencies — plain Node.js only.
 * Add new suites to SUITES below. Each suite module exports a function:
 *   (check: (label, condition) => void) => void
 */

'use strict';

const SUITES = [
  ['Phase 09 — Debit card fix + SendScreen CVC removal', require('./regression/phase09.test')],
  ['Phase 10 — Overdraft exploit fix',                   require('./regression/phase10.test')],
  ['Phase 11 — Feature audit fixes',                     require('./regression/phase11.test')],
  ['Phase 12 — Bell/ViewAll audit + WalletScreen logs',  require('./regression/phase12.test')],
];

// ── Runner ────────────────────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    totalPassed++;
  } else {
    console.error(`  ❌  ${label}`);
    totalFailed++;
  }
}

for (const [title, suite] of SUITES) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
  suite(check);
}

console.log('\n' + '═'.repeat(72));
console.log(`  Regression suite: ${totalPassed} passed, ${totalFailed} failed`);
if (totalFailed === 0) {
  console.log('  🎉 ALL REGRESSION CHECKS PASSED\n');
} else {
  console.error(`  ⚠️  ${totalFailed} regression check(s) FAILED — do not ship\n`);
  process.exit(1);
}
