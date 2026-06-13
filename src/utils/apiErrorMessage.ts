export type ApiErrorLike = {
  message?: string;
  code?: string;
  limitType?: string;
  status?: number;
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

  if (e?.code === 'LIMIT_EXCEEDED' || e?.code === 'PAYROLL_LIMIT_EXCEEDED') {
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
  if (isTransportError(msg)) {
    return t('common.networkError');
  }

  return msg || t('send.backendUnavailable');
}
