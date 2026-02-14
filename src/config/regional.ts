/**
 * Regional Configuration System
 * Handles auto-detection and manual override of region, language, and timezone
 * Optimized for Equatorial Guinea (GQ) as primary region
 */

import * as Localization from 'expo-localization';

export type Region = 'GQ' | 'AF' | 'EU' | 'OTHER';
export type Language = 'es' | 'fr' | 'en';

interface RegionalConfig {
  region: Region;
  language: Language;
  timezone: string;
  currency: string;
  locale: string;
  kyc_required: boolean;
  daily_limit_usd: number;
}

const REGION_CONFIGS: Record<Region, RegionalConfig> = {
  GQ: {
    region: 'GQ',
    language: 'es',
    timezone: 'Africa/Malabo',
    currency: 'XAF',
    locale: 'es_GQ',
    kyc_required: true,
    daily_limit_usd: 5000,
  },
  AF: {
    region: 'AF',
    language: 'en',
    timezone: 'Africa/Lagos', // Example: Nigeria
    currency: 'NGN',
    locale: 'en_NG',
    kyc_required: true,
    daily_limit_usd: 5000,
  },
  EU: {
    region: 'EU',
    language: 'en',
    timezone: 'Europe/London',
    currency: 'EUR',
    locale: 'en_GB',
    kyc_required: false,
    daily_limit_usd: 10000,
  },
  OTHER: {
    region: 'OTHER',
    language: 'en',
    timezone: 'UTC',
    currency: 'USD',
    locale: 'en_US',
    kyc_required: true,
    daily_limit_usd: 5000,
  },
};

/**
 * Auto-detect user's region based on device locale
 */
export function autoDetectRegion(): Region {
  const locales = Localization.getLocales();
  
  if (!locales || locales.length === 0) {
    return 'GQ'; // Default to Equatorial Guinea
  }

  const primaryLocale = locales[0];
  const countryCode = primaryLocale.regionCode?.toUpperCase();

  // Equatorial Guinea
  if (countryCode === 'GQ') return 'GQ';

  // African regions
  if (
    countryCode === 'NG' || countryCode === 'GH' || countryCode === 'ZA' ||
    countryCode === 'KE' || countryCode === 'TZ' || countryCode === 'ET' ||
    countryCode === 'EG' || countryCode === 'MA' || countryCode === 'UG' ||
    countryCode === 'RW' || countryCode === 'BW' || countryCode === 'MZ' ||
    countryCode === 'ZM' || countryCode === 'ZW' || countryCode === 'MU' ||
    countryCode === 'SC' || countryCode === 'SN' || countryCode === 'CI' ||
    countryCode === 'CM' || countryCode === 'CD' || countryCode === 'AO' ||
    countryCode === 'CV' || countryCode === 'GM' || countryCode === 'GN' ||
    countryCode === 'LR' || countryCode === 'MW' || countryCode === 'ML' ||
    countryCode === 'NE' || countryCode === 'SD' || countryCode === 'SO' ||
    countryCode === 'TG' || countryCode === 'TN' || countryCode === 'LY'
  ) {
    return 'AF';
  }

  // Europe
  if (
    countryCode?.match(/^(GB|DE|FR|IT|ES|NL|BE|AT|CH|SE|NO|DK|FI|PL|RO|CZ|HU)$/)
  ) {
    return 'EU';
  }

  return 'OTHER';
}

/**
 * Get regional configuration
 */
export function getRegionalConfig(region: Region): RegionalConfig {
  return REGION_CONFIGS[region];
}

/**
 * Get supported languages for a region
 */
export function getSupportedLanguages(region: Region): Language[] {
  if (region === 'GQ') return ['es', 'fr', 'en'];
  if (region === 'AF') return ['en', 'fr', 'es'];
  return ['en', 'es', 'fr'];
}

/**
 * Translations object - supports ES, FR, EN
 */
export const TRANSLATIONS: Record<Language, Record<string, string>> = {
  es: {
    // Spanish (Español) - Equatorial Guinea
    app_name: 'EGWallet',
    wallet: 'Cartera',
    send: 'Enviar',
    receive: 'Recibir',
    request: 'Solicitar',
    card: 'Tarjeta',
    budget: 'Presupuesto',
    settings: 'Configuración',
    sign_in: 'Iniciar sesión',
    sign_up: 'Registrarse',
    sign_out: 'Cerrar sesión',
    delete_account: 'Eliminar cuenta',
    about: 'Acerca de',
    privacy_policy: 'Política de privacidad',
    terms_of_service: 'Términos de servicio',
    support: 'Soporte',
    offline_error: 'Sin conexión a internet. Verifica tu conexión e intenta de nuevo.',
    timeout_error: 'La solicitud tardó demasiado. Por favor intenta de nuevo.',
    network_error: 'Error de red. Intenta de nuevo.',
    kyc_required: 'Verificación de identidad requerida',
    daily_limit: 'Límite diario: $5,000 USD',
    wallet_capacity: 'Capacidad máxima: $250,000 USD',
    loading: 'Cargando...',
    retry: 'Reintentar',
    cancel: 'Cancelar',
    ok: 'Aceptar',
  },
  fr: {
    // French (Français)
    app_name: 'EGWallet',
    wallet: 'Portefeuille',
    send: 'Envoyer',
    receive: 'Recevoir',
    request: 'Demander',
    card: 'Carte',
    budget: 'Budget',
    settings: 'Paramètres',
    sign_in: 'Se connecter',
    sign_up: "S'inscrire",
    sign_out: 'Déconnexion',
    delete_account: 'Supprimer le compte',
    about: 'À propos',
    privacy_policy: 'Politique de confidentialité',
    terms_of_service: 'Conditions d\'utilisation',
    support: 'Support',
    offline_error: 'Pas de connexion Internet. Vérifiez votre connexion et réessayez.',
    timeout_error: 'La demande a pris trop de temps. Veuillez réessayer.',
    network_error: 'Erreur réseau. Veuillez réessayer.',
    kyc_required: 'Vérification d\'identité requise',
    daily_limit: 'Limite quotidienne : 5 000 $ USD',
    wallet_capacity: 'Capacité maximale : 250 000 $ USD',
    loading: 'Chargement...',
    retry: 'Réessayer',
    cancel: 'Annuler',
    ok: 'OK',
  },
  en: {
    // English
    app_name: 'EGWallet',
    wallet: 'Wallet',
    send: 'Send',
    receive: 'Receive',
    request: 'Request',
    card: 'Card',
    budget: 'Budget',
    settings: 'Settings',
    sign_in: 'Sign In',
    sign_up: 'Sign Up',
    sign_out: 'Sign Out',
    delete_account: 'Delete Account',
    about: 'About',
    privacy_policy: 'Privacy Policy',
    terms_of_service: 'Terms of Service',
    support: 'Support',
    offline_error: 'No internet connection. Check your connection and try again.',
    timeout_error: 'Request timed out. Please try again.',
    network_error: 'Network error. Please try again.',
    kyc_required: 'Identity verification required',
    daily_limit: 'Daily limit: $5,000 USD',
    wallet_capacity: 'Max capacity: $250,000 USD',
    loading: 'Loading...',
    retry: 'Retry',
    cancel: 'Cancel',
    ok: 'OK',
  },
};

/**
 * Translate a key based on language
 */
export function t(key: keyof typeof TRANSLATIONS.en, language: Language = 'en'): string {
  return TRANSLATIONS[language]?.[key] || TRANSLATIONS.en[key] || key;
}

/**
 * Get current timezone
 */
export function getCurrentTimezone(): string {
  return Localization.getCalendars()?.[0]?.timeZone || 'UTC';
}

/**
 * Format date/time in user's timezone
 */
export function formatLocalDateTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-GQ', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch (e) {
    return date.toLocaleString();
  }
}
