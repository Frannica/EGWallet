// Backend URL configuration
// Automatically selects the correct URL for emulator, simulator, or physical device.

import Constants from 'expo-constants';

const PRODUCTION_API_URL = 'https://egwalletsimple-production.up.railway.app';
const BACKEND_PORT = 4000;

/**
 * Resolves the correct API base URL for the current runtime environment.
 *
 * - Physical device / Expo Go: uses the dev machine's LAN IP surfaced by Expo
 * - Android emulator fallback: 10.0.2.2 (routes to host loopback)
 * - iOS simulator fallback: localhost
 * - Production: Railway deployment
 */
function getBaseUrl(): string {
  if (!__DEV__) {
    return PRODUCTION_API_URL;
  }

  // Expo surfaces the bundler host as "192.168.x.x:8081" (or similar).
  // Stripping the port gives us the developer machine's LAN IP, which works
  // for both physical devices and simulators/emulators on the same network.
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':').shift();
    return `http://${host}:${BACKEND_PORT}`;
  }

  // Fallback when hostUri is unavailable (e.g., bare workflow without a dev server).
  // Android emulator maps 10.0.2.2 → host loopback; iOS simulator uses localhost.
  const { Platform } = require('react-native') as typeof import('react-native');
  return Platform.OS === 'android'
    ? `http://10.0.2.2:${BACKEND_PORT}`
    : `http://localhost:${BACKEND_PORT}`;
}

const config = {
  API_BASE_URL: getBaseUrl(),
  LOG_LEVEL: __DEV__ ? 'debug' : 'error',
};

if (__DEV__) {
  console.log('🌐 API_BASE_URL =', config.API_BASE_URL);
}

export default config;

