import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_KEY = 'egwallet_stripe_publishable_key';

export function isValidStripePublishableKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && /^pk_(test|live)_/.test(key);
}

export async function readCachedStripePublishableKey(): Promise<string | null> {
  try {
    const cached = await AsyncStorage.getItem(CACHE_KEY);
    return isValidStripePublishableKey(cached) ? cached : null;
  } catch {
    return null;
  }
}

export async function cacheStripePublishableKey(key: string | null | undefined): Promise<void> {
  if (!isValidStripePublishableKey(key)) return;
  try {
    await AsyncStorage.setItem(CACHE_KEY, key);
  } catch {
    // non-fatal
  }
}
