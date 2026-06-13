type ApiErrorLike = {
  message?: string;
  code?: string;
  limitType?: string;
};

/** Map backend/API errors to localized user-facing messages. */
export function getApiErrorMessage(e: ApiErrorLike, t: (key: string) => string): string {
  const msg = e?.message || '';
  if (/network|fetch|connection|timed out/i.test(msg)) {
    return t('common.networkError');
  }
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
  return msg || t('send.backendUnavailable');
}
