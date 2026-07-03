import { decimalsFor, formatCurrency, majorToMinor } from './currency';

/** Minimum deposit in major units: $1 / €1 or 100 FCFA-style units. */
export function minDepositMajor(currency: string): number {
  return decimalsFor(currency) === 0 ? 100 : 1;
}

export function minDepositMinor(currency: string): number {
  return majorToMinor(minDepositMajor(currency), currency);
}

export function formatMinDepositLabel(currency: string): string {
  return formatCurrency(minDepositMinor(currency), currency);
}
