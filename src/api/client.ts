import config from '../config/env';

export const API_BASE = config.API_BASE_URL;

export type Rates = {
  base: string;
  values: Record<string, number>;
  updatedAt: number;
};

// Fallback rates used when the backend is unreachable (offline / demo mode).
// Keeps the wallet UI functional with reasonable approximate values.
export const DEMO_RATES: Rates = {
  base: 'USD',
  values: {
    USD: 1, EUR: 0.93, GBP: 0.79, CAD: 1.35, AUD: 1.55,
    XAF: 600, XOF: 600, NGN: 1540, GHS: 12, ZAR: 19,
    KES: 130, TZS: 2650, UGX: 3800, RWF: 1300, ETB: 52,
    INR: 83, CNY: 7, JPY: 145, BRL: 5.2, MXN: 17,
    EGP: 50, MAD: 10, TND: 3.1, DZD: 135,
  },
  updatedAt: 0,
};

export async function fetchRates(): Promise<Rates> {
  const res = await fetch(`${API_BASE}/rates`);
  if (!res.ok) throw new Error('Failed to fetch rates');
  return res.json();
}
