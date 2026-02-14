/**
 * Centralized API Error Handling
 * Manages network timeouts, retries, and user-friendly error messages
 */

export type ApiErrorType = 'network' | 'timeout' | 'auth' | 'validation' | 'server' | 'unknown';

export interface ApiError {
  type: ApiErrorType;
  message: string;
  statusCode?: number;
  originalError?: any;
  retryable: boolean;
}

const API_TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;

/**
 * Classify error and provide user-friendly message
 */
export function classifyError(error: any): ApiError {
  // Network errors
  if (error?.message?.includes('Network') || error?.message?.includes('fetch')) {
    return {
      type: 'network',
      message: 'No internet connection. Please check your connection and try again.',
      retryable: true,
      originalError: error,
    };
  }

  // Timeout errors
  if (error?.message?.includes('Timeout') || error?.code === 'ETIMEDOUT') {
    return {
      type: 'timeout',
      message: 'Request timed out. Please check your connection and try again.',
      retryable: true,
      originalError: error,
    };
  }

  // Auth errors (401, 403)
  if (error?.statusCode === 401 || error?.statusCode === 403) {
    return {
      type: 'auth',
      message: 'Your session has expired. Please sign in again.',
      statusCode: error.statusCode,
      retryable: false,
      originalError: error,
    };
  }

  // Validation errors (400)
  if (error?.statusCode === 400) {
    return {
      type: 'validation',
      message: error?.message || 'Invalid request. Please check your input.',
      statusCode: 400,
      retryable: false,
      originalError: error,
    };
  }

  // Server errors (5xx)
  if (error?.statusCode && error.statusCode >= 500) {
    return {
      type: 'server',
      message: 'Server error. Please try again later.',
      statusCode: error.statusCode,
      retryable: true,
      originalError: error,
    };
  }

  // Generic error
  return {
    type: 'unknown',
    message: 'An unexpected error occurred. Please try again.',
    retryable: true,
    originalError: error,
  };
}

/**
 * Fetch with timeout and error handling
 */
export async function fetchWithTimeout(
  url: string,
  options?: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle non-ok responses
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const error: any = new Error(errorBody.error || `HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }

    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);

    // Handle abort (timeout)
    if (error.name === 'AbortError') {
      const timeoutError: any = new Error('Request timeout');
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }

    throw error;
  }
}

/**
 * Retry wrapper for failed requests
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  delay: number = 1000
): Promise<T> {
  let lastError: any;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const apiError = classifyError(error);

      if (!apiError.retryable || i === maxRetries - 1) {
        throw error;
      }

      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }

  throw lastError;
}

/**
 * Log error for debugging/crash reporting
 */
export function logError(context: string, error: ApiError) {
  if (__DEV__) {
    console.error(`[${context}] ${error.type}: ${error.message}`, error.originalError);
  }
  
  // TODO: Send to crash reporting service (Sentry, Firebase Crashlytics, etc.)
  // Example:
  // Sentry.captureException(error.originalError, { extra: { context, apiError: error } });
}
