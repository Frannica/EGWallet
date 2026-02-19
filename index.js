import { registerRootComponent } from 'expo';
import * as Sentry from '@sentry/react-native';

import App from './App';

// Initialize Sentry for crash reporting and error tracking
// Only in production builds
if (!__DEV__) {
  Sentry.init({
    dsn: 'https://your-sentry-dsn@sentry.io/your-project-id', // TODO: Replace with actual Sentry DSN
    enableInExpoDevelopment: false,
    debug: false,
    tracesSampleRate: 0.2, // 20% of transactions for performance monitoring
    environment: __DEV__ ? 'development' : 'production',
    beforeSend(event, hint) {
      // Don't send events in development
      if (__DEV__) return null;
      // Filter out sensitive data
      if (event.request?.headers) {
        delete event.request.headers.Authorization;
      }
      return event;
    },
  });
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
