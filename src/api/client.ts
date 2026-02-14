import config from '../config/env';
import { safeApiCall } from '../utils/networkGuard';

export const API_BASE = config.API_BASE_URL;

export type Rates = {
  base: string;
  values: Record<string, number>;
  updatedAt: number;
};

export async function fetchRates(): Promise<Rates | null> {
  return safeApiCall(async () => {
    const res = await fetch(`${API_BASE}/rates`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) throw new Error('Failed to fetch rates');
    return res.json();
  }, {
    timeout: 10000,
    retries: 2,
    onError: (error) => console.error('Fetch rates failed:', error)
  });
}
