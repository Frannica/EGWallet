import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';
import { useLanguage } from '../i18n/LanguageContext';
import { login as apiLogin, register as apiRegister, me as apiMe, listWallets } from '../api/auth';
import { API_BASE } from '../api/client';
import { getDeviceFingerprint, getDeviceDisplayName, getDeviceType } from '../utils/deviceInfo';
import { clearLocalUserData } from '../utils/localBalance';
import { refreshAccessToken } from '../utils/tokenRefresh';
import { detectCountryCode, autoDetectRegion } from '../config/regional';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  schedulePushRegistration,
  unregisterPushTokenFromBackend,
} from '../notifications/pushRegistration';

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
  user: { id: string; email: string; username?: string | null; preferredCurrency?: string; autoConvertIncoming?: boolean; region?: string } | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, region?: string) => Promise<void>;
  signOut: () => Promise<void>;
  handleTokenExpired: () => Promise<boolean>;
  updatePreferredCurrency: (currency: string) => Promise<void>;
  updateAutoConvert: (enabled: boolean) => Promise<void>;
  updateUsername: (username: string) => void;
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
  const { t: tl } = useLanguage();
  const [user, setUser] = useState<{ id: string; email: string; username?: string | null; preferredCurrency?: string; autoConvertIncoming?: boolean; region?: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Try to use the stored refresh token to get a new access token.
  // Delegates to the shared refreshAccessToken() from tokenRefresh.ts so that
  // concurrent calls from here and fetchWithTokenRefresh share one in-flight
  // promise — preventing the race where the loser wipes the winner's new tokens.
  async function tryRefreshToken(): Promise<boolean> {
    try {
      const newToken = await refreshAccessToken();
      if (!newToken) return false;
      setToken(newToken);
      try {
        const profile = await apiMe(newToken);
        setUser(profile);
        schedulePushRegistration(newToken);
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
            schedulePushRegistration(t);
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
  async function handleTokenExpired(): Promise<boolean> {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return true;
    }
    // Keep the user signed in on transient network failures. If refresh token
    // still exists locally, the token is not conclusively invalid yet.
    const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY).catch(() => null);
    if (refreshToken) return true;
    await signOut();
    return false;
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
          tl('auth.newDeviceTitle'),
          tl('auth.newDeviceMsg').replace('{{device}}', res.deviceName || tl('auth.thisDeviceFallback')),
          [
            { text: tl('auth.trustDevice'), style: 'default' },
            { text: tl('auth.reviewSecurity'), style: 'cancel', onPress: () => {
              Alert.alert(tl('auth.securityTipsTitle'), tl('auth.securityTipsMsg'));
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
        schedulePushRegistration(t);
      } catch (profileError) {
        // Token saved but profile fetch failed - still allow login
        if (__DEV__) console.warn('Profile fetch failed after login', profileError);
        setUser({ id: res.userId || 'unknown', email });
        schedulePushRegistration(t);
      }
    } catch (error: any) {
      // Clear any partial state
      setToken(null);
      setUser(null);
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
        schedulePushRegistration(t);
      } catch (profileError) {
        // Token saved but profile fetch failed - still allow signup
        if (__DEV__) console.warn('Profile fetch failed after signup', profileError);
        setUser({ id: res.userId || 'unknown', email });
        schedulePushRegistration(t);
      }
    } catch (error: any) {
      // Clear any partial state
      setToken(null);
      setUser(null);
      throw error;
    }
  }

  async function signOut() {
    // Unregister push for this device before clearing credentials.
    try {
      await unregisterPushTokenFromBackend(token);
    } catch (e) {
      if (__DEV__) console.warn('Push unregister failed:', e);
    }

    // Revoke refresh token on backend.
    // Send the refresh token even when the access token is expired — the server
    // verifies the refresh JWT itself and does not require an Authorization header.
    try {
      const rt = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
      if (rt) {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
      }
    } catch (e) {
      if (__DEV__) console.warn('Logout revoke failed:', e);
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
      if (__DEV__) console.warn('updatePreferredCurrency backend call failed:', e);
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
      if (__DEV__) console.warn('updateAutoConvert backend call failed:', e);
    }
    if (user) setUser({ ...user, autoConvertIncoming: enabled });
  }

  function updateUsername(username: string) {
    if (user) setUser({ ...user, username });
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, signIn, signUp, signOut, handleTokenExpired, updatePreferredCurrency, updateAutoConvert, updateUsername }}>
      {children}
    </AuthContext.Provider>
  );
};

