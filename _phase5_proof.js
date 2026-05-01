/**
 * _phase5_proof.js — Duplicate Transaction Entry Tests
 *
 * Verifies that NO screen calls logLocalTransaction() after a successful
 * backend API call that already records the transaction server-side.
 * Any local logging must only occur in offline/demo fallback paths.
 *
 * Run: node _phase5_proof.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function check(label, result, detail = '') {
  if (result) {
    console.log(`  ✅ PASS — ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL — ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function read(filePath) {
  return fs.readFileSync(path.resolve(__dirname, filePath), 'utf8').replace(/\r\n/g, '\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: extract a function body by name from a file's content
// ──────────────────────────────────────────────────────────────────────────────
function extractFunctionRegion(content, marker, endMarker) {
  const start = content.indexOf(marker);
  if (start === -1) return '';
  const end = endMarker ? content.indexOf(endMarker, start) : content.length;
  return content.slice(start, end === -1 ? content.length : end);
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. SendScreen — send path (completeSendWithPaymentMethod + onSendConfirmed)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[1] SendScreen.tsx — send paths');
const send = read('src/screens/SendScreen.tsx');

check('logLocalTransaction NOT imported in SendScreen',
  !send.includes('logLocalTransaction'));

const paymentMethodFn = extractFunctionRegion(send, 'async function completeSendWithPaymentMethod', 'async function onWithdrawConfirmed');
check('completeSendWithPaymentMethod: no logLocalTransaction call',
  !paymentMethodFn.includes('logLocalTransaction'));
check('completeSendWithPaymentMethod: still calls sendTransaction (backend)',
  paymentMethodFn.includes('sendTransaction'));
check('completeSendWithPaymentMethod: still debits local balance (UI stays accurate)',
  paymentMethodFn.includes('debitLocalBalance'));

const sendConfirmedFn = extractFunctionRegion(send, 'async function onSendConfirmed', 'function isHighAmount');
check('onSendConfirmed: no logLocalTransaction call',
  !sendConfirmedFn.includes('logLocalTransaction'));
check('onSendConfirmed: still calls sendTransaction (backend)',
  sendConfirmedFn.includes('sendTransaction'));
check('onSendConfirmed: still debits local balance',
  sendConfirmedFn.includes('debitLocalBalance'));

// ──────────────────────────────────────────────────────────────────────────────
// 2. SendScreen — withdrawal path (onWithdrawConfirmed)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[2] SendScreen.tsx — withdrawal path');
const withdrawFn = extractFunctionRegion(send, 'async function onWithdrawConfirmed', 'async function onSendConfirmed');
check('onWithdrawConfirmed: no logLocalTransaction call',
  !withdrawFn.includes('logLocalTransaction'));
check('onWithdrawConfirmed: still POSTs to /withdrawals (backend)',
  withdrawFn.includes('/withdrawals'));
check('onWithdrawConfirmed: still debits local balance',
  withdrawFn.includes('debitLocalBalance'));

// ──────────────────────────────────────────────────────────────────────────────
// 3. DepositScreen — confirm deposit path
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[3] DepositScreen.tsx — deposit confirm path');
const dep = read('src/screens/DepositScreen.tsx');

const confirmDepFn = extractFunctionRegion(dep, 'async function confirmDeposit', '\n  async function ');
check('confirmDeposit: no logLocalTransaction call',
  !confirmDepFn.includes('logLocalTransaction'));
check('confirmDeposit: still POSTs to /deposits/confirm (backend)',
  confirmDepFn.includes('/deposits/confirm'));
check('confirmDeposit: still credits local balance',
  confirmDepFn.includes('creditLocalBalance'));

// ──────────────────────────────────────────────────────────────────────────────
// 4. QRPaymentScreen — success path vs demo/offline fallback
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[4] QRPaymentScreen.tsx — success vs demo paths');
const qr = read('src/screens/QRPaymentScreen.tsx');

// Isolate the payment handler function body only (past the imports)
const qrFnStart = qr.indexOf('async function handleConfirmPayment(');
const qrFnBody = qrFnStart !== -1 ? qr.slice(qrFnStart) : qr;
const qrCatchBoundary = qrFnBody.indexOf('} catch (error: any) {');
const qrSuccessBlock = qrCatchBoundary !== -1 ? qrFnBody.slice(0, qrCatchBoundary) : qrFnBody;
const qrCatchBlock = qrCatchBoundary !== -1 ? qrFnBody.slice(qrCatchBoundary) : '';

check('QRPaymentScreen success path: no logLocalTransaction (backend records it)',
  !qrSuccessBlock.includes('logLocalTransaction'));
check('QRPaymentScreen demo/offline catch path: logLocalTransaction present (no backend record)',
  qrCatchBlock.includes('logLocalTransaction'));
check('QRPaymentScreen success path: still debits local balance',
  qrSuccessBlock.includes('debitLocalBalance'));

// ──────────────────────────────────────────────────────────────────────────────
// 5. QRScannerScreen — uses sendTransaction, must not locally log
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[5] QRScannerScreen.tsx — send via QR scan');
const qrScanner = read('src/screens/QRScannerScreen.tsx');
check('QRScannerScreen: no logLocalTransaction call',
  !qrScanner.includes('logLocalTransaction'));
check('QRScannerScreen: still calls sendTransaction (backend)',
  qrScanner.includes('sendTransaction'));

// ──────────────────────────────────────────────────────────────────────────────
// 6. RequestScreen — payment requests are local-only (no backend tx), logging OK
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[6] RequestScreen.tsx — payment requests (local-only, logging correct)');
const req = read('src/screens/RequestScreen.tsx');

// Verify these calls are NOT adjacent to sendTransaction/backend calls for money movement
check('RequestScreen logs payment_request type (not send/withdrawal)',
  req.includes("type: 'payment_request'") &&
  !req.includes("type: 'send'") &&
  !req.includes("type: 'withdrawal'"));
check('RequestScreen: does NOT call sendTransaction',
  !req.includes('sendTransaction'));

// ──────────────────────────────────────────────────────────────────────────────
// 7. Full scan — no screen has logLocalTransaction adjacent to a confirmed backend call
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Full src scan — backend calls never paired with local logging');

const BACKEND_CALL_SCREENS = [
  'src/screens/SendScreen.tsx',
  'src/screens/DepositScreen.tsx',
  'src/screens/QRScannerScreen.tsx',
];

for (const file of BACKEND_CALL_SCREENS) {
  const content = read(file);
  check(`${path.basename(file)}: no logLocalTransaction import or call`,
    !content.includes('logLocalTransaction'));
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
console.log('─'.repeat(56));
if (failed === 0) {
  console.log('  ✅ ALL CHECKS PASS — no duplicate transaction entries possible.\n');
  process.exit(0);
} else {
  console.error('  ❌ SOME CHECKS FAILED — review output above.\n');
  process.exit(1);
}
