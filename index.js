import { registerRootComponent } from 'expo';
import * as Sentry from '@sentry/react-native';
import { LogBox } from 'react-native';

// CRITICAL: Initialize Sentry BEFORE importing App
// This ensures crashes during module imports are captured
try {
  Sentry.init({
    dsn: 'https://caf7f778c635edd2bf44516e7ceced97@o4510916303454208.ingest.us.sentry.io/4510916317806592',
    enableInExpoDevelopment: true,
    debug: __DEV__, // Debug logging in dev mode
    tracesSampleRate: __DEV__ ? 1.0 : 0.2, // 100% in dev, 20% in prod
    environment: __DEV__ ? 'development' : 'production',
    integrations: [], // DISABLE all auto-integrations to prevent FeedbackWidgetProvider
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

// Ignore specific warnings that don't affect functionality
LogBox.ignoreLogs([
  'Non-serializable values were found in the navigation state',
]);

// Use require() instead of import to load App AFTER Sentry initializes
// Wrap in try-catch to capture any import/module errors
let App;
try {
  console.log('📦 Loading App module...');
  App = require('./App').default;
  console.log('✅ App module loaded successfully');
} catch (error) {
  console.error('❌ Failed to load App module:', error);
  Sentry.captureException(error);
  
  // Fallback error screen
  const React = require('react');
  const { View, Text } = require('react-native');
  App = () => (
    React.createElement(View, { style: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 } },
      React.createElement(Text, { style: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 } }, 'App Failed to Load'),
      React.createElement(Text, { style: { textAlign: 'center' } }, error.message || 'Unknown error')
    )
  );
}

// Global error handler for unhandled promises
const previousHandler = global.ErrorUtils?.getGlobalHandler?.();
global.ErrorUtils?.setGlobalHandler((error, isFatal) => {
  console.error('Global error caught:', error);
  Sentry.captureException(error);
  if (previousHandler) {
    previousHandler(error, isFatal);
  }
});

// Register app directly without Sentry.wrap() - no FeedbackWidgetProvider
registerRootComponent(App);
