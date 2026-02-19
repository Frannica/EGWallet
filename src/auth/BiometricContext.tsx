import React, { createContext, useContext, useState, useEffect } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';

type BiometricState = {
  isLocked: boolean;
  biometricEnabled: boolean;
  biometricAvailable: boolean;
  biometricType: string | null;
  unlock: () => Promise<boolean>;
  enableBiometric: () => Promise<void>;
  disableBiometric: () => Promise<void>;
};

const BiometricContext = createContext<BiometricState | undefined>(undefined);

const BIOMETRIC_ENABLED_KEY = 'egwallet_biometric_enabled';

export function useBiometric() {
  const ctx = useContext(BiometricContext);
  if (!ctx) throw new Error('useBiometric must be used within BiometricProvider');
  return ctx;
}

export const BiometricProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isLocked, setIsLocked] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<string | null>(null);

  useEffect(() => {
    // Wrap in try-catch to prevent crashes
    (async () => {
      try {
        await checkBiometricAvailability();
        await loadBiometricSettings();
      } catch (error) {
        console.warn('BiometricProvider initialization failed:', error);
        // Continue without biometric - don't crash the app
        setBiometricAvailable(false);
        setBiometricEnabled(false);
        setIsLocked(false);
      }
    })();
    
    // Lock app when it goes to background
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      try {
        if (nextAppState === 'background' && biometricEnabled) {
          setIsLocked(true);
        }
      } catch (error) {
        console.warn('AppState listener error:', error);
      }
    });

    return () => {
      try {
        subscription.remove();
      } catch (error) {
        console.warn('Failed to remove AppState listener:', error);
      }
    };
  }, [biometricEnabled]);

  async function checkBiometricAvailability() {
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      const available = compatible && enrolled;
      
      setBiometricAvailable(available);
      
      if (available) {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType('fingerprint');
        } else if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType('face');
        } else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
          setBiometricType('iris');
        } else {
          setBiometricType('biometric');
        }
      }
    } catch (e) {
      console.warn('Biometric check failed:', e);
      setBiometricAvailable(false);
    }
  }

  async function loadBiometricSettings() {
    try {
      const enabled = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
      const isEnabled = enabled === 'true';
      setBiometricEnabled(isEnabled);
      
      // Lock immediately if biometric is enabled
      if (isEnabled) {
        setIsLocked(true);
      }
    } catch (e) {
      console.warn('Failed to load biometric settings:', e);
    }
  }

  async function unlock(): Promise<boolean> {
    if (!biometricEnabled || !biometricAvailable) {
      setIsLocked(false);
      return true;
    }

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock EGWallet',
        fallbackLabel: 'Use Passcode',
        disableDeviceFallback: false,
        cancelLabel: 'Cancel',
      });

      if (result.success) {
        setIsLocked(false);
        return true;
      } else {
        return false;
      }
    } catch (e) {
      console.error('Biometric auth failed:', e);
      return false;
    }
  }

  async function enableBiometric() {
    if (!biometricAvailable) {
      throw new Error('Biometric authentication not available on this device');
    }

    // Test biometric first
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Enable Biometric Lock',
      fallbackLabel: 'Use Passcode',
      disableDeviceFallback: false,
    });

    if (result.success) {
      await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true');
      setBiometricEnabled(true);
      setIsLocked(false); // Already authenticated
    } else {
      throw new Error('Biometric authentication failed');
    }
  }

  async function disableBiometric() {
    await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
    setBiometricEnabled(false);
    setIsLocked(false);
  }

  return (
    <BiometricContext.Provider
      value={{
        isLocked,
        biometricEnabled,
        biometricAvailable,
        biometricType,
        unlock,
        enableBiometric,
        disableBiometric,
      }}
    >
      {children}
    </BiometricContext.Provider>
  );
};
