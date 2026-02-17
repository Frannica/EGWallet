import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { login as apiLogin, register as apiRegister, me as apiMe, listWallets } from '../api/auth';

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
          const profile = await apiMe(t);
          setUser(profile);
        }
      } catch (e) {
        if (__DEV__) console.warn('Restore token failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function signIn(email: string, password: string) {
    const res = await apiLogin(email, password);
    const t = res.token;
    await SecureStore.setItemAsync(TOKEN_KEY, t);
    setToken(t);
    const profile = await apiMe(t);
    setUser(profile);
  }

  async function signUp(email: string, password: string, region?: string) {
    const res = await apiRegister(email, password, region);
    const t = res.token;
    await SecureStore.setItemAsync(TOKEN_KEY, t);
    setToken(t);
    const profile = await apiMe(t);
    setUser(profile);
  }

  async function signOut() {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
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
