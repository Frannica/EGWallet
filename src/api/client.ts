import config from '../config/env';

export const API_BASE = config.API_BASE_URL;

export type Rates = {
  base: string;
  values: Record<string, number>;
  updatedAt: number;
};

export async function fetchRates(): Promise<Rates> {
  const res = await fetch(`${API_BASE}/rates`);
  if (!res.ok) throw new Error('Failed to fetch rates');
  return res.json();
}
