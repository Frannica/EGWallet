import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';
import { login as apiLogin, register as apiRegister, me as apiMe, listWallets } from '../api/auth';
import { API_BASE } from '../api/client';
import { getDeviceFingerprint, getDeviceDisplayName, getDeviceType } from '../utils/deviceInfo';
import { clearLocalUserData } from '../utils/localBalance';
import { detectCountryCode, autoDetectRegion } from '../config/regional';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CURRENCY_DETECTED_KEY = '@egwallet:currency_detected';
const LANGUAGE_STORAGE_KEY = '@egwallet:language';

async function syncLanguageToBackend(token: string) {
  try {
    const lang = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (!lang) return;
    await fetch(`${API_BASE}/user/language`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ language: lang }),
    });
  } catch {
    // Non-critical
  }
}

type AuthState = {
  user: { id: string; email: string; preferredCurrency?: string; autoConvertIncoming?: boolean; region?: string } | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, region?: string) => Promise<void>;
  signOut: () => Promise<void>;
  handleTokenExpired: () => Promise<void>;
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
  const [user, setUser] = useState<{ id: string; email: string; preferredCurrency?: string; autoConvertIncoming?: boolean; region?: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Try to use the stored refresh token to get a new access token.
  // Returns true if successful (sets token + user state), false otherwise.
  async function tryRefreshToken(): Promise<boolean> {
    try {
      const rt = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
      if (!rt) return false;
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      const newToken = data.token;
      if (!newToken) return false;
      await SecureStore.setItemAsync(TOKEN_KEY, newToken);
      setToken(newToken);
      try {
        const profile = await apiMe(newToken);
        setUser(profile);
      } catch {
        // Profile unavailable but token is valid — not critical
      }
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const t = await SecureStore.getItemAsync(TOKEN_KEY);
        if (t) {
          setToken(t);
          try {
            const profile = await apiMe(t);
            setUser(profile);
            syncLanguageToBackend(t);
          } catch (apiError) {
            // Access token invalid — try refresh token before signing out
            if (__DEV__) console.warn('Token restore failed, trying refresh...', apiError);
            const refreshed = await tryRefreshToken();
            if (!refreshed) {
              // Both tokens invalid — clear everything, user must log in
              await SecureStore.deleteItemAsync(TOKEN_KEY);
              await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
              setToken(null);
              setUser(null);
            }
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

  // Called by screens when a 401 "Invalid token" is received.
  // Tries to silently refresh; if that fails, signs the user out so the
  // login screen is shown automatically by AppNavigator.
  async function handleTokenExpired() {
    const refreshed = await tryRefreshToken();
    if (!refreshed) {
      await signOut();
    }
  }

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
      await clearLocalUserData();
      setToken(t);
      
      try {
        const profile = await apiMe(t);
        // If the user has no preferredCurrency stored (old account), infer from device locale.
        // Guard: only persist to backend once per device via AsyncStorage flag.
        if (!profile.preferredCurrency) {
          const alreadyDetected = await AsyncStorage.getItem(CURRENCY_DETECTED_KEY).catch(() => null);
          const code = detectCountryCode();
          const FALLBACK: Record<string, string> = {
            GQ: 'XAF', CM: 'XAF', CF: 'XAF', TD: 'XAF', CG: 'XAF', GA: 'XAF',
            SN: 'XOF', CI: 'XOF', ML: 'XOF', BF: 'XOF', BJ: 'XOF', NE: 'XOF', TG: 'XOF', GW: 'XOF',
            NG: 'NGN', GH: 'GHS', ZA: 'ZAR', KE: 'KES', TZ: 'TZS', ET: 'ETB',
            EG: 'EGP', MA: 'MAD', DZ: 'DZD', TN: 'TND',
            BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', MX: 'MXN', PE: 'PEN',
            CN: 'CNY', JP: 'JPY', KR: 'KRW', IN: 'INR', ID: 'IDR', PH: 'PHP',
            SG: 'SGD', MY: 'MYR', TH: 'THB', VN: 'VND', PK: 'PKR',
            AU: 'AUD', NZ: 'NZD', CA: 'CAD',
            GB: 'GBP', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK',
            SA: 'SAR', AE: 'AED', QA: 'QAR', KW: 'KWD',
            RU: 'RUB', TR: 'TRY', UA: 'UAH',
          };
          const detected = code ? (FALLBACK[code] ?? 'USD') : 'USD';
          profile.preferredCurrency = detected;
          // Persist to backend only once (first time no currency is found)
          if (!alreadyDetected) {
            try {
              await fetch(`${API_BASE}/auth/update-currency`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
                body: JSON.stringify({ preferredCurrency: detected }),
              });
              await AsyncStorage.setItem(CURRENCY_DETECTED_KEY, '1');
            } catch {
              // Non-critical — currency is still set locally
            }
          }
        }
        setUser(profile);
        syncLanguageToBackend(t);
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

      // Auto-detect region from device locale if caller didn't supply one
      const effectiveRegion = region ?? (() => {
        try { return autoDetectRegion(); } catch { return undefined; }
      })();
      // Mark detection as done so the signIn path skips the one-time persist
      AsyncStorage.setItem(CURRENCY_DETECTED_KEY, '1').catch(() => {});

      const res = await apiRegister(email, password, effectiveRegion, deviceInfo);
      const t = res.token;
      const rt = res.refreshToken;
      await SecureStore.setItemAsync(TOKEN_KEY, t);
      if (rt) await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, rt);
      await clearLocalUserData();
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
        await fetch(`${API_BASE}/auth/logout`, {
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
    await clearLocalUserData();
    setToken(null);
    setUser(null);
  }

  async function updatePreferredCurrency(currency: string) {
    if (!token) return;
    try {
      await fetch(`${API_BASE}/auth/update-currency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ preferredCurrency: currency }),
      });
    } catch (e) {
      console.warn('updatePreferredCurrency backend call failed:', e);
    }
    if (user) setUser({ ...user, preferredCurrency: currency });
  }

  async function updateAutoConvert(enabled: boolean) {
    if (!token) return;
    try {
      await fetch(`${API_BASE}/auth/update-auto-convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ autoConvertIncoming: enabled }),
      });
    } catch (e) {
      console.warn('updateAutoConvert backend call failed:', e);
    }
    if (user) setUser({ ...user, autoConvertIncoming: enabled });
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, signIn, signUp, signOut, handleTokenExpired, updatePreferredCurrency, updateAutoConvert }}>
      {children}
    </AuthContext.Provider>
  );
};
