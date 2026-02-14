import { Rates } from '../api/client';

// Currency decimals map (minor units). Default to 2 if unknown.
// Includes African currencies and major international currencies
export const currencyDecimals: Record<string, number> = {
  // Major international currencies
  USD: 2,
  EUR: 2,
  CNY: 2,
  CAD: 2, // Canadian Dollar
  BRL: 2, // Brazilian Real
  GBP: 2, // British Pound
  JPY: 0, // Japanese Yen (no decimal places)
  
  // West African currencies
  NGN: 2, // Nigerian Naira
  GHS: 2, // Ghanaian Cedi
  XOF: 0, // West African CFA Franc (no decimal places)
  
  // Central African currencies
  XAF: 2, // Central African CFA Franc
  
  // East African currencies
  KES: 2, // Kenyan Shilling
  TZS: 2, // Tanzanian Shilling
  UGX: 0, // Ugandan Shilling (no decimal places)
  RWF: 0, // Rwandan Franc (no decimal places)
  ETB: 2, // Ethiopian Birr
  
  // Southern African currencies
  ZAR: 2, // South African Rand
  BWP: 2, // Botswana Pula
  ZWL: 2, // Zimbabwean Dollar
  MZN: 2, // Mozambican Metical
  NAD: 2, // Namibian Dollar
  LSL: 2, // Lesotho Loti
  
  // North African currencies
  EGP: 2, // Egyptian Pound
  TND: 3, // Tunisian Dinar
  MAD: 2, // Moroccan Dirham
  LYD: 3, // Libyan Dinar
  DZD: 2, // Algerian Dinar
  
  // Other African currencies
  ERN: 2, // Eritrean Nakfa
  AOA: 2, // Angolan Kwanza
  SOS: 2, // Somali Shilling
  SDG: 2, // Sudanese Pound
  GMD: 2, // Gambian Dalasi
  MUR: 2, // Mauritian Rupee
  SCR: 2, // Seychellois Rupee
};

// Currency symbols map
export const currencySymbols: Record<string, string> = {
  USD: '$',
  EUR: '€',
  CNY: '¥',
  CAD: 'C$',
  BRL: 'R$',
  GBP: '£',
  JPY: '¥',
  NGN: '₦',
  GHS: '₵',
  XOF: 'CFA',
  XAF: 'FCFA',
  KES: 'KSh',
  TZS: 'TSh',
  UGX: 'USh',
  RWF: 'FRw',
  ETB: 'Br',
  ZAR: 'R',
  BWP: 'P',
  ZWL: 'Z$',
  MZN: 'MT',
  NAD: '$',
  LSL: 'L',
  EGP: 'E£',
  TND: 'د.ت',
  MAD: 'د.م',
  LYD: 'ل.د',
  DZD: 'دج',
  ERN: 'Nkf',
  AOA: 'Kz',
  SOS: 'Sh',
  SDG: 'ج.س',
  GMD: 'D',
  MUR: '₨',
  SCR: '₨',
};

export function decimalsFor(currency: string) {
  return currencyDecimals[currency] ?? 2;
}

export function getCurrencySymbol(currency: string): string {
  return currencySymbols[currency] ?? currency;
}

export function minorToMajor(amountMinor: number, currency: string) {
  const d = decimalsFor(currency);
  return amountMinor / Math.pow(10, d);
}

export function majorToMinor(amountMajor: number, currency: string) {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * Math.pow(10, d));
}

// Format an amount expressed in minor units (integer)
export function formatCurrency(amountMinor: number, currency: string, locale = undefined) {
  try {
    const major = minorToMajor(amountMinor, currency);
    return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency }).format(major);
  } catch (e) {
    // fallback
    const major = minorToMajor(amountMinor, currency);
    return `${currency} ${major.toFixed(2)}`;
  }
}

// Convert an amount in minor units from `from` currency to minor units in `to` currency using rates.values[c] = units of c per 1 USD
export function convert(amountMinor: number, from: string, to: string, rates: Rates) {
  const vals = rates.values || {};
  const fromRate = vals[from] ?? 1; // units of FROM per USD
  const toRate = vals[to] ?? 1; // units of TO per USD

  // Convert minor -> major
  const fromMajor = minorToMajor(amountMinor, from);
  // Convert fromMajor to USD: usd = fromMajor / fromRate
  const usd = fromMajor / fromRate;
  // Convert USD to target major: targetMajor = usd * toRate
  const targetMajor = usd * toRate;
  // Convert major to minor for target currency
  return majorToMinor(targetMajor, to);
}
