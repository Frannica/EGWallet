'use strict';

/**
 * Lightspark Grid environment validation — Phase 0 (sandbox only).
 *
 * Official docs: same base URL for sandbox and production; credentials select
 * the environment. EGWallet must never accept GRID_ENVIRONMENT=production.
 *
 * Credentials are read from process.env only. This module never logs or
 * returns secret values.
 */

const OFFICIAL_GRID_API_BASE_URL = 'https://api.lightspark.com/grid/2025-10-13';
const ALLOWED_GRID_ENVIRONMENT = 'sandbox';

const GRID_ENV_KEYS = [
  'GRID_CLIENT_ID',
  'GRID_CLIENT_SECRET',
  'GRID_ENVIRONMENT',
  'GRID_API_BASE_URL',
];

/** Sandbox US/UK/EU bank corridors. Kora's eight African countries are never included. */
const DEFAULT_GRID_SANDBOX_COUNTRIES = [
  'US', 'GB', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'AT', 'BE', 'PT', 'FI', 'SE', 'DK', 'LU',
];

const KORA_RESERVED_COUNTRIES = new Set(['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ']);

function readTrimmed(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function anyGridEnvVarSet() {
  return GRID_ENV_KEYS.some((key) => !!readTrimmed(key));
}

/**
 * @param {{ requireConfigured?: boolean }} [options]
 * @returns {{ ok: boolean, configured: boolean, errors: string[] }}
 */
function validateGridEnvironment(options = {}) {
  const requireConfigured = options.requireConfigured === true;
  const clientId = readTrimmed('GRID_CLIENT_ID');
  const clientSecret = readTrimmed('GRID_CLIENT_SECRET');
  const environment = readTrimmed('GRID_ENVIRONMENT');
  const apiBaseUrl = readTrimmed('GRID_API_BASE_URL');

  const anySet = !!(clientId || clientSecret || environment || apiBaseUrl);
  if (!anySet && !requireConfigured) {
    return { ok: true, configured: false, errors: [] };
  }

  const errors = [];

  if (!clientId) errors.push('GRID_CLIENT_ID is missing');
  if (!clientSecret) errors.push('GRID_CLIENT_SECRET is missing');

  if (!environment) {
    errors.push('GRID_ENVIRONMENT is missing');
  } else if (environment !== ALLOWED_GRID_ENVIRONMENT) {
    errors.push('GRID_ENVIRONMENT must be sandbox');
  }

  if (!apiBaseUrl) {
    errors.push('GRID_API_BASE_URL is missing');
  } else if (apiBaseUrl !== OFFICIAL_GRID_API_BASE_URL) {
    errors.push('GRID_API_BASE_URL must be the official Grid 2025-10-13 URL');
  }

  const configured = errors.length === 0;
  return { ok: configured, configured, errors };
}

function isGridSandboxConfigured() {
  const result = validateGridEnvironment({ requireConfigured: true });
  return result.ok && result.configured;
}

/**
 * Boot-time guard. Exits the process on non-sandbox or incomplete Grid config
 * when any GRID_* credential/environment variable is present.
 * Never prints secret values.
 */
function assertGridEnvOrExit() {
  const environment = readTrimmed('GRID_ENVIRONMENT');
  if (environment && environment !== ALLOWED_GRID_ENVIRONMENT) {
    console.error(
      '❌ FATAL: GRID_ENVIRONMENT must be sandbox. Lightspark Grid Production is not enabled.'
    );
    process.exit(1);
  }

  if (!anyGridEnvVarSet()) return;

  const result = validateGridEnvironment({ requireConfigured: true });
  if (!result.ok) {
    console.error(
      '❌ FATAL: Lightspark Grid sandbox configuration is invalid. ' +
      result.errors.join('. ') +
      '.'
    );
    process.exit(1);
  }
}

/**
 * Credentials for outbound Basic Auth only. Caller must not log this object.
 * @returns {{ username: string, password: string, apiBaseUrl: string } | null}
 */
function getGridBasicAuth() {
  if (!isGridSandboxConfigured()) return null;
  return {
    username: readTrimmed('GRID_CLIENT_ID'),
    password: readTrimmed('GRID_CLIENT_SECRET'),
    apiBaseUrl: readTrimmed('GRID_API_BASE_URL'),
  };
}

function getGridSandboxCountries() {
  const raw = readTrimmed('GRID_SANDBOX_COUNTRIES');
  const source = raw
    ? raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_GRID_SANDBOX_COUNTRIES;
  return new Set(source.filter((c) => !KORA_RESERVED_COUNTRIES.has(c)));
}

function isGridSandboxCountry(country) {
  if (!isGridSandboxConfigured()) return false;
  const iso2 = (country || '').trim().toUpperCase();
  if (!iso2 || KORA_RESERVED_COUNTRIES.has(iso2)) return false;
  return getGridSandboxCountries().has(iso2);
}

/**
 * Optional dashboard PEM. Phase 4 webhook verify uses this; it is not required
 * to boot. Never log the returned value.
 */
function getGridWebhookPublicKey() {
  const raw = readTrimmed('GRID_WEBHOOK_PUBLIC_KEY');
  if (!raw) return null;
  return raw.replace(/\\n/g, '\n');
}

function isGridWebhookPublicKeyConfigured() {
  const key = getGridWebhookPublicKey();
  return !!(key && key.includes('BEGIN PUBLIC KEY'));
}

module.exports = {
  OFFICIAL_GRID_API_BASE_URL,
  ALLOWED_GRID_ENVIRONMENT,
  DEFAULT_GRID_SANDBOX_COUNTRIES,
  validateGridEnvironment,
  isGridSandboxConfigured,
  assertGridEnvOrExit,
  anyGridEnvVarSet,
  getGridBasicAuth,
  getGridSandboxCountries,
  isGridSandboxCountry,
  getGridWebhookPublicKey,
  isGridWebhookPublicKeyConfigured,
};
