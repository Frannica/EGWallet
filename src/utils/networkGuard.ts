/**
 * Network Guard - Safe API Call Wrapper
 * Prevents app crashes from network errors in financial transactions
 */

export interface NetworkGuardConfig {
  timeout?: number;
  retries?: number;
  onError?: (error: Error) => void;
}

/**
 * Wraps any async API call with error handling
 * Returns null on failure instead of throwing
 */
export async function safeApiCall<T>(
  apiCall: () => Promise<T>,
  config?: NetworkGuardConfig
): Promise<T | null> {
  const { timeout = 30000, retries = 0, onError } = config || {};

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), timeout)
      );

      // Race between API call and timeout
      const result = await Promise.race([apiCall(), timeoutPromise]);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`API call failed (attempt ${attempt + 1}/${retries + 1}):`, lastError.message);

      // Don't retry on last attempt
      if (attempt < retries) {
        // Exponential backoff: 1s, 2s, 4s...
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All attempts failed
  if (onError && lastError) {
    onError(lastError);
  }

  console.error('API call failed after all retries:', lastError);
  return null;
}

/**
 * Check if device has network connectivity
 */
export async function isNetworkAvailable(): Promise<boolean> {
  try {
    // Try a lightweight HEAD request to a reliable endpoint
    const response = await fetch('https://www.google.com', {
      method: 'HEAD',
      mode: 'no-cors',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry wrapper with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i);
        console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
