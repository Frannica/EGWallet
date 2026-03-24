type SafeApiCallOptions = {
  timeout?: number;
  retries?: number;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function safeApiCall<T>(
  fn: () => Promise<T>,
  options: SafeApiCallOptions = {}
): Promise<T> {
  const timeoutMs = options.timeout ?? 10000;
  const retries = options.retries ?? 0;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }

  // Re-throw the real error so callers get the actual message (wrong password,
  // network failure, etc.) rather than a generic null check fallback.
  throw lastError;
}
