import { registerRootComponent } from 'expo';
import * as Sentry from '@sentry/react-native';
import { LogBox } from 'react-native';

import App from './App';

// Ignore specific warnings that don't affect functionality
LogBox.ignoreLogs([
  'Non-serializable values were found in the navigation state',
]);

// Initialize Sentry for crash reporting and error tracking
// Enable in ALL modes to capture crashes during testing
try {
  Sentry.init({
    dsn: 'https://caf7f778c635edd2bf44516e7ceced97@o4510916303454208.ingest.us.sentry.io/4510916317806592',
    enableInExpoDevelopment: true,
    debug: __DEV__, // Debug logging in dev mode
    tracesSampleRate: __DEV__ ? 1.0 : 0.2, // 100% in dev, 20% in prod
    environment: __DEV__ ? 'development' : 'production',
    beforeSend(event, hint) {
      // Filter out sensitive data
      if (event.request?.headers) {
        delete event.request.headers.Authorization;
      }
      return event;
    },
  });
  console.log('✅ Sentry initialized successfully');
} catch (error) {
  console.error('❌ Sentry initialization failed:', error);
}

// Wrap app in Sentry error boundary
const AppWithSentry = __DEV__ ? App : Sentry.wrap(App);

// Global error handler for unhandled promises
const previousHandler = global.ErrorUtils?.getGlobalHandler?.();
global.ErrorUtils?.setGlobalHandler((error, isFatal) => {
  console.error('Global error caught:', error);
  Sentry.captureException(error);
  if (previousHandler) {
    previousHandler(error, isFatal);
  }
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(AppWithSentry);
