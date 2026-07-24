const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

function loadTsModule(filePath) {
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

const { getApiErrorMessage } = loadTsModule(
  path.join(__dirname, '..', 'src', 'utils', 'apiErrorMessage.ts'),
);

// Keys/values mirror the real EN dictionary in src/i18n/translations.ts —
// keep these two files in sync so this test stays pinned to actual app copy.
const dictionary = {
  'common.networkError': 'Network error. Please try again.',
  'common.requestTimeout': 'The request is taking longer than expected. Please try again.',
  'apiError.invalidToken': 'Your session has expired. Please sign in again.',
  'apiError.notFound': 'The requested item was not found.',
  'apiError.requestFailed': 'The request could not be completed. Please try again.',
  'send.backendUnavailable': 'Our servers are temporarily unavailable. Please try again in a few minutes.',
  'exchange.tooManyRequests': 'Too many requests. Please wait a moment and try again.',
  'exchange.ratesUnavailable': 'FX rates are outdated. Exchange is temporarily unavailable. Please try again shortly.',
  'apiError.walletNotFound': 'Wallet not found.',
  'apiError.internalError': 'Something went wrong. Please try again.',
  'send.countryNotSupported': 'Withdrawals for your country are not available yet. We currently support withdrawals to Nigeria, Kenya, South Africa, Ghana, Ivory Coast, Cameroon, Egypt, and Tanzania.',
  'send.bankNotSupportedForCurrency': 'Bank withdrawals are not available for this currency. Please use Mobile Money instead.',
  'send.mobileMoneyNotSupportedForCurrency': 'Mobile Money withdrawals are not available for this currency.',
  'send.corridorValidationUnavailable': "We couldn't verify your bank/operator details right now. No funds were held. Please try again in a few minutes.",
  'card.notAvailable': 'Virtual Cards Coming Soon',
};

const t = key => dictionary[key] || key;

test('401 maps to session-expired copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 401, message: 'Invalid token' }, t),
    dictionary['apiError.invalidToken'],
  );
});

// 403 without a recognized message pattern falls back to the generic,
// already-translated "request failed" copy rather than leaking the raw
// (English-only, unlocalized) backend reason text to non-English users.
test('403 with an unrecognized reason falls back to localized generic copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 403, message: 'You are not allowed to pay this request' }, t),
    dictionary['apiError.requestFailed'],
  );
});

// "wallet not found" is a recognized message pattern (see MESSAGE_TO_I18N in
// apiErrorMessage.ts) and resolves to the *translated* wallet-not-found copy,
// not a raw pass-through of the backend's English message.
test('404 "Wallet not found" maps to the localized wallet-not-found copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 404, message: 'Wallet not found' }, t),
    dictionary['apiError.walletNotFound'],
  );
});

// 409 without a recognized message pattern (e.g. not a username conflict)
// falls back to the generic localized copy, same as any other unmapped 4xx.
test('409 with an unrecognized reason falls back to localized generic copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 409, message: 'Already processed' }, t),
    dictionary['apiError.requestFailed'],
  );
});

test('429 maps to too many attempts', () => {
  assert.equal(
    getApiErrorMessage({ status: 429, message: 'Too many requests' }, t),
    dictionary['exchange.tooManyRequests'],
  );
});

// The literal message "Internal server error" matches the MESSAGE_TO_I18N
// normalized lookup (checked before the generic 503 branch), so it resolves
// to the localized internal-error copy. A 503 whose message does NOT match
// any known pattern (e.g. "Service temporarily unavailable") is what maps to
// the "servers are temporarily unavailable" copy — covered by the next test.
test('503 "Internal server error" maps to the localized internal-error copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 503, message: 'Internal server error' }, t),
    dictionary['apiError.internalError'],
  );
});

// Any status===503 (regardless of message, unless the message itself hits a
// MESSAGE_TO_I18N entry first, like the case above) is treated as a stale/
// unavailable-exchange-rates condition — this mirrors how DepositScreen /
// ExchangeScreen surface FX-rate staleness from the backend.
test('503 with an unmatched message maps to "rates unavailable" copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 503, message: 'Service temporarily unavailable' }, t),
    dictionary['exchange.ratesUnavailable'],
  );
});

// 'Withdrawal failed' is the one message that resolves to the "servers
// temporarily unavailable" copy — but only for a non-503/429 status, since a
// 503 status always short-circuits to the rates-unavailable copy above.
test("'Withdrawal failed' with a plain 500 maps to backend-unavailable copy", () => {
  assert.equal(
    getApiErrorMessage({ status: 500, message: 'Withdrawal failed' }, t),
    dictionary['send.backendUnavailable'],
  );
});

test('offline transport maps to no-internet copy', () => {
  assert.equal(
    getApiErrorMessage({ message: 'Network request failed', isOffline: true }, t),
    dictionary['common.networkError'],
  );
});

test('timeout transport maps to timeout copy', () => {
  assert.equal(
    getApiErrorMessage({ message: 'Request timeout exceeded', statusCode: 408 }, t),
    dictionary['common.requestTimeout'],
  );
});

// Withdrawal capability-gating error codes (backend/index.js POST /withdrawals
// and backend/payoutProviders.js payoutRouter()) must surface their specific,
// honest copy — NOT the generic "request failed" fallback — even though they
// arrive with a 400/503 status that would otherwise hit the generic branch.
test('errorCode COUNTRY_NOT_SUPPORTED maps to the specific country-gating copy, not the generic 400 fallback', () => {
  assert.equal(
    getApiErrorMessage({ status: 400, errorCode: 'COUNTRY_NOT_SUPPORTED', message: 'Withdrawals for your country are not available yet.' }, t),
    dictionary['send.countryNotSupported'],
  );
});

test('errorCode PROVIDER_NOT_READY maps to backend-unavailable copy, not the generic rates-unavailable 503 fallback', () => {
  assert.equal(
    getApiErrorMessage({ status: 503, errorCode: 'PROVIDER_NOT_READY', message: 'Withdrawals are temporarily unavailable. Please contact support.' }, t),
    dictionary['send.backendUnavailable'],
  );
});

test('errorCode KORA_BANK_UNSUPPORTED maps to the currency-specific bank-unsupported copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 400, errorCode: 'KORA_BANK_UNSUPPORTED', message: 'Bank withdrawals are not available for XAF.' }, t),
    dictionary['send.bankNotSupportedForCurrency'],
  );
});

test('errorCode KORA_MOBILE_MONEY_UNSUPPORTED maps to the currency-specific mobile-money-unsupported copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 400, errorCode: 'KORA_MOBILE_MONEY_UNSUPPORTED', message: 'Mobile Money withdrawals are not available for NGN.' }, t),
    dictionary['send.mobileMoneyNotSupportedForCurrency'],
  );
});

test('errorCode VIRTUAL_CARDS_UNAVAILABLE maps to the card-not-available copy', () => {
  assert.equal(
    getApiErrorMessage({ status: 503, errorCode: 'VIRTUAL_CARDS_UNAVAILABLE', message: 'Virtual cards are not available yet.' }, t),
    dictionary['card.notAvailable'],
  );
});

// Kora's live bank/operator list could not be verified (fail-closed — see
// koraCorridorRules.js). This arrives as a 503 (safely retryable) but must
// surface the specific "no funds held, try again" copy, not the generic
// exchange.ratesUnavailable 503 fallback which would confusingly imply an FX
// problem rather than a payout-provider validation problem.
test('errorCode PROVIDER_VALIDATION_UNAVAILABLE maps to the specific fail-closed retry copy, not the generic rates-unavailable 503 fallback', () => {
  assert.equal(
    getApiErrorMessage({ status: 503, errorCode: 'PROVIDER_VALIDATION_UNAVAILABLE', message: 'We could not verify bank details for ZA right now. Please try again in a few minutes.' }, t),
    dictionary['send.corridorValidationUnavailable'],
  );
});
