import { Platform, Linking } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../api/client';
import { getDeviceId } from '../utils/deviceInfo';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';

const LOCAL_PUSH_OPT_OUT_KEY = '@egwallet:push_opt_out';
const LAST_REGISTERED_TOKEN_KEY = 'egwallet_expo_push_token';

export type PushStage =
  | 'permission'
  | 'token_generation'
  | 'register'
  | 'storage'
  | 'delivery'
  | 'auth'
  | 'opt_out'
  | 'network';

export type PushResult = {
  ok: boolean;
  reason?: string;
  stage?: PushStage;
  /** Safe detail for UI — never includes tokens or secrets */
  detail?: string;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function projectId(): string | undefined {
  return (
    Constants.easConfig?.projectId
    || Constants.expoConfig?.extra?.eas?.projectId
    || (Constants as any).easConfig?.projectId
  );
}

export async function isPushOptedOutLocally(): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(LOCAL_PUSH_OPT_OUT_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

export async function setLocalPushOptOut(optOut: boolean): Promise<void> {
  try {
    if (optOut) await SecureStore.setItemAsync(LOCAL_PUSH_OPT_OUT_KEY, '1');
    else await SecureStore.deleteItemAsync(LOCAL_PUSH_OPT_OUT_KEY);
  } catch {
    // non-critical
  }
}

export async function openAndroidNotificationSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // ignore
  }
}

export async function getNotificationPermissionStatus(): Promise<string> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status;
  } catch {
    return 'unknown';
  }
}

/**
 * Obtain an Expo push token with a precise stage/reason (no secrets).
 */
export async function getExpoPushTokenDetailed(): Promise<PushResult & { token?: string }> {
  if (!Device.isDevice) {
    return {
      ok: false,
      stage: 'permission',
      reason: 'not_physical_device',
      detail: 'Push requires a physical device.',
    };
  }

  let permStatus = 'undetermined';
  try {
    const existing = await Notifications.getPermissionsAsync();
    permStatus = existing.status;
    if (existing.status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      permStatus = requested.status;
    }
  } catch (e: any) {
    return {
      ok: false,
      stage: 'permission',
      reason: 'permission_check_failed',
      detail: String(e?.message || 'permission_check_failed').slice(0, 120),
    };
  }

  if (permStatus !== 'granted') {
    return {
      ok: false,
      stage: 'permission',
      reason: 'permission_denied',
      detail: `Notification permission is ${permStatus}.`,
    };
  }

  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    } catch {
      // non-fatal
    }
  }

  const pid = projectId();
  if (!pid) {
    return {
      ok: false,
      stage: 'token_generation',
      reason: 'missing_project_id',
      detail: 'EAS projectId is missing from the app config.',
    };
  }

  try {
    const tokenRes = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    const token = tokenRes?.data;
    if (token && typeof token === 'string') {
      return { ok: true, token };
    }
    return {
      ok: false,
      stage: 'token_generation',
      reason: 'token_empty',
      detail: 'Expo returned an empty push token.',
    };
  } catch (e: any) {
    return {
      ok: false,
      stage: 'token_generation',
      reason: 'token_generation_failed',
      detail: String(e?.message || 'getExpoPushTokenAsync failed').slice(0, 160),
    };
  }
}

export async function getExpoPushTokenSafe(): Promise<string | null> {
  const r = await getExpoPushTokenDetailed();
  return r.ok && r.token ? r.token : null;
}

async function registerOnce(accessTokenHint?: string | null): Promise<PushResult> {
  if (await isPushOptedOutLocally()) {
    return { ok: false, stage: 'opt_out', reason: 'opt_out', detail: 'Push is turned off.' };
  }

  const tokenResult = await getExpoPushTokenDetailed();
  if (!tokenResult.ok || !tokenResult.token) {
    return {
      ok: false,
      stage: tokenResult.stage || 'token_generation',
      reason: tokenResult.reason || 'no_device_token',
      detail: tokenResult.detail,
    };
  }

  const deviceId = await getDeviceId();
  const appVersion =
    Constants.expoConfig?.version
    || Constants.nativeAppVersion
    || undefined;

  try {
    // Prefer SecureStore + auto-refresh — do not rely on a possibly stale React auth.token.
    const res = await fetchWithTokenRefresh(`${API_BASE}/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessTokenHint ? { Authorization: `Bearer ${accessTokenHint}` } : {}),
      },
      body: JSON.stringify({
        token: tokenResult.token,
        deviceId,
        platform: Platform.OS,
        appVersion,
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        stage: 'auth',
        reason: 'auth_expired',
        detail: 'Session expired. Sign out and sign in again, then retry.',
      };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        ok: false,
        stage: 'register',
        reason: body.errorCode || `http_${res.status}`,
        detail: String(body.error || `Register failed (${res.status})`).slice(0, 160),
      };
    }
    try {
      await SecureStore.setItemAsync(LAST_REGISTERED_TOKEN_KEY, tokenResult.token);
    } catch {
      // ignore local cache write
    }
    return { ok: true, stage: 'storage', reason: 'registered' };
  } catch (e: any) {
    return {
      ok: false,
      stage: 'network',
      reason: 'network',
      detail: String(e?.message || 'network').slice(0, 160),
    };
  }
}

/**
 * Register with automatic retries (used when Push is turned ON and before test send).
 */
export async function registerPushTokenWithBackend(
  accessToken?: string | null,
  opts?: { retries?: number }
): Promise<PushResult> {
  const retries = Math.max(0, opts?.retries ?? 2);
  let last: PushResult = { ok: false, reason: 'unknown' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await registerOnce(accessToken);
    if (last.ok) return last;
    // Do not spin on hard permission / opt-out failures
    if (
      last.reason === 'permission_denied'
      || last.reason === 'opt_out'
      || last.reason === 'not_physical_device'
      || last.reason === 'missing_project_id'
    ) {
      return last;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return last;
}

export async function unregisterPushTokenFromBackend(_accessToken?: string | null): Promise<void> {
  const deviceId = await getDeviceId().catch(() => null);
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(LAST_REGISTERED_TOKEN_KEY);
  } catch {
    token = null;
  }

  try {
    await fetchWithTokenRefresh(`${API_BASE}/push/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, token }),
    });
  } catch {
    // best-effort
  }

  try {
    await SecureStore.deleteItemAsync(LAST_REGISTERED_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function setPushPreferenceOnBackend(
  _accessToken: string | null | undefined,
  pushEnabled: boolean
): Promise<boolean> {
  try {
    const res = await fetchWithTokenRefresh(`${API_BASE}/push/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushEnabled }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fire-and-forget registration after login / session restore. */
export function schedulePushRegistration(accessToken?: string | null): void {
  setTimeout(() => {
    registerPushTokenWithBackend(accessToken, { retries: 2 }).catch(() => {});
  }, 0);
}

/**
 * Controlled self-test via authenticated session + token refresh.
 * Fails with a precise stage if registration did not succeed.
 */
export async function sendTestPushNotification(accessToken?: string | null): Promise<PushResult> {
  if (await isPushOptedOutLocally()) {
    return { ok: false, stage: 'opt_out', reason: 'opt_out', detail: 'Push is turned off.' };
  }

  const reg = await registerPushTokenWithBackend(accessToken, { retries: 2 });
  if (!reg.ok) return reg;

  try {
    const res = await fetchWithTokenRefresh(`${API_BASE}/push/test-self`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'SEND_TEST_PUSH_TO_ME' }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        stage: 'auth',
        reason: 'auth_expired',
        detail: 'Session expired. Sign out and sign in again, then retry.',
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        stage: 'delivery',
        reason: body.errorCode || `http_${res.status}`,
        detail: String(body.error || `Test push failed (${res.status})`).slice(0, 160),
      };
    }
    if (typeof body.tokenCount === 'number' && body.tokenCount < 1) {
      return {
        ok: false,
        stage: 'storage',
        reason: 'NO_PUSH_TOKENS',
        detail: 'Server has no enabled push token for this account.',
      };
    }
    return {
      ok: true,
      stage: 'delivery',
      reason: 'queued',
      detail: body.tokenCount != null ? `Queued to ${body.tokenCount} device(s).` : 'Queued.',
    };
  } catch (e: any) {
    return {
      ok: false,
      stage: 'network',
      reason: 'network',
      detail: String(e?.message || 'network').slice(0, 160),
    };
  }
}
