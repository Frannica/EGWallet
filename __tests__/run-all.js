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
  ['Phase 13 — Critical withdrawal safety',              require('./regression/phase13.test')],
  ['Phase 14 — Balance sync, dedup & dispute security',  require('./regression/phase14.test')],
  ['Phase 16 — Send money integrity (double-spend fix)',  require('./regression/phase16.test')],
  ['Phase 17 — P2P send simulation (7-phone loop)',       require('../backend/__tests__/send-integrity.test.js')],
  ['Phase 18 — Money sync + idempotent pay fixes',      require('./regression/phase18.test')],
  ['Phase 19 — Username creation + localized API errors', require('./regression/phase19.test')],
  ['Withdrawal stale FX — SendScreen guard scope', require('./send-withdrawal-stale-rates.node.test.js')],
  ['KYC upload flow — crop recovery + preview', require('./kyc-upload-flow.node.test.js')],
  ['Stripe deposit — card-only PaymentIntent + minimum', require('../backend/__tests__/deposit-stripe-config.test.js')],
  ['Deposit flow — direct Stripe PaymentSheet (no fake card form)', require('./deposit-flow-direct-stripe.node.test.js')],
  ['Deposit — Stripe SDK pre-warm', require('../backend/__tests__/deposit-stripe-prewarm.test.js')],
  ['PaymentSheet — card-only init helper', require('./payment-sheet-card-only.node.test.js')],
  ['PaymentSheet — single-flight guard (no stacked sheets)', require('./payment-sheet-single-flight.node.test.js')],
  ['Money flow — $300 split + idempotent pay',            require('../backend/__tests__/money-flow.test.js')],
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
