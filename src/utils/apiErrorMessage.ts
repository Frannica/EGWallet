export type ApiErrorLike = {
  message?: string;
  code?: string;
  errorCode?: string;
  limitType?: string;
  status?: number;
  /** Set by protectedClient when the request never reached the server (device offline). */
  isOffline?: boolean;
};

const ERROR_CODE_TO_I18N: Record<string, string> = {
  error_not_found: 'apiError.notFound',
  error_user_not_found: 'apiError.userNotFound',
  error_username_invalid: 'apiError.usernameInvalid',
  error_username_taken: 'apiError.usernameTaken',
  error_username_required: 'apiError.usernameRequired',
  error_invalid_token: 'apiError.invalidToken',
  error_missing_token: 'apiError.invalidToken',
  error_wallet_not_found: 'apiError.walletNotFound',
  error_request_not_found: 'apiError.requestNotFound',
  error_deposit_minimum: 'apiError.depositMinimum',
  error_internal: 'apiError.internalError',
  // Withdrawal / payout-provider capability gating (see backend/index.js
  // POST /withdrawals and backend/payoutProviders.js payoutRouter()).
  // These MUST map to specific, honest messages — never the generic
  // apiError.requestFailed fallback — because they represent a country or
  // currency/method combination that genuinely isn't supported yet, not a
  // transient failure.
  COUNTRY_NOT_SUPPORTED: 'send.countryNotSupported',
  PROVIDER_NOT_READY: 'send.backendUnavailable',
  KORA_BANK_UNSUPPORTED: 'send.bankNotSupportedForCurrency',
  KORA_MOBILE_MONEY_UNSUPPORTED: 'send.mobileMoneyNotSupportedForCurrency',
  VIRTUAL_CARDS_UNAVAILABLE: 'card.notAvailable',
  // Kora's live operator/bank list could not be verified (no live data, no
  // usable cache) — the backend FAILS CLOSED and rejects before any wallet
  // hold. This is safely retryable: no funds moved, just try again shortly.
  PROVIDER_VALIDATION_UNAVAILABLE: 'send.corridorValidationUnavailable',
};

/** Normalize backend error text for legacy responses without errorCode. */
function normalizeMessage(msg: string): string {
  return msg.trim().replace(/\.$/, '').toLowerCase();
}

const MESSAGE_TO_I18N: Record<string, string> = {
  'not found': 'apiError.notFound',
  'user not found': 'apiError.userNotFound',
  'username must be 3-20 characters (letters, numbers, underscores only)': 'apiError.usernameInvalid',
  'username already taken': 'apiError.usernameTaken',
  'username is required': 'apiError.usernameRequired',
  'invalid token': 'apiError.invalidToken',
  'invalid token.': 'apiError.invalidToken',
  'missing token': 'apiError.invalidToken',
  'wallet not found': 'apiError.walletNotFound',
  'request not found': 'apiError.requestNotFound',
  'internal server error': 'apiError.internalError',
};

/** True only for transport-layer failures, not HTTP error bodies from the server. */
function isTransportError(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('network request failed') ||
    m === 'failed to fetch' ||
    m.includes('econnrefused') ||
    m.includes('enetunreach') ||
    m.includes('unable to resolve host') ||
    m.includes('connection refused') ||
    m.includes('connection reset')
  );
}

/** Map backend/API errors to localized user-facing messages. */
export function getApiErrorMessage(e: ApiErrorLike, t: (key: string) => string): string {
  const msg = e?.message || '';

  if (e?.isOffline) {
    return t('common.networkError');
  }

  if (e?.errorCode && ERROR_CODE_TO_I18N[e.errorCode]) {
    return t(ERROR_CODE_TO_I18N[e.errorCode]);
  }

  const normalized = normalizeMessage(msg);
  if (normalized && MESSAGE_TO_I18N[normalized]) {
    return t(MESSAGE_TO_I18N[normalized]);
  }

  if (e?.code === 'LIMIT_EXCEEDED' || e?.code === 'PAYROLL_LIMIT_EXCEEDED' || (e?.status === 403 && e?.limitType)) {
    const limit = msg.match(/\$[\d,]+/)?.[0] ?? '';
    if (e.limitType === 'weekly') {
      return t('send.limitWeeklyReached').replace('{{limit}}', limit);
    }
    if (e.limitType === 'monthly') {
      return t('send.limitMonthlyReached').replace('{{limit}}', limit);
    }
    return t('send.limitDailyReached').replace('{{limit}}', limit);
  }

  if (e?.status === 503 || /outdated|temporarily unavailable/i.test(msg)) {
    return t('exchange.ratesUnavailable');
  }
  if (e?.status === 429 || /too many requests/i.test(msg)) {
    return t('exchange.tooManyRequests');
  }
  if (/timed out|timeout/i.test(msg)) {
    return t('common.requestTimeout');
  }

  if (e?.status && e.status >= 400) {
    if (msg === 'Create card failed') return t('card.createFailed');
    if (msg === 'Toggle freeze failed' || msg === 'Delete card failed') return t('card.actionFailed');
    if (msg === 'QR payment failed') return t('qrScan.somethingWentWrong');
    if (msg === 'Exchange failed') return t('exchange.rateError');
    if (msg === 'Quote unavailable') return t('exchange.rateError');
    if (msg === 'Withdrawal failed') return t('send.backendUnavailable');
    if (e.status === 404) return t('apiError.notFound');
    if (e.status === 401) return t('apiError.invalidToken');
    if (e.status === 409 && /username/i.test(msg)) return t('apiError.usernameTaken');
    if (e.status === 400 && /username/i.test(msg)) return t('apiError.usernameInvalid');
    return t('apiError.requestFailed');
  }

  if (isTransportError(msg)) {
    return t('common.networkError');
  }

  if (msg === 'Create card failed') return t('card.createFailed');
  if (msg === 'Toggle freeze failed' || msg === 'Delete card failed') return t('card.actionFailed');
  if (msg === 'QR payment failed') return t('qrScan.somethingWentWrong');
  if (msg === 'Exchange failed') return t('exchange.rateError');
  if (msg === 'Quote unavailable') return t('exchange.rateError');
  if (msg === 'Withdrawal failed') return t('send.backendUnavailable');

  return msg ? t('apiError.requestFailed') : t('apiError.requestFailed');
}
