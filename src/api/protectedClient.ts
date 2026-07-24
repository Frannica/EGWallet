/**
 * Protected API Client with comprehensive crash prevention
 * - Offline detection
 * - Timeout handling
 * - Idempotency keys
 * - Automatic retries
 * - Error recovery
 */

import NetInfo from '@react-native-community/netinfo';
import { Alert } from 'react-native';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';
import { logError } from '../utils/apiErrorHandler';

type ProtectedApiOptions = {
  timeout?: number;
  retries?: number;
  idempotencyKey?: string;
  skipOfflineCheck?: boolean;
};

type ApiError = {
  message: string;
  isNetworkError: boolean;
  isTimeout: boolean;
  isOffline: boolean;
  statusCode?: number;
};

/**
 * Check if device is online
 */
async function checkOnlineStatus(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable !== false;
  } catch (error) {
    // If NetInfo fails, assume offline to be safe
    if (__DEV__) console.warn('NetInfo check failed:', error);
    return false;
  }
}

/**
 * Protected API call with comprehensive error handling
 */
export async function protectedApiCall<T>(
  url: string,
  options: RequestInit = {},
  protectionOptions: ProtectedApiOptions = {}
): Promise<{ data: T | null; error: ApiError | null }> {
  const {
    retries = 1,
    idempotencyKey,
    skipOfflineCheck = false,
  } = protectionOptions;

  // Step 1: Check if online (unless explicitly skipped)
  if (!skipOfflineCheck) {
    const isOnline = await checkOnlineStatus();
    if (!isOnline) {
      return {
        data: null,
        error: {
          message: 'No internet connection. Check your connection and try again.',
          isNetworkError: true,
          isTimeout: false,
          isOffline: true,
        },
      };
    }
  }

  // Step 2: Add idempotency key to headers if provided
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };

  // Step 3: Attempt request with retries
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTokenRefresh(url, { ...options, headers });

      // Step 4: Handle response
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        lastError = {
          message: errorData.error || `Request failed with status ${response.status}`,
          isNetworkError: false,
          isTimeout: false,
          isOffline: false,
          statusCode: response.status,
        };

        // Don't retry 4xx errors (client errors)
        if (response.status >= 400 && response.status < 500) {
          break;
        }

        // Retry 5xx errors
        continue;
      }

      // Success!
      const data = await response.json();
      return { data, error: null };
    } catch (error: any) {
      // Network or timeout error
      const isTimeout = error.message?.includes('timed out') || error.message?.includes('timeout');
      
      lastError = {
        message: isTimeout
          ? 'The request is taking longer than expected. Please try again.'
          : 'Network request failed',
        isNetworkError: true,
        isTimeout,
        isOffline: false,
      };

      // Wait before retry (exponential backoff)
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  // All retries exhausted — report to crash reporting (Sentry in production)
  // before surfacing the error to the caller, so backend/network failures are
  // actually visible in production monitoring instead of only ever reaching
  // a user-facing Alert. Offline errors are excluded (expected, user-side
  // connectivity state, not an app/backend defect worth alerting on).
  if (lastError && !lastError.isOffline) {
    logError(`protectedApiCall:${url}`, {
      type: lastError.isTimeout ? 'timeout' : lastError.isNetworkError ? 'network' : (lastError.statusCode && lastError.statusCode >= 500) ? 'server' : 'unknown',
      message: lastError.message,
      statusCode: lastError.statusCode,
      retryable: lastError.isNetworkError || lastError.isTimeout || (lastError.statusCode ?? 0) >= 500,
      originalError: lastError,
    });
  }

  return { data: null, error: lastError };
}

/**
 * Generate unique idempotency key
 */
export function generateIdempotencyKey(prefix: string = ''): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${prefix}${timestamp}-${random}`;
}

/**
 * Show user-friendly error alert
 */
export function showErrorAlert(error: ApiError, onRetry?: () => void) {
  const buttons = onRetry
    ? [
        { text: 'Cancel', style: 'cancel' as const },
        { text: 'Retry', onPress: onRetry },
      ]
    : [{ text: 'OK' }];

  Alert.alert(
    error.isOffline ? 'No Connection' : error.isTimeout ? 'Request Timeout' : 'Error',
    error.message,
    buttons
  );
}

