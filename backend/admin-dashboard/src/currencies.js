import currencyData from '../../egwallet-currencies.json';

export const CURRENCY_INFO = currencyData;

export const POPULAR_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CNY', 'JPY', 'INR', 'NGN', 'GHS', 'XAF', 'XOF',
  'ZAR', 'KES', 'BRL', 'CAD', 'AUD', 'AED', 'MAD',
];

function sortCurrencyCodes(codes) {
  return [...codes].sort((a, b) => {
    const ai = POPULAR_CURRENCIES.indexOf(a);
    const bi = POPULAR_CURRENCIES.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

export const SUPPORTED_CURRENCY_CODES = sortCurrencyCodes(Object.keys(CURRENCY_INFO));

export function getCurrencyName(code) {
  return CURRENCY_INFO[code]?.name || code;
}

export function isSupportedCurrency(code) {
  return !!CURRENCY_INFO[code];
}

export function normalizeWalletBalances(balances = []) {
  const byCode = {};
  for (const entry of balances || []) {
    if (entry?.currency && isSupportedCurrency(entry.currency)) {
      byCode[entry.currency] = entry.amount ?? 0;
    }
  }
  return SUPPORTED_CURRENCY_CODES.map((currency) => ({
    currency,
    name: getCurrencyName(currency),
    amount: byCode[currency] ?? 0,
  }));
}

export function currencyFilterOptions(allLabel = 'All') {
  return [
    { value: '', label: allLabel },
    ...SUPPORTED_CURRENCY_CODES.map((code) => ({
      value: code,
      label: `${code} — ${getCurrencyName(code)}`,
    })),
  ];
}
