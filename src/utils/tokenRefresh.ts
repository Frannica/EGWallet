import * as SecureStore from 'expo-secure-store';
import config from '../config/env';

const TOKEN_KEY = 'egwallet_token';
const REFRESH_TOKEN_KEY = 'egwallet_refresh_token';

let isRefreshing = false;
let refreshSubscribers: ((token: string) => void)[] = [];

function onRefreshed(token: string) {
  refreshSubscribers.forEach(callback => callback(token));
  refreshSubscribers = [];
}

function addRefreshSubscriber(callback: (token: string) => void) {
  refreshSubscribers.push(callback);
}

export async function refreshAccessToken(): Promise<string | null> {
  try {
    const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${config.API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      // Refresh token is invalid/expired, clear everything
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
      throw new Error('Refresh token expired');
    }

    const data = await response.json();
    const newToken = data.token;

    await SecureStore.setItemAsync(TOKEN_KEY, newToken);
    return newToken;
  } catch (error) {
    console.error('Token refresh failed:', error);
    return null;
  }
}

/**
 * Fetch wrapper that automatically handles token refresh on 401 errors
 */
export async function fetchWithTokenRefresh(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  
  // Add auth header if we have a token
  if (token && !options.headers) {
    options.headers = {};
  }
  if (token) {
    (options.headers as any)['Authorization'] = `Bearer ${token}`;
  }

  let response = await fetch(url, options);

  // If we get a 401 and it's not the refresh endpoint, try to refresh
  if (response.status === 401 && !url.includes('/auth/refresh') && !url.includes('/auth/login')) {
    if (!isRefreshing) {
      isRefreshing = true;
      
      const newToken = await refreshAccessToken();
      isRefreshing = false;

      if (newToken) {
        onRefreshed(newToken);
        
        // Retry original request with new token
        (options.headers as any)['Authorization'] = `Bearer ${newToken}`;
        response = await fetch(url, options);
      } else {
        // Refresh failed, user needs to log in again
        // This will be handled by the app's auth flow
      }
    } else {
      // Wait for the current refresh to complete
      const newToken = await new Promise<string>((resolve) => {
        addRefreshSubscriber((token: string) => {
          resolve(token);
        });
      });

      // Retry with the new token
      (options.headers as any)['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, options);
    }
  }

  return response;
}
