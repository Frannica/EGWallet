'use strict';

/**
 * Receipt reference integrity — regression guard.
 *
 * Root cause fixed: ReceiptScreen used to fabricate a fake reference
 * ('TX' + Date.now().toString().slice(-8)) whenever no server transaction ID
 * was supplied (this is exactly what happened for the July 24, 2026 $10.00
 * Stripe deposit — DepositScreen never passed a transactionId at all). These
 * checks make sure:
 *   1. The fabrication code path can never come back.
 *   2. ReceiptScreen falls back to a plain "Reference unavailable" string.
 *   3. Every screen that produces a receipt passes the real, server-issued
 *      transaction ID (and, for deposits, the Stripe PaymentIntent ID).
 *   4. Receipt sharing reuses the exact same reference (no separate
 *      fabrication path for the share text).
 *   5. All money-moving flows this mission covers (deposit, send, request
 *      payment, QR payment, exchange, payroll, withdrawal) are wired to
 *      show only durable, real references.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const receiptScreen = read('src/screens/ReceiptScreen.tsx');
const depositScreen = read('src/screens/DepositScreen.tsx');
const sendScreen = read('src/screens/SendScreen.tsx');
const exchangeScreen = read('src/screens/ExchangeScreen.tsx');
const payRequestScreen = read('src/screens/PayRequestScreen.tsx');
const qrScannerScreen = read('src/screens/QRScannerScreen.tsx');
const employerDashboard = read('src/screens/EmployerDashboardScreen.tsx');
const translations = read('src/i18n/translations.ts');
const apiErrorMessage = read('src/utils/apiErrorMessage.ts');

module.exports = function receiptReferenceIntegrity(check) {
  // ── 1. The fabrication bug can never come back ────────────────────────────
  check('ReceiptScreen no longer fabricates a fake "TX"+Date.now() reference',
    !/'TX'\s*\+\s*Date\.now/.test(receiptScreen) &&
    !/"TX"\s*\+\s*Date\.now/.test(receiptScreen));

  check('ReceiptScreen has no Date.now()-based fallback for shortRef at all',
    !/shortRef\s*=\s*p\.transactionId[^;]*Date\.now/.test(receiptScreen));

  check('No other screen re-introduces the same fabrication pattern',
    !/'TX'\s*\+\s*Date\.now/.test(depositScreen) &&
    !/'TX'\s*\+\s*Date\.now/.test(sendScreen) &&
    !/'TX'\s*\+\s*Date\.now/.test(exchangeScreen) &&
    !/'TX'\s*\+\s*Date\.now/.test(payRequestScreen) &&
    !/'TX'\s*\+\s*Date\.now/.test(qrScannerScreen));

  // ── 2. Real reference or explicit "unavailable" — never invented data ────
  check('ReceiptScreen computes hasRealRef from a real transactionId only',
    /const hasRealRef = typeof p\.transactionId === 'string' && p\.transactionId\.length > 0/.test(receiptScreen));

  check('ReceiptScreen shows receipt.referenceUnavailable when no real ref exists',
    /shortRef = hasRealRef \? p\.transactionId!\.substring\(0, 16\) : t\('receipt\.referenceUnavailable'\)/.test(receiptScreen));

  check("i18n key 'receipt.referenceUnavailable' exists in en translations",
    /'receipt\.referenceUnavailable':\s*'Reference unavailable'/.test(translations));

  // ── 3. Receipt sharing reuses the exact same reference variable ──────────
  check('Share text uses the same shortRef variable (no separate fabrication)',
    /t\('receipt\.shareRef'\)\.replace\('\{ref\}', shortRef\)/.test(receiptScreen));

  // ── 4. Deposit receipts show the real server transaction ID + Stripe ref ─
  check('DepositScreen extracts the real transaction ID from the server response',
    /const serverTransactionId: string \| undefined = data\.transaction\?\.id/.test(depositScreen));

  check('DepositScreen only shows a Stripe reference when it is a genuine PaymentIntent id (pi_*)',
    /isRealStripeRef = typeof stripeRef === 'string' && stripeRef\.startsWith\('pi_'\)/.test(depositScreen));

  check('DepositScreen passes transactionId + paymentReference into the Receipt navigation',
    /navigate\('Receipt', \{[\s\S]{0,400}transactionId: serverTransactionId,[\s\S]{0,200}paymentReference: isRealStripeRef \? stripeRef : undefined/.test(depositScreen));

  check('ReceiptScreen renders a Stripe payment reference row only for deposits with a real reference',
    /txType === 'deposit' && p\.paymentReference/.test(receiptScreen) &&
    /receipt\.paymentReference/.test(receiptScreen));

  check("i18n key 'receipt.paymentReference' exists in en translations",
    /'receipt\.paymentReference':\s*'Payment Reference'/.test(translations));

  // ── 5. Send + withdrawal use real server IDs — regression guard ──────────
  // (The old third Receipt nav was the dead "pay with card" send path, which
  // was removed with the misleading card-withdrawal UI.)
  const sendNavBlocks = sendScreen.match(/navigate\('Receipt', \{[\s\S]{0,1200}?\}\);/g) || [];
  check('SendScreen has 2 Receipt navigations (send + withdrawal) and none fabricate a ref',
    sendNavBlocks.length === 2 && sendNavBlocks.every((b) => /transactionId:\s*(\(res as any\)\?\.transaction\?\.id|wData\.withdrawal\?\.id)/.test(b)));

  // ── 6. Exchange, request-payment, and QR-payment now produce real receipts ─
  check('ExchangeScreen navigates to Receipt with the real server transaction id',
    /navigate\('Receipt', \{[\s\S]{0,1200}transactionId: tx\?\.id,[\s\S]{0,80}type: 'exchange'/.test(exchangeScreen));

  check('ExchangeScreen no longer relies on a plain Alert as the only success feedback',
    exchangeScreen.includes("navigate('Receipt'"));

  check('PayRequestScreen navigates to Receipt with the real server transaction id (not a fabricated one)',
    /navigation\.navigate\('Receipt', \{[\s\S]{0,1200}transactionId: tx\.id,/.test(payRequestScreen) &&
    !/showPaymentSuccessAlert/.test(payRequestScreen));

  check('QRScannerScreen navigates to Receipt with the real server transaction id',
    /navigation\.navigate\('Receipt', \{[\s\S]{0,1200}transactionId: tx\?\.id,/.test(qrScannerScreen));

  // ── 7. Payroll receipts never render a literal "undefined" reference ─────
  check('EmployerDashboardScreen falls back to receipt.referenceUnavailable instead of showing "undefined"',
    /r\.transactionId \? `\$\{r\.transactionId\.substring\(0, 14\)\}…` : t\('receipt\.referenceUnavailable'\)/.test(employerDashboard));

  // ── 8. i18n completeness for every new key, across all 7 languages ───────
  const NEW_KEYS = [
    'receipt.referenceUnavailable',
    'receipt.paymentReference',
    'receipt.exchangeCompleted',
    'receipt.exchangeSuccess',
    'receipt.converted',
  ];
  for (const key of NEW_KEYS) {
    const escaped = key.replace('.', '\\.');
    const count = (translations.match(new RegExp(`'${escaped}':`, 'g')) || []).length;
    check(`'${key}' is translated in all 7 languages (found ${count})`, count === 7);
  }

  // ── 9. apiErrorMessage / withdrawal receipts unaffected — sanity guard ────
  check('apiErrorMessage.ts still maps PROVIDER_VALIDATION_UNAVAILABLE (unrelated regression guard)',
    apiErrorMessage.includes('PROVIDER_VALIDATION_UNAVAILABLE'));
};
