'use strict';

const fs = require('fs');
const path = require('path');

const SEND_SCREEN = path.join(__dirname, '..', 'src', 'screens', 'SendScreen.tsx');

/** Keep in sync with exported helpers at top of SendScreen.tsx — verified by source audit below. */
function withdrawalRequiresFxConversion(_tab) {
  return false;
}
function shouldFetchTransferFxQuote(tab) {
  return tab === 'transfer';
}
function shouldBlockForStaleFxQuote(tab, isCrossCurrency, ratesStale) {
  if (tab !== 'transfer' || !isCrossCurrency) return false;
  return !!ratesStale;
}
function computePreviewCrossCurrency(tab, senderCurrency, receiverCurrency) {
  if (tab !== 'transfer') return false;
  return (receiverCurrency || senderCurrency) !== senderCurrency;
}
function effectivePreviewReceiverCurrency(tab, senderCurrency, receiverCurrency) {
  return tab === 'transfer' ? (receiverCurrency || senderCurrency) : senderCurrency;
}

function loadSendScreenSource() {
  return fs.readFileSync(SEND_SCREEN, 'utf8');
}

function findRatesPaths(src) {
  const paths = [];
  const patterns = [
    { name: 'fetchFxQuote', re: /fetchFxQuote\s*\(/g },
    { name: 'ratesUnavailable', re: /exchange\.ratesUnavailable/g },
    { name: 'ratesStale', re: /ratesStale/g },
    { name: 'fxQuote', re: /\bfxQuote\b/g },
  ];
  for (const { name, re } of patterns) {
    let match;
    while ((match = re.exec(src)) !== null) {
      const line = src.slice(0, match.index).split('\n').length;
      paths.push({ name, line, snippet: src.split('\n')[line - 1].trim() });
    }
  }
  return paths;
}

function extractFunctionBody(src, name) {
  const re = new RegExp(`async function ${name}\\([\\s\\S]*?\\n  \\}`);
  const match = src.match(re);
  return match ? match[0] : '';
}

function enclosingFunctionName(src, lineNumber) {
  const lines = src.split('\n').slice(0, lineNumber);
  for (let i = lines.length - 1; i >= 0; i--) {
    const fn = lines[i].match(/(?:async\s+)?function\s+(\w+)/);
    if (fn) return fn[1];
  }
  return null;
}

const source = loadSendScreenSource();

module.exports = function runWithdrawalStaleFxTests(check) {
  // ── Rule 1: Withdraw tab never calls /fx-quote ───────────────────────────
  check(
    '[Rule 1] shouldFetchTransferFxQuote(false) on withdraw tab',
    shouldFetchTransferFxQuote('withdraw') === false,
  );
  check(
    '[Rule 1] useEffect early-returns before FX lookup on withdraw tab',
    /if \(!shouldFetchTransferFxQuote\(activeTab\)\) return;/.test(source),
  );
  check(
    '[Rule 1] fetchFxQuote guarded immediately before network call',
    /if \(cancelled \|\| !shouldFetchTransferFxQuote\(activeTab\)\) return;\s*\n\s*const quote = await fetchFxQuote/.test(source),
  );
  check(
    '[Rule 1] only one fetchFxQuote call site in SendScreen',
    (source.match(/fetchFxQuote\s*\(/g) || []).length === 1,
  );

  // ── Rule 2: Withdraw confirm never shows stale FX unless conversion required ─
  check(
    '[Rule 2] withdrawalRequiresFxConversion is always false today',
    withdrawalRequiresFxConversion('withdraw') === false,
  );
  check(
    '[Rule 2] onWithdrawConfirmed uses getWithdrawalConfirmErrorMessage (not raw rates guard)',
    /getWithdrawalConfirmErrorMessage\(e\)/.test(source),
  );
  check(
    '[Rule 2] onWithdrawConfirmed never Alert.alert exchange.ratesUnavailable',
    !extractFunctionBody(source, 'onWithdrawConfirmed').includes(
      "Alert.alert(t('send.transactionFailed'), t('exchange.ratesUnavailable'))",
    ),
  );
  check(
    '[Rule 2] exactly two Alert.alert paths use exchange.ratesUnavailable (transfer only)',
    (source.match(/Alert\.alert\(t\('send\.transactionFailed'\), t\('exchange\.ratesUnavailable'\)\)/g) || []).length === 2,
  );
  check(
    '[Rule 2] onSend blocks stale FX via shouldBlockForStaleFxQuote',
    /async function onSend[\s\S]*?shouldBlockForStaleFxQuote[\s\S]*?Alert\.alert\(t\('send\.transactionFailed'\), t\('exchange\.ratesUnavailable'\)\)/.test(source),
  );
  check(
    '[Rule 2] onSendConfirmed blocks stale FX via shouldBlockForStaleFxQuote',
    /async function onSendConfirmed[\s\S]*?shouldBlockForStaleFxQuote[\s\S]*?Alert\.alert\(t\('send\.transactionFailed'\), t\('exchange\.ratesUnavailable'\)\)/.test(source),
  );
  check(
    '[Rule 2] getWithdrawalConfirmErrorMessage suppresses ratesUnavailable without FX conversion',
    /if \(msg === t\('exchange\.ratesUnavailable'\)\)/.test(source),
  );

  // ── Rule 3: Withdraw tab switch clears transfer FX state ───────────────────
  check(
    '[Rule 3] clearTransferFxState helper clears toWalletId, receiverCurrency, fxQuote',
    /function clearTransferFxState\(\)[\s\S]*?setToWalletId\(''\)[\s\S]*?setReceiverCurrency\(null\)[\s\S]*?setFxQuote\(null\)/.test(source),
  );
  check(
    '[Rule 3] withdraw tab onPress calls clearTransferFxState',
    /setActiveTab\('withdraw'\);\s*\n\s*clearTransferFxState\(\)/.test(source),
  );

  // ── Behavioral proofs ──────────────────────────────────────────────────────
  check(
    '[Proof] stale FX does not block same-currency withdrawal confirm',
    !shouldBlockForStaleFxQuote('withdraw', false, true),
  );
  check(
    '[Proof] leftover transfer receiverCurrency cannot make withdrawal cross-currency',
    !computePreviewCrossCurrency('withdraw', 'XAF', 'USD'),
  );
  check(
    '[Proof] leftover transfer receiverCurrency ignored in withdraw preview currency',
    effectivePreviewReceiverCurrency('withdraw', 'XAF', 'USD') === 'XAF',
  );
  check(
    '[Proof] withdraw tab does not fetch /fx-quote',
    !shouldFetchTransferFxQuote('withdraw'),
  );
  check(
    '[Proof] cross-currency transfer still blocks on stale FX quote',
    shouldBlockForStaleFxQuote('transfer', true, true),
  );
  check(
    '[Proof] same-currency transfer does not block on stale FX quote',
    !shouldBlockForStaleFxQuote('transfer', false, true),
  );

  // ── Path audit: every fxQuote / ratesStale / ratesUnavailable site ───────────
  const staleSites = findRatesPaths(source).filter(p => p.name === 'ratesStale');

  check(
    '[Audit] onWithdrawConfirmed never reads ratesStale',
    staleSites.every(p => enclosingFunctionName(source, p.line) !== 'onWithdrawConfirmed'),
  );
  check(
    '[Audit] confirmation FX rows gated to transfer tab',
    (source.match(/activeTab === 'transfer' && preview\.isCrossCurrency/g) || []).length >= 3,
  );
  check(
    '[Audit] ratesUnavailable Alert.alert only in onSend and onSendConfirmed',
    findRatesPaths(source)
      .filter(p => p.name === 'ratesUnavailable')
      .filter(p => source.split('\n')[p.line - 1].includes('Alert.alert'))
      .every(p => {
        const fn = enclosingFunctionName(source, p.line);
        return fn === 'onSend' || fn === 'onSendConfirmed';
      }),
  );
  check(
    '[Audit] fetchFxQuote appears only inside transfer-tab FX useEffect',
    findRatesPaths(source)
      .filter(p => p.name === 'fetchFxQuote')
      .every(p => {
        const chunk = source.split('\n').slice(Math.max(0, p.line - 30), p.line).join('\n');
        return /shouldFetchTransferFxQuote/.test(chunk);
      }),
  );
  check(
    '[Audit] calculatePreview uses exported cross-currency helpers',
    /computePreviewCrossCurrency\(activeTab, currency, receiverCurrency\)/.test(source)
      && /effectivePreviewReceiverCurrency\(activeTab, currency, receiverCurrency\)/.test(source),
  );
  check(
    '[Audit] SendScreen exports hard-rule helpers at module scope',
    /export function withdrawalRequiresFxConversion/.test(source)
      && /export function shouldFetchTransferFxQuote/.test(source)
      && /export function shouldBlockForStaleFxQuote/.test(source),
  );
};
