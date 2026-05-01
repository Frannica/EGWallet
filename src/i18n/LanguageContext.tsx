import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import { setApiLanguage } from '../api/client';
import {
  SupportedLanguage,
  translations,
  deviceLocaleToLanguage,
  RTL_LANGUAGES,
  LANGUAGE_NAMES,
} from './translations';

const STORAGE_KEY = '@egwallet:language';

interface LanguageContextType {
  /** Currently active language code */
  language: SupportedLanguage;
  /** Whether the active language is RTL (Arabic) */
  isRTL: boolean;
  /** Translate a key into the current language. Falls back to English, then the key itself. */
  t: (key: string) => string;
  /** Manually set the language. Persists to AsyncStorage and prevents future auto-override. */
  setLanguage: (lang: SupportedLanguage) => Promise<void>;
  /** Whether the language has been manually chosen by the user */
  isManuallySet: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

/**
 * Reads the device locale and returns the best supported language.
 * Uses expo-localization, which reads the system locale — NOT the IP address.
 */
function detectDeviceLanguage(): SupportedLanguage {
  try {
    const locales = Localization.getLocales();
    if (!locales || locales.length === 0) return 'en';
    // languageCode is the BCP-47 primary language subtag (e.g. 'fr', 'ja', 'zh', 'pt')
    const primary = locales[0].languageCode;
    return deviceLocaleToLanguage(primary);
  } catch {
    return 'en';
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>('en');
  const [isManuallySet, setIsManuallySet] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored) {
          // User has made a manual choice — honour it, never override automatically
          setLanguageState(stored as SupportedLanguage);
          setApiLanguage(stored);
          setIsManuallySet(true);
        } else {
          // No manual choice — auto-detect from device locale
          const detected = detectDeviceLanguage();
          setLanguageState(detected);
          setApiLanguage(detected);
          setIsManuallySet(false);
        }
      } catch {
        const fallback = detectDeviceLanguage();
        setLanguageState(fallback);
        setApiLanguage(fallback);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setLanguage = useCallback(async (lang: SupportedLanguage) => {
    setLanguageState(lang);
    setApiLanguage(lang);
    setIsManuallySet(true);
    await AsyncStorage.setItem(STORAGE_KEY, lang);
  }, []);

  const t = useCallback(
    (key: string): string => {
      return (
        translations[language]?.[key] ??
        translations['en']?.[key] ??
        key
      );
    },
    [language],
  );

  const isRTL = RTL_LANGUAGES.includes(language);

  // Block render until language is resolved to avoid flash of wrong language
  if (!ready) return null;

  return (
    <LanguageContext.Provider value={{ language, isRTL, t, setLanguage, isManuallySet }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextType {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider');
  return ctx;
}

export { LANGUAGE_NAMES, SupportedLanguage };
