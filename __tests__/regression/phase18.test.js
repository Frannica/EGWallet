'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = fs.readFileSync(path.join(ROOT, 'backend', 'index.js'), 'utf8');
const LOCAL = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'localBalance.ts'), 'utf8');
const WALLET_SYNC = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'walletSync.ts'), 'utf8');
const TXNS = fs.readFileSync(path.join(ROOT, 'src', 'api', 'transactions.ts'), 'utf8');
const SEND = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SendScreen.tsx'), 'utf8');
const PAY_REQ = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'PayRequestScreen.tsx'), 'utf8');

const PR_PAY = BACKEND.slice(
  BACKEND.indexOf("app.post('/payment-requests/:id/pay'"),
  BACKEND.indexOf("app.post('/payment-requests/:id/cancel'"),
);

module.exports = function phase18(check) {
  check(
    '[Balance] syncLocalBalancesFromBackend overwrites local from backend',
    LOCAL.includes('synced[b.currency] =') &&
    LOCAL.includes('removeItem(LAST_DEBIT_KEY)'),
  );
  check(
    '[Balance] refreshWalletFromBackend fetches then syncs',
    WALLET_SYNC.includes('listWallets') &&
    WALLET_SYNC.includes('syncLocalBalancesFromBackend'),
  );
  check(
    '[Send] checkBalance uses backend wallet after refresh (not stale local min)',
    SEND.includes('refreshAndSetWallets') &&
    SEND.includes('backendMajor') &&
    !SEND.includes('Math.min(backendMajor, localMajor)'),
  );
  check(
    '[Send] refresh wallet after send success or failure',
    SEND.includes('refreshAndSetWallets') &&
    (SEND.match(/refreshAndSetWallets/g) || []).length >= 3,
  );
  check(
    '[Send] no optimistic debitLocalBalance on transfer success',
    !SEND.includes('await debitLocalBalance(currency, amountMinor)'),
  );
  check(
    '[Send] sendTransaction uses postWithIdempotencyRetry with 30s timeout',
    TXNS.includes('postWithIdempotencyRetry') &&
    TXNS.includes('MONEY_OP_TIMEOUT_MS = 30000') &&
    TXNS.includes('reconcile()'),
  );
  check(
    '[PayRequest] payPaymentRequest with idempotency key',
    TXNS.includes('payPaymentRequest') &&
    PAY_REQ.includes('payIdempotencyKeyRef') &&
    PAY_REQ.includes('payPaymentRequest('),
  );
  check(
    '[PayRequest] refresh wallet in finally after pay attempt',
    PAY_REQ.includes('refreshWalletFromBackend') &&
    PAY_REQ.includes('finally'),
  );
  check(
    '[PayRequest] backend returns 200 for already-paid by same payer',
    PR_PAY.includes("request.status === 'paid'") &&
    PR_PAY.includes('idempotentReplay: true') &&
    PR_PAY.includes('return res.status(200).json(replayBody)'),
  );
  check(
    '[PayRequest] payment pay integrity check — payer balance must decrease',
    PR_PAY.includes('INTEGRITY FAIL — payer balance did not decrease'),
  );
  check(
    '[PayRequest] no optimistic debitLocalBalance on pay success',
    !PAY_REQ.includes('debitLocalBalance'),
  );
};
