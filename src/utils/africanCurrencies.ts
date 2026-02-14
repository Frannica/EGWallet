/**
 * African Currencies Data
 * Contains comprehensive information about supported African currencies
 */

export interface AfricanCurrency {
  country: string;
  currency: string;
  code: string;
  symbol: string;
}

const currencies: AfricanCurrency[] = [
  {
    country: "Tunisia",
    currency: "Tunisian Dinar",
    code: "TND",
    symbol: "د.ت"
  },
  {
    country: "Libya",
    currency: "Libyan Dinar",
    code: "LYD",
    symbol: "ل.د"
  },
  {
    country: "Morocco",
    currency: "Moroccan Dirham",
    code: "MAD",
    symbol: "د.م"
  },
  {
    country: "Botswana",
    currency: "Botswana Pula",
    code: "BWP",
    symbol: "P"
  },
  {
    country: "Seychelles",
    currency: "Seychellois Rupee",
    code: "SCR",
    symbol: "₨"
  },
  {
    country: "Eritrea",
    currency: "Eritrean Nakfa",
    code: "ERN",
    symbol: "Nkf"
  },
  {
    country: "South Africa",
    currency: "South African Rand",
    code: "ZAR",
    symbol: "R"
  },
  {
    country: "Namibia",
    currency: "Namibian Dollar",
    code: "NAD",
    symbol: "$"
  },
  {
    country: "Lesotho",
    currency: "Lesotho Loti",
    code: "LSL",
    symbol: "L"
  },
  {
    country: "Ghana",
    currency: "Ghanaian Cedi",
    code: "GHS",
    symbol: "₵"
  },
  {
    country: "Egypt",
    currency: "Egyptian Pound",
    code: "EGP",
    symbol: "E£"
  },
  {
    country: "Algeria",
    currency: "Algerian Dinar",
    code: "DZD",
    symbol: "دج"
  },
  {
    country: "Angola",
    currency: "Angolan Kwanza",
    code: "AOA",
    symbol: "Kz"
  },
  {
    country: "Ethiopia",
    currency: "Ethiopian Birr",
    code: "ETB",
    symbol: "Br"
  },
  {
    country: "Kenya",
    currency: "Kenyan Shilling",
    code: "KES",
    symbol: "KSh"
  },
  {
    country: "Tanzania",
    currency: "Tanzanian Shilling",
    code: "TZS",
    symbol: "TSh"
  },
  {
    country: "Mozambique",
    currency: "Mozambican Metical",
    code: "MZN",
    symbol: "MT"
  },
  {
    country: "Nigeria",
    currency: "Nigerian Naira",
    code: "NGN",
    symbol: "₦"
  },
  {
    country: "Mauritius",
    currency: "Mauritian Rupee",
    code: "MUR",
    symbol: "₨"
  },
  {
    country: "Sudan",
    currency: "Sudanese Pound",
    code: "SDG",
    symbol: "ج.س"
  },
  {
    country: "Somalia",
    currency: "Somali Shilling",
    code: "SOS",
    symbol: "Sh"
  },
  {
    country: "Gambia",
    currency: "Gambian Dalasi",
    code: "GMD",
    symbol: "D"
  },
  {
    country: "Zimbabwe",
    currency: "Zimbabwean Dollar",
    code: "ZWL",
    symbol: "Z$"
  }
];

/**
 * Get all supported currencies
 * @returns Array of currency objects
 */
export function getAllCurrencies(): AfricanCurrency[] {
  return currencies;
}

/**
 * Get currency by code
 * @param code ISO currency code (e.g., 'USD', 'NGN')
 * @returns Currency object or null if not found
 */
export function getCurrencyByCode(code: string): AfricanCurrency | null {
  if (!code) return null;
  const upperCode = code.toUpperCase();
  return currencies.find(curr => curr.code === upperCode) || null;
}

/**
 * Check if currency code is valid
 * @param code ISO currency code
 * @returns True if currency is supported
 */
export function isValidCurrency(code: string): boolean {
  if (!code) return false;
  const upperCode = code.toUpperCase();
  return currencies.some(curr => curr.code === upperCode);
}

/**
 * Get all currency codes
 * @returns Array of currency codes
 */
export function getAllCurrencyCodes(): string[] {
  return currencies.map(curr => curr.code);
}

/**
 * Search currencies by country name
 * @param countryName Country name to search
 * @returns Array of matching currencies
 */
export function searchByCountry(countryName: string): AfricanCurrency[] {
  if (!countryName) return [];
  const searchTerm = countryName.toLowerCase();
  return currencies.filter(curr => 
    curr.country.toLowerCase().includes(searchTerm)
  );
}

/**
 * Get currency symbol by code
 * @param code ISO currency code
 * @returns Currency symbol or empty string if not found
 */
export function getCurrencySymbol(code: string): string {
  const currency = getCurrencyByCode(code);
  return currency?.symbol || '';
}

/**
 * Get currency name by code
 * @param code ISO currency code
 * @returns Full currency name or empty string if not found
 */
export function getCurrencyName(code: string): string {
  const currency = getCurrencyByCode(code);
  return currency?.currency || '';
}
