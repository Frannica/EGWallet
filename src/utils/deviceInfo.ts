import * as Device from 'expo-device';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'secure_device_id';

/**
 * Generate a unique device fingerprint based on device characteristics
 */
export async function getDeviceFingerprint(): Promise<string> {
  try {
    // Try to get stored device ID first
    const storedId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (storedId) {
      return storedId;
    }
  } catch (error) {
    if (__DEV__) console.warn('SecureStore read failed, generating new fingerprint', error);
  }

  // Generate new device ID
  const deviceInfo = {
    brand: Device.brand || 'unknown',
    manufacturer: Device.manufacturer || 'unknown',
    modelId: Device.modelId || 'unknown',
    osName: Device.osName || 'unknown',
    osVersion: Device.osVersion || 'unknown',
    platform: Platform.OS,
    timestamp: Date.now(),
    random: Math.random().toString(36).substring(7),
  };

  // Create a fingerprint string
  const fingerprint = `${deviceInfo.platform}_${deviceInfo.manufacturer}_${deviceInfo.modelId}_${deviceInfo.random}`;
  
  // Try to store for future use (don't fail if this fails)
  try {
    await SecureStore.setItemAsync(DEVICE_ID_KEY, fingerprint);
  } catch (error) {
    if (__DEV__) console.warn('SecureStore write failed, fingerprint not cached', error);
  }
  
  return fingerprint;
}

const PERSISTENT_DEVICE_ID_KEY = 'device_id';

/**
 * Get (or create) a stable UUID for this device installation.
 * Generated ONCE via UUID v4, stored in SecureStore under 'device_id'.
 * This is the canonical identifier used for abuse-protection headers.
 */
export async function getDeviceId(): Promise<string> {
  try {
    const stored = await SecureStore.getItemAsync(PERSISTENT_DEVICE_ID_KEY);
    if (stored) return stored;
  } catch (e) {
    if (__DEV__) console.warn('SecureStore read failed for device_id', e);
  }

  // UUID v4 generation without external dependency
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  try {
    await SecureStore.setItemAsync(PERSISTENT_DEVICE_ID_KEY, id);
  } catch (e) {
    if (__DEV__) console.warn('SecureStore write failed for device_id', e);
  }

  return id;
}

/**
 * Get human-readable device information
 */
export function getDeviceDisplayName(): string {
  const brand = Device.brand || 'Unknown';
  const modelName = Device.modelName || 'Device';
  const osName = Device.osName || Platform.OS;
  const osVersion = Device.osVersion || '';
  
  return `${brand} ${modelName} (${osName} ${osVersion})`;
}

/**
 * Get device type (phone, tablet, desktop, etc.)
 */
export function getDeviceType(): string {
  if (Device.deviceType) {
    switch (Device.deviceType) {
      case Device.DeviceType.PHONE:
        return 'Phone';
      case Device.DeviceType.TABLET:
        return 'Tablet';
      case Device.DeviceType.DESKTOP:
        return 'Desktop';
      case Device.DeviceType.TV:
        return 'TV';
      default:
        return 'Unknown';
    }
  }
  return Platform.OS === 'ios' || Platform.OS === 'android' ? 'Mobile' : 'Unknown';
}
