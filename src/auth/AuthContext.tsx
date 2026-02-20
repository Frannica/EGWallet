import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';
import { login as apiLogin, register as apiRegister, me as apiMe, listWallets } from '../api/auth';
import { getDeviceFingerprint, getDeviceDisplayName, getDeviceType } from '../utils/deviceInfo';

type AuthState = {
  user: { id: string; email: string; preferredCurrency?: string; autoConvertIncoming?: boolean } | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, region?: string) => Promise<void>;
  signOut: () => Promise<void>;
  updatePreferredCurrency: (currency: string) => Promise<void>;
  updateAutoConvert: (enabled: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

const TOKEN_KEY = 'egwallet_token';
const REFRESH_TOKEN_KEY = 'egwallet_refresh_token';

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<{ id: string; email: string; preferredCurrency?: string; autoConvertIncoming?: boolean } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const t = await SecureStore.getItemAsync(TOKEN_KEY);
        if (t) {
          setToken(t);
          try {
            const profile = await apiMe(t);
            setUser(profile);
          } catch (apiError) {
            // API call failed - clear invalid token
            if (__DEV__) console.warn('API call failed during restore, clearing token', apiError);
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
            setToken(null);
            setUser(null);
          }
        }
      } catch (e) {
        // SecureStore failed - continue without crash
        if (__DEV__) console.warn('Restore token failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function signIn(email: string, password: string) {
    try {
      // Gather device information with fallback
      let deviceInfo;
      try {
        deviceInfo = {
          fingerprint: await getDeviceFingerprint(),
          name: getDeviceDisplayName(),
          type: getDeviceType(),
        };
      } catch (deviceError) {
        // Fallback if device info fails
        if (__DEV__) console.warn('Device info failed, using fallback', deviceError);
        deviceInfo = {
          fingerprint: 'unknown_' + Date.now(),
          name: 'Unknown Device',
          type: 'Mobile',
        };
      }
      
      const res = await apiLogin(email, password, deviceInfo);
      
      // Check if this is a new device
      if (res.newDevice) {
        Alert.alert(
          'New Device Detected',
          `This is the first time you're signing in from "${res.deviceName || 'this device'}". If this wasn't you, please change your password immediately.`,
          [
            { text: 'I Trust This Device', style: 'default' },
            { text: 'Review Security', style: 'cancel', onPress: () => {
              Alert.alert('Security Tips', 'Go to Settings > Privacy & Security to review your trusted devices and enable biometric authentication.');
            }}
          ]
        );
      }
      
      const t = res.token;
      const rt = res.refreshToken;
      await SecureStore.setItemAsync(TOKEN_KEY, t);
      if (rt) await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, rt);
      setToken(t);
      
      try {
        const profile = await apiMe(t);
        setUser(profile);
      } catch (profileError) {
        // Token saved but profile fetch failed - still allow login
        if (__DEV__) console.warn('Profile fetch failed after login', profileError);
        setUser({ id: res.userId || 'unknown', email });
      }
    } catch (error: any) {
      // Clear any partial state
      setToken(null);
      setUser(null);
      
      // Re-throw with better error message
      if (error.message?.includes('connection') || error.message?.includes('network')) {
        throw new Error('Network error. Please check your internet connection.');
      }
      throw error;
    }
  }

  async function signUp(email: string, password: string, region?: string) {
    try {
      // Gather device information with fallback
      let deviceInfo;
      try {
        deviceInfo = {
          fingerprint: await getDeviceFingerprint(),
          name: getDeviceDisplayName(),
          type: getDeviceType(),
        };
      } catch (deviceError) {
        // Fallback if device info fails
        if (__DEV__) console.warn('Device info failed, using fallback', deviceError);
        deviceInfo = {
          fingerprint: 'unknown_' + Date.now(),
          name: 'Unknown Device',
          type: 'Mobile',
        };
      }
    
    const res = await apiRegister(email, password, region, deviceInfo);
    const t = res.token;
    const rt = res.refreshToken;
    await SecureStore.setItemAsync(TOKEN_KEY, t);
    if (rt) await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, rt);
    setToken(t);
    
    try {
      const profile = await apiMe(t);
      setUser(profile);
    } catch (profileError) {
      // Token saved but profile fetch failed - still allow signup
      if (__DEV__) console.warn('Profile fetch failed after signup', profileError);
      setUser({ id: res.userId || 'unknown', email });
    }
  } catch (error: any) {
    // Clear any partial state
    setToken(null);
    setUser(null);
    
    // Re-throw with better error message
    if (error.message?.includes('connection') || error.message?.includes('network')) {
      throw new Error('Network error. Please check your internet connection.');
    }
    throw error;
  }
}

  async function signOut() {
    // Revoke refresh token on backend
    try {
      const rt = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
      if (rt && token) {
        await fetch(`${require('../config/env').default.API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ refreshToken: rt }),
        });
      }
    } catch (e) {
      console.warn('Logout revoke failed:', e);
    }
    
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    setToken(null);
    setUser(null);
  }

  async function updatePreferredCurrency(currency: string) {
    // Stub for future backend integration
    if (user) {
      setUser({ ...user, preferredCurrency: currency });
    }
  }

  async function updateAutoConvert(enabled: boolean) {
    // Stub for future backend integration
    if (user) {
      setUser({ ...user, autoConvertIncoming: enabled });
    }
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, signIn, signUp, signOut, updatePreferredCurrency, updateAutoConvert }}>
      {children}
    </AuthContext.Provider>
  );
};
