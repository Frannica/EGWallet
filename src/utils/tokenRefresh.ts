import * as SecureStore from 'expo-secure-store';
import config from '../config/env';

const TOKEN_KEY = 'egwallet_token';
const REFRESH_TOKEN_KEY = 'egwallet_refresh_token';

// Single shared in-flight promise for token refresh.
//
// Why one promise?
//   Both fetchWithTokenRefresh (interceptor) and AuthContext.tryRefreshToken call
//   refreshAccessToken().  Without deduplication they can both send a rotation
//   request concurrently.  The server's per-user mutex means the second one
//   receives 401 — and the old code then wiped the *winner's* freshly-rotated
//   tokens from SecureStore, logging the user out spuriously.
//
// How it works:
//   The first caller sets _refreshPromise synchronously (before any await), so
//   every concurrent caller that arrives while the refresh is in flight receives
//   the same Promise and waits for the same result.  JavaScript's single-threaded
//   event loop guarantees no other caller can observe _refreshPromise === null
//   between the null-check and the assignment.
let _refreshPromise: Promise<string | null> | null = null;

async function _executeRefresh(): Promise<string | null> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${config.API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      // Re-read SecureStore before clearing.  A concurrent refresh may have already
      // succeeded and stored a new token.  Only wipe if the stored token still matches
      // the one that just failed — prevents a losing race from evicting the winner's
      // rotated tokens and triggering a spurious sign-out.
      const storedNow = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
      if (storedNow === refreshToken) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
      }
      return null;
    }

    const data = await response.json();
    const newToken = data.token;
    if (!newToken) return null;

    await SecureStore.setItemAsync(TOKEN_KEY, newToken);

    // Persist the rotated refresh token — server invalidates the old one on every call.
    // If the server omits it (unexpected), delete the stale token so the next attempt
    // forces re-authentication rather than presenting an already-revoked token.
    if (data.refreshToken) {
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.refreshToken);
    } else {
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    }

    return newToken;
  } catch (error) {
    console.error('Token refresh failed:', error);
    return null;
  }
}

/**
 * Refresh the access token.
 *
 * Deduplicated: concurrent calls share one in-flight fetch so only one
 * rotation request reaches the server per refresh cycle.
 * Safe-clear: tokens are only deleted when the stored refresh token still
 * matches the one that failed, preventing concurrent-race token wipes.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise !== null) {
    // A refresh is already in flight — wait for its result instead of racing.
    return _refreshPromise;
  }

  // Assign synchronously before any await so concurrent callers see a non-null
  // promise immediately and take the deduplication path above.
  _refreshPromise = _executeRefresh().finally(() => {
    _refreshPromise = null;
  });

  return _refreshPromise;
}

/**
 * Fetch wrapper that automatically handles token refresh on 401 errors.
 * Uses the shared refreshAccessToken() — no separate isRefreshing flag needed.
 */
export async function fetchWithTokenRefresh(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);

  // Build a fresh headers object — never mutate the caller's options.
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let response = await fetch(url, { ...options, headers });

  if (
    response.status === 401 &&
    !url.includes('/auth/refresh') &&
    !url.includes('/auth/login')
  ) {
    // refreshAccessToken() is deduplicated — concurrent callers all share the same
    // in-flight promise and settle together, with no subscriber queue needed.
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, { ...options, headers });
    }
    // If refresh failed, return the 401 — AuthContext.handleTokenExpired will
    // call refreshAccessToken() again (no-op if already null), then sign out.
  }

  return response;
}
