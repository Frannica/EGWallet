import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BIOMETRIC_ENABLED_KEY = 'egwallet_biometric_enabled';

/**
 * Check if device supports biometric authentication
 */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return compatible && enrolled;
  } catch (e) {
    console.warn('Biometric check failed', e);
    return false;
  }
}

/**
 * Get supported biometric types
 */
export async function getSupportedBiometrics(): Promise<string[]> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return types.map(type => {
      switch (type) {
        case LocalAuthentication.AuthenticationType.FINGERPRINT:
          return 'Fingerprint';
        case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
          return 'Face ID';
        case LocalAuthentication.AuthenticationType.IRIS:
          return 'Iris';
        default:
          return 'Biometric';
      }
    });
  } catch (e) {
    console.warn('Failed to get biometric types', e);
    return [];
  }
}

/**
 * Authenticate user with biometrics
 */
export async function authenticateWithBiometrics(
  promptMessage: string = 'Authenticate to continue'
): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: 'Use Passcode',
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });

    return result.success;
  } catch (e) {
    console.warn('Biometric authentication failed', e);
    return false;
  }
}

/**
 * Check if biometric is enabled by user
 */
export async function isBiometricEnabled(): Promise<boolean> {
  try {
    const enabled = await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY);
    return enabled === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * Enable/disable biometric authentication
 */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (e) {
    console.warn('Failed to save biometric preference', e);
  }
}

/**
 * Require biometric before sensitive actions (send money, view keys, etc.)
 */
export async function requireBiometric(action: string): Promise<boolean> {
  const isEnabled = await isBiometricEnabled();
  if (!isEnabled) return true; // If not enabled, allow action

  const isAvailable = await isBiometricAvailable();
  if (!isAvailable) return true; // If not available, allow action

  return await authenticateWithBiometrics(`Authenticate to ${action}`);
}
