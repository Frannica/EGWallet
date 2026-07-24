/**
 * Throw-safe display helpers for API-backed fields in render paths.
 * Use these instead of calling string methods directly on optional API values.
 */

export function formatStatusLabel(status?: string | null, fallback = 'unknown'): string {
  return String(status ?? fallback).toUpperCase();
}

export function formatWalletIdShort(id?: string | null, fallback = 'demo'): string {
  const value = String(id ?? fallback);
  return value.length > 12 ? `${value.substring(0, 12)}...` : value;
}

export function formatCurrencyNameSearch(name?: string | null): string {
  return String(name ?? '').toUpperCase();
}

export function formatUserIdShort(userId?: string | null, length = 8): string {
  const value = String(userId ?? '');
  if (!value) return '—';
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
