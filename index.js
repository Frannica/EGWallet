import { registerRootComponent } from 'expo';
import * as Sentry from '@sentry/react-native';

import App from './App';

// Initialize Sentry for crash reporting and error tracking
// Only in production builds
if (!__DEV__) {
  Sentry.init({
    dsn: 'https://caf7f778c635edd2bf44516e7ceced97@o4510916303454208.ingest.us.sentry.io/4510916317806592',
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
