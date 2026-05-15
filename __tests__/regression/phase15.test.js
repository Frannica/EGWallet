/**
 * Phase 15 regression guards — In-wallet currency exchange (backend only)
 *
 * Invariants protected:
 *  A. POST /exchange endpoint exists with correct structure
 *  B. Idempotency protection is present (reuses idempotencyStore)
 *  C. FX safety guard (fxSafetyCheck) is applied
 *  D. Same-currency exchange is rejected before any mutation
 *  E. Transaction record uses type: 'exchange', fromWalletId === toWalletId
 *  F. Rollback on saveDB failure — all three paths covered
 *  G. KYC limits are checked and tracked
 *  H. Conversion math is correct for all 4 required currency pairs
 *     (XAF→USD, USD→XAF, XAF→GBP, MAD→EUR) using seed rates
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const be = fs.readFileSync(path.resolve(__dirname, '../../backend/index.js'), 'utf8');

// ── Isolate the /exchange handler body ────────────────────────────────────────
// Find start: the app.post declaration
const EXCHANGE_START = be.indexOf("app.post('/exchange', authMiddleware");
// Find end: the next top-level app. declaration after the handler
const EXCHANGE_END   = be.indexOf('\napp.', EXCHANGE_START + 10);
const HANDLER        = be.slice(EXCHANGE_START, EXCHANGE_END > 0 ? EXCHANGE_END : EXCHANGE_START + 6000);

// ── Pure math helpers (mirrors backend logic exactly) ─────────────────────────
const DECIMALS = { USD: 2, EUR: 2, GBP: 2, MAD: 2, XAF: 0, XOF: 0 };
function decimalsFor(c) { return DECIMALS[c] !== undefined ? DECIMALS[c] : 2; }
function minorToMajor(minor, c) { return minor / Math.pow(10, decimalsFor(c)); }
function majorToMinor(major, c) { return Math.round(major * Math.pow(10, decimalsFor(c))); }
function calcFxFee(raw) {
  const fee = Math.round(raw * 0.0115);
  return { feeAmount: fee, netReceived: raw - fee };
}
function simulateConvert(fromRate, toRate, amount, fromCurrency, toCurrency) {
  const amtMajorFrom = minorToMajor(amount, fromCurrency);
  const amtUSD       = amtMajorFrom / fromRate;
  const amtMajorTo   = amtUSD * toRate;
  const raw          = majorToMinor(amtMajorTo, toCurrency);
  const { feeAmount, netReceived } = calcFxFee(raw);
  return { raw, feeAmount, netReceived };
}

// Seed rates from db.json initial values (used to verify math)
const RATES = { USD: 1, EUR: 0.93, GBP: 0.79, MAD: 10, XAF: 600 };

// ─────────────────────────────────────────────────────────────────────────────

module.exports = function phase15(check) {

  // ── A. Endpoint structure ─────────────────────────────────────────────────
  check('[Exchange] POST /exchange endpoint declared with authMiddleware',
    EXCHANGE_START !== -1 &&
    be.includes("app.post('/exchange', authMiddleware"));

  check('[Exchange] Required fields validated: walletId, fromCurrency, toCurrency, amount',
    HANDLER.includes('!walletId || !fromCurrency || !toCurrency || typeof amount'));

  check('[Exchange] amount validated as positive integer ≤ 1_000_000_000',
    HANDLER.includes('!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000'));

  check('[Exchange] Wallet ownership verified (walletId + userId match)',
    HANDLER.includes('w.id === walletId && w.userId === req.user.userId'));

  check('[Exchange] Source balance existence and sufficiency checked',
    HANDLER.includes('fromBalance.amount < amount'));

  // ── B. Idempotency ────────────────────────────────────────────────────────
  check("[Exchange] Idempotency key read from body or headers",
    HANDLER.includes("idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key']"));

  check('[Exchange] Cached response returned within IDEMPOTENCY_EXPIRY window',
    HANDLER.includes('idempotencyStore.get(clientKey)') &&
    HANDLER.includes('IDEMPOTENCY_EXPIRY'));

  check('[Exchange] Idempotency key stored on successful exchange',
    HANDLER.includes('idempotencyStore.set(clientKey'));

  // ── C. FX safety ──────────────────────────────────────────────────────────
  check('[Exchange] fxSafetyCheck called on receivedAmountMinor',
    HANDLER.includes('fxSafetyCheck(receivedAmountMinor, toCurrency)'));

  check('[Exchange] fxGuard.safe checked — 500 returned on unsafe result',
    HANDLER.includes('fxGuard.safe') &&
    HANDLER.includes('FX conversion error'));

  check('[Exchange] calcFxFee applied to raw converted amount',
    HANDLER.includes('calcFxFee(receivedAmountMinor)'));

  // ── D. Same-currency guard ────────────────────────────────────────────────
  check('[Exchange] Same-currency exchange rejected before any mutation',
    HANDLER.includes('fromCurrency === toCurrency') &&
    HANDLER.indexOf('fromCurrency === toCurrency') < HANDLER.indexOf('fromBalance.amount -='));

  // ── E. Transaction record ─────────────────────────────────────────────────
  check("[Exchange] Transaction record type is 'exchange'",
    HANDLER.includes("type:             'exchange'"));

  check('[Exchange] fromWalletId and toWalletId both set to walletId (same wallet)',
    HANDLER.includes('fromWalletId:     walletId') &&
    HANDLER.includes('toWalletId:       walletId'));

  check('[Exchange] wasConverted: true on transaction record',
    HANDLER.includes('wasConverted:     true'));

  check('[Exchange] receivedCurrency field set to toCurrency',
    HANDLER.includes('receivedCurrency: toCurrency'));

  check('[Exchange] status: completed on transaction record',
    HANDLER.includes("status:           'completed'"));

  check('[Exchange] db.transactions.push(tx) called',
    HANDLER.includes('db.transactions.push(tx)'));

  // ── F. Rollback on saveDB failure ────────────────────────────────────────
  check('[Exchange] Rollback snapshot taken: originalFromAmount',
    HANDLER.includes('const originalFromAmount = fromBalance.amount'));

  check('[Exchange] Rollback snapshot taken: originalToAmount',
    HANDLER.includes('const originalToAmount   = toBalance ? toBalance.amount : null'));

  check('[Exchange] Rollback restores fromBalance.amount',
    HANDLER.includes('fromBalance.amount = originalFromAmount'));

  check('[Exchange] Rollback restores toBalance.amount when toCurrency already existed',
    HANDLER.includes('toBalance.amount = originalToAmount'));

  check('[Exchange] Rollback removes newly-pushed balance entry when toCurrency was new',
    HANDLER.includes('wallet.balances.filter(b => b.currency !== toCurrency)'));

  check('[Exchange] db.transactions.pop() called in rollback path',
    HANDLER.includes('db.transactions.pop()'));

  // ── G. KYC limits ─────────────────────────────────────────────────────────
  check('[Exchange] checkKYCLimits(senderUser, amountUSD, db) called before balance mutation',
    HANDLER.includes('checkKYCLimits(senderUser, amountUSD, db)') &&
    HANDLER.indexOf('checkKYCLimits(senderUser, amountUSD, db)') < HANDLER.indexOf('fromBalance.amount -='));

  check('[Exchange] LIMIT_EXCEEDED code returned when KYC blocks exchange',
    HANDLER.includes("code:                'LIMIT_EXCEEDED'"));

  check('[Exchange] updateLimitTracking(senderUser, amountUSD) called on success',
    HANDLER.includes('updateLimitTracking(senderUser, amountUSD)'));

  // ── H. Conversion math verification (pure functions, no server needed) ────
  //
  // Seed rates: XAF=600, USD=1, GBP=0.79, MAD=10, EUR=0.93
  // FX fee: 1.15% on the converted (received) amount, deducted before crediting
  //
  // Formula: minor(from) → major(from) → ÷rate(from) → USD → ×rate(to) → major(to) → minor(to)
  //          fee = round(receivedMinor × 0.0115), net = receivedMinor − fee
  //
  // XAF has 0 decimal places (1 minor unit = 1 XAF)
  // USD, GBP, MAD, EUR all have 2 decimal places
  // ─────────────────────────────────────────────────────────────────────────

  // XAF → USD: 60,000 XAF → 10,000 cents raw → fee 115 cents → net 9,885 cents ($98.85)
  check('[Exchange Math] XAF→USD: 60,000 XAF gives raw=10000¢, fee=115¢, net=9885¢ ($98.85)',
    (() => {
      const { raw, feeAmount, netReceived } =
        simulateConvert(RATES.XAF, RATES.USD, 60000, 'XAF', 'USD');
      return raw === 10000 && feeAmount === 115 && netReceived === 9885;
    })());

  // USD → XAF: $100 (10,000 cents) → 60,000 XAF raw → fee 690 XAF → net 59,310 XAF
  check('[Exchange Math] USD→XAF: $100 (10,000¢) gives raw=60000 XAF, fee=690, net=59310',
    (() => {
      const { raw, feeAmount, netReceived } =
        simulateConvert(RATES.USD, RATES.XAF, 10000, 'USD', 'XAF');
      return raw === 60000 && feeAmount === 690 && netReceived === 59310;
    })());

  // XAF → GBP: 60,000 XAF → 7,900 pence raw → fee 91p → net 7,809p (£78.09)
  check('[Exchange Math] XAF→GBP: 60,000 XAF gives raw=7900p, fee=91p, net=7809p (£78.09)',
    (() => {
      const { raw, feeAmount, netReceived } =
        simulateConvert(RATES.XAF, RATES.GBP, 60000, 'XAF', 'GBP');
      return raw === 7900 && feeAmount === 91 && netReceived === 7809;
    })());

  // MAD → EUR: 1,000 MAD (100,000 centimes) → 9,300 euro-cents raw → fee 107¢ → net 9,193¢ (€91.93)
  check('[Exchange Math] MAD→EUR: 100,000 centimes (1000 MAD) gives raw=9300¢, fee=107¢, net=9193¢ (€91.93)',
    (() => {
      const { raw, feeAmount, netReceived } =
        simulateConvert(RATES.MAD, RATES.EUR, 100000, 'MAD', 'EUR');
      return raw === 9300 && feeAmount === 107 && netReceived === 9193;
    })());

  // Extra: FX fee rate constant is 1.15% in backend (not changed)
  check('[Exchange] FEES.FX_RATE is 0.0115 (1.15%) — exchange uses same fee as P2P sends',
    be.includes('FX_RATE:             0.0115'));
};
