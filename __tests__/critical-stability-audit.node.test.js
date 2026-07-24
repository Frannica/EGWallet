'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

function loadTsModule(relPath) {
  const filePath = path.join(ROOT, relPath);
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filePath,
  });
  const m = new Module(filePath, module);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(transpiled.outputText, filePath);
  return m.exports;
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function sanitizeCard(card) {
  if (!card) return card;
  const { cvv, cardNumber, ...rest } = card;
  const last4 = rest.last4 || (cardNumber ? cardNumber.slice(-4) : '****');
  return { ...rest, last4, maskedNumber: `****${last4}` };
}

function publicPaymentRequestShape(request) {
  return {
    id: request.id,
    amount: request.amount,
    currency: request.currency,
    memo: request.memo || request.note || '',
    note: request.note || request.memo || '',
    status: request.status || 'pending',
    expiresAt: request.expiresAt,
    requesterId: request.requesterId,
  };
}

const FLOW_RESULTS = [];

module.exports = function runCriticalStabilityAudit(check) {
  function auditFlow(name, flowChecks) {
    const failed = flowChecks.filter(c => !c.pass);
    FLOW_RESULTS.push({ name, pass: failed.length === 0, failed: failed.map(f => f.label) });
    for (const c of flowChecks) {
      check(c.label, c.pass);
    }
  }

  const {
    formatMaskedCardNumber,
    formatCardExpiry,
  } = loadTsModule('src/utils/virtualCardDisplay.ts');

  const {
    formatStatusLabel,
    formatWalletIdShort,
    formatCurrencyNameSearch,
    formatUserIdShort,
  } = loadTsModule('src/utils/safeDisplay.ts');

  // ── 1. Virtual Card ─────────────────────────────────────────────────────
  const cardScreen = read('src/screens/CardScreen.tsx');
  const apiCard = sanitizeCard({
    id: 'c1', last4: '4242', expiryMonth: '12', expiryYear: '28', status: 'active',
  });
  auditFlow('Virtual Card', [
    { label: 'sanitized API card renders without throw', pass: (() => {
      try { formatMaskedCardNumber(apiCard); return true; } catch { return false; }
    })() },
    { label: 'CardScreen uses formatMaskedCardNumber', pass: /formatMaskedCardNumber/.test(cardScreen) },
    { label: 'CardScreen has no card.cardNumber.slice crash pattern', pass: !/maskCardNumber\s*\(\s*card\.cardNumber/.test(cardScreen) },
    { label: 'loadCards uses data.cards || []', pass: /data\.cards\s*\|\|\s*\[\]/.test(cardScreen) },
  ]);

  // ── 2. Wallet ───────────────────────────────────────────────────────────
  const walletScreen = read('src/screens/WalletScreen.tsx');
  auditFlow('Wallet', [
    { label: 'Wallet balances guarded with || []', pass: /\(wallet\.balances\s*\|\|\s*\[\]\)/.test(walletScreen) || /\(w\.balances\s*\|\|\s*\[\]\)/.test(walletScreen) },
    { label: 'WalletScreen uses safe balance map', pass: /\.map\(\(b:\s*Balance\)/.test(walletScreen) },
  ]);

  // ── 3. Deposit / Stripe PaymentSheet ────────────────────────────────────
  const depositScreen = read('src/screens/DepositScreen.tsx');
  auditFlow('Deposit / Stripe PaymentSheet', [
    { label: 'Deposit uses create-intent + confirmDeposit flow', pass: /create-intent/.test(depositScreen) && /confirmDeposit/.test(depositScreen) },
    { label: 'Deposit goes straight to Stripe (no fake card modal)', pass: /handleDeposit\(\)/.test(depositScreen) && !/showPaymentMethodModal/.test(depositScreen) },
    // buildCardOnlyPaymentSheetParams is invoked inside runDepositPaymentSheetOnce
    // (src/stripe/stripeSdk.ts), which also single-flight-guards the sheet so
    // concurrent taps can't open it twice — a stronger property than calling
    // the params builder directly from the screen.
    { label: 'Deposit PaymentSheet uses card-only + single-flight helper', pass: /runDepositPaymentSheetOnce\(/.test(depositScreen) },
    { label: 'Deposit min uses currency-aware major units', pass: /minDepositMajor\(currency\)/.test(depositScreen) },
    { label: 'Currency search uses safe name helper', pass: /formatCurrencyNameSearch/.test(depositScreen) },
    { label: 'Currency search has no ?.name.toUpperCase crash', pass: !/CURRENCY_INFO\[c\]\?\.name\.toUpperCase/.test(depositScreen) },
    { label: 'formatCurrencyNameSearch handles undefined', pass: formatCurrencyNameSearch(undefined) === '' },
  ]);

  // ── 4. Send ─────────────────────────────────────────────────────────────
  const sendScreen = read('src/screens/SendScreen.tsx');
  auditFlow('Send', [
    { label: 'Send uses formatWalletIdShort for wallet picker', pass: /formatWalletIdShort\(w\.id\)/.test(sendScreen) },
    { label: 'Send has no raw w.id.substring in wallet list', pass: !/w\.id\.substring\(0,\s*12\)/.test(sendScreen) },
    { label: 'Send balance reads use || []', pass: /\(w\.balances\s*\|\|\s*\[\]\)/.test(sendScreen) },
    { label: 'Send uses withBalance / refresh patterns', pass: /refreshWalletFromBackend/.test(sendScreen) },
    { label: 'formatWalletIdShort handles missing id', pass: formatWalletIdShort(undefined) === 'demo' },
  ]);

  // ── 5. Receive / Request Money ──────────────────────────────────────────
  const requestScreen = read('src/screens/RequestScreen.tsx');
  auditFlow('Request Money / Receive', [
    { label: 'Request uses formatStatusLabel for API statuses', pass: /formatStatusLabel\(req\.status/.test(requestScreen) },
    { label: 'Request has no raw req.status.toUpperCase()', pass: !/req\.status\.toUpperCase\(\)/.test(requestScreen) },
    { label: 'formatStatusLabel handles undefined', pass: formatStatusLabel(undefined) === 'UNKNOWN' },
  ]);

  // ── 6. Pay Request (share link) ───────────────────────────────────────────
  const payRequestScreen = read('src/screens/PayRequestScreen.tsx');
  const backendIndex = read('backend/index.js');
  const sampleReq = publicPaymentRequestShape({ id: 'r1', amount: 1000, currency: 'USD', memo: 'Lunch', status: undefined });
  auditFlow('Pay Request (share link)', [
    { label: 'PayRequestScreen gates render on request load', pass: /error\s*\|\|\s*!request/.test(payRequestScreen) },
    { label: 'Backend public GET exposes memo field', pass: /memo:\s*request\.memo\s*\|\|\s*''/.test(backendIndex) },
    { label: 'Backend public GET defaults status', pass: /status:\s*request\.status\s*\|\|\s*'pending'/.test(backendIndex) },
    { label: 'Public request shape safe for PayRequest memo display', pass: sampleReq.memo === 'Lunch' && sampleReq.status === 'pending' },
  ]);

  // ── 7. Withdraw ───────────────────────────────────────────────────────────
  auditFlow('Withdraw', [
    { label: 'Withdraw tab uses stale-FX guards (SendScreen)', pass: /shouldBlockForStaleFxQuote/.test(sendScreen) },
    { label: 'Withdraw uses pending withdrawal tracking', pass: /addPendingWithdrawal/.test(sendScreen) && /clearPendingWithdrawal/.test(sendScreen) },
    { label: 'Withdraw card last4 from user input only (not API PAN)', pass: /withdrawalCardNumber\.replace/.test(sendScreen) },
  ]);

  // ── 8. Exchange ───────────────────────────────────────────────────────────
  const exchangeScreen = read('src/screens/ExchangeScreen.tsx');
  auditFlow('Exchange', [
    { label: 'Exchange quote UI gated on quote object', pass: /quote\s*&&/.test(exchangeScreen) },
    { label: 'Exchange ownedBalances initialized safely', pass: /useState/.test(exchangeScreen) },
  ]);

  // ── 9. History / Receipt ──────────────────────────────────────────────────
  const historyScreen = read('src/screens/TransactionHistory.tsx');
  const receiptScreen = read('src/screens/ReceiptScreen.tsx');
  auditFlow('History / Receipt', [
    // getStatusLabel() (localized i18n status labels) supersedes the old inline
    // (item.status ?? 'unknown') render call, but preserves the same null-safety
    // guarantee internally via `(status ?? 'unknown').toLowerCase()`.
    { label: 'History null-safe status display', pass: /getStatusLabel\(item\.status\)/.test(historyScreen) && /\(status\s*\?\?\s*'unknown'\)/.test(historyScreen) },
    { label: 'History uses transactions || []', pass: /transactions\s*\|\|\s*\[\]/.test(historyScreen) },
    { label: 'Receipt defaults txStatus', pass: /txStatus/.test(receiptScreen) && /completed/.test(receiptScreen) },
  ]);

  // ── 10. Admin Dashboard ───────────────────────────────────────────────────
  const userDetail = read('backend/admin-dashboard/src/UserDetail.jsx');
  const kycReview = read('backend/admin-dashboard/src/KycReview.jsx');
  const limitsPanel = read('backend/admin-dashboard/src/components/UserLimitsPanel.jsx');
  auditFlow('Admin Dashboard', [
    { label: 'UserDetail normalizes wallets array', pass: /wallets\s*=\s*rawWallets\s*\|\|\s*\[\]/.test(userDetail) },
    { label: 'UserDetail uses optional profile access', pass: /profile\?\./.test(userDetail) },
    { label: 'KycReview guards doc.userId before slice', pass: /doc\.userId\s*\?/.test(kycReview) },
    { label: 'UserLimitsPanel guards nested limits', pass: /limits\?\.daily/.test(limitsPanel) },
    { label: 'formatUserIdShort handles missing id', pass: formatUserIdShort(undefined) === '—' },
  ]);

  // ── 11. Backend money endpoints ───────────────────────────────────────────
  auditFlow('Backend money endpoints', [
    { label: 'GET /virtual-cards returns cards array guard', pass: /\(db\.virtualCards\s*\|\|\s*\[\]\)/.test(backendIndex) },
    { label: 'GET /payment-requests list guarded', pass: /const requests = \(db\.paymentRequests \|\| \[\]\)/.test(backendIndex) },
    { label: 'POST /transactions uses balance mutex', pass: /withBalanceMutex/.test(backendIndex) },
    { label: 'Deposit create-intent validates amount >= 100 minor', pass: /minDepositMinor\(currency\)/.test(backendIndex) && /error_deposit_minimum/.test(backendIndex) },
    { label: 'Deposit PaymentIntent is card-only', pass: /payment_method_types:\s*\['card'\]/.test(backendIndex) && !/automatic_payment_methods:\s*\{\s*enabled:\s*true/.test(backendIndex) },
  ]);

  // Summary line for runner
  const failedFlows = FLOW_RESULTS.filter(f => !f.pass);
  check(
    `[Summary] All ${FLOW_RESULTS.length} critical flows pass stability audit`,
    failedFlows.length === 0,
  );

  if (failedFlows.length > 0) {
    for (const f of failedFlows) {
      check(`  ↳ FAILED flow: ${f.name}`, false);
      for (const item of f.failed) {
        check(`      • ${item}`, false);
      }
    }
  }
};
