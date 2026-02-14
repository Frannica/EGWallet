// Backend URL configuration
// Use environment variables or a config file to switch between dev and production

const ENV = {
  dev: {
    API_BASE_URL: 'http://localhost:4000',
    LOG_LEVEL: 'debug',
  },
  production: {
    API_BASE_URL: 'https://eg-wallet-backend-production.up.railway.app',
    LOG_LEVEL: 'error',
  },
};

// Determine environment based on __DEV__ (Expo's built-in flag)
const config = __DEV__ ? ENV.dev : ENV.production;

export default config;

