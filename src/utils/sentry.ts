/**
 * Sentry Crash Monitoring Configuration
 * Tracks production crashes for quick fixes
 */

import * as Sentry from '@sentry/react-native';
import config from '../config/env';

// Initialize Sentry for crash reporting
export function initializeSentry() {
  try {
    // Only enable in development mode or if DSN is not provided
    if (__DEV__) {
      console.log('Sentry: Disabled in development mode');
      return;
    }

    // Check if DSN is provided - skip initialization if not
    const sentryDsn = process.env.SENTRY_DSN || '';
    if (!sentryDsn || sentryDsn.trim() === '') {
      console.log('⚠️ Sentry: No DSN configured, crash monitoring disabled');
      return;
    }

    Sentry.init({
      dsn: sentryDsn,
      
      // Performance monitoring
      tracesSampleRate: 0.2, // 20% of transactions for performance monitoring
      
      // Capture user context
      beforeSend(event, hint) {
        // Add custom context
        event.contexts = {
          ...event.contexts,
          app: {
            api_url: config.API_BASE_URL,
            environment: __DEV__ ? 'development' : 'production'
          }
        };
        
        return event;
      },
      
      // Enable automatic session tracking
      enableAutoSessionTracking: true,
      
      // Session timeout (in seconds)
      sessionTrackingIntervalMillis: 30000,
      
      // Enable Sentry in production
      enabled: true,
    });

    console.log('✅ Sentry initialized for crash monitoring');
  } catch (error) {
    // Never crash the app due to Sentry initialization failure
    console.error('⚠️ Sentry initialization failed:', error);
    console.log('App will continue without crash monitoring');
  }
}

// Manually capture exceptions
export function logError(error: Error, context?: Record<string, any>) {
  console.error('Error logged:', error);
  
  if (!__DEV__) {
    try {
      Sentry.captureException(error, {
        contexts: context ? { custom: context } : undefined
      });
    } catch (sentryError) {
      // Sentry not initialized or failed - don't crash
      console.warn('Failed to log to Sentry:', sentryError);
    }
  }
}

// Capture messages
export function logMessage(message: string, level: 'info' | 'warning' | 'error' = 'info') {
  console.log(`[${level.toUpperCase()}] ${message}`);
  
  if (!__DEV__) {
    try {
      Sentry.captureMessage(message, level);
    } catch (sentryError) {
      console.warn('Failed to log to Sentry:', sentryError);
    }
  }
}

// Set user context
export function setUserContext(userId: string, email?: string) {
  if (!__DEV__) {
    try {
      Sentry.setUser({ id: userId, email });
    } catch (sentryError) {
      console.warn('Failed to set Sentry user context:', sentryError);
    }
  }
}

// Clear user context on logout
export function clearUserContext() {
  if (!__DEV__) {
    try {
      Sentry.setUser(null);
    } catch (sentryError) {
      console.warn('Failed to clear Sentry user context:', sentryError);
    }
  }
}
