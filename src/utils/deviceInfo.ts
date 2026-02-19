import * as Device from 'expo-device';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'secure_device_id';

/**
 * Generate a unique device fingerprint based on device characteristics
 */
export async function getDeviceFingerprint(): Promise<string> {
  // Try to get stored device ID first
  const storedId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (storedId) {
    return storedId;
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
  
  // Store for future use
  await SecureStore.setItemAsync(DEVICE_ID_KEY, fingerprint);
  
  return fingerprint;
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
