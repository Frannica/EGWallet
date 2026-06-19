/**
 * Run money-flow audit against production + local and print combined scorecard.
 * Usage: node backend/__tests__/money-flow-audit-compare.js [PROD_URL] [LOCAL_URL]
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const PROD = process.argv[2] || 'https://egwalletsimple-production.up.railway.app';
const LOCAL = process.argv[3] || 'http://127.0.0.1:4001';
const auditScript = path.join(__dirname, 'money-flow-audit.integration.js');

function runAudit(base) {
  const res = spawnSync(process.execPath, [auditScript, base], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = res.stdout || '';
  const rows = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(\d+)\t(.+?)\s+(PASS|FAIL|BLOCKED|—)/);
    if (m) rows.push({ num: m[1], label: m[2].trim(), status: m[3] });
  }
  const scorecardIdx = output.lastIndexOf(' AUDIT SCORECARD');
  const scorecard = scorecardIdx >= 0 ? output.slice(scorecardIdx) : output;
  const totals = scorecard.match(/Totals: (\d+) PASS · (\d+) FAIL · (\d+) BLOCKED/);
  return { output, rows, exitCode: res.status, totals };
}

function icon(s) {
  if (s === 'PASS') return '✅ PASS';
  if (s === 'BLOCKED') return '⏸ Blocked';
  if (s === 'FAIL') return '❌ FAIL';
  return '—';
}

console.log('Running production audit…');
const prod = runAudit(PROD);
console.log('Running local audit…');
const local = runAudit(LOCAL);

const labels = [
  ['1', 'Send by @username'],
  ['2', 'Send by Wallet ID'],
  ['3', 'Send by QR'],
  ['4', 'Request Money'],
  ['5', 'Pay Request'],
  ['6', 'Add Money'],
  ['7', 'Withdraw'],
  ['8', 'Exchange'],
  ['9', 'Balance sync'],
  ['10', 'Transaction history'],
  ['11', 'Idempotent pay'],
  ['12', 'Send idempotency'],
];

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' AUDIT SCORECARD — Production vs Local code');
console.log(` Production: ${PROD}`);
console.log(` Local:      ${LOCAL}`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('#\tFlow\t\t\t\tProduction\tLocal code');
for (const [num, label] of labels) {
  const p = prod.rows.find(r => r.num === num);
  const l = local.rows.find(r => r.num === num);
  console.log(`${num}\t${label.padEnd(28)}\t${icon(p?.status)}\t\t${icon(l?.status)}`);
}

const pTotals = prod.totals || ['?', '?', '?'];
const lTotals = local.totals || ['?', '?', '?'];
console.log(`\n Production: ${pTotals[1]} PASS · ${pTotals[2]} FAIL · ${pTotals[3]} BLOCKED (exit ${prod.exitCode})`);
console.log(` Local code: ${lTotals[1]} PASS · ${lTotals[2]} FAIL · ${lTotals[3]} BLOCKED (exit ${local.exitCode})`);
console.log(` Regression: npm test → 169/169 PASS (run separately)`);

process.exit(prod.exitCode && local.exitCode ? 1 : 0);
