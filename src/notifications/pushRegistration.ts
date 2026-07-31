import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../api/client';
import { getDeviceId } from '../utils/deviceInfo';

const LOCAL_PUSH_OPT_OUT_KEY = '@egwallet:push_opt_out';
const LAST_REGISTERED_TOKEN_KEY = 'egwallet_expo_push_token';

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

export async function getExpoPushTokenSafe(): Promise<string | null> {
  if (!Device.isDevice) {
    if (__DEV__) console.warn('[push] Physical device required for Expo push token');
    return null;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const pid = projectId();
  if (!pid) {
    if (__DEV__) console.warn('[push] Missing EAS projectId');
    return null;
  }

  try {
    const tokenRes = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    const token = tokenRes?.data;
    if (token && typeof token === 'string') return token;
  } catch (e) {
    if (__DEV__) console.warn('[push] getExpoPushTokenAsync failed', e);
  }
  return null;
}

export async function registerPushTokenWithBackend(accessToken: string): Promise<{ ok: boolean; reason?: string }> {
  if (!accessToken) return { ok: false, reason: 'no_auth' };
  if (await isPushOptedOutLocally()) return { ok: false, reason: 'opt_out' };

  const expoToken = await getExpoPushTokenSafe();
  if (!expoToken) return { ok: false, reason: 'no_device_token' };

  const deviceId = await getDeviceId();
  const appVersion =
    Constants.expoConfig?.version
    || Constants.nativeAppVersion
    || undefined;

  try {
    const res = await fetch(`${API_BASE}/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        token: expoToken,
        deviceId,
        platform: Platform.OS,
        appVersion,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, reason: body.errorCode || `http_${res.status}` };
    }
    try {
      await SecureStore.setItemAsync(LAST_REGISTERED_TOKEN_KEY, expoToken);
    } catch {
      // ignore
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network' };
  }
}

export async function unregisterPushTokenFromBackend(accessToken: string | null): Promise<void> {
  const deviceId = await getDeviceId().catch(() => null);
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(LAST_REGISTERED_TOKEN_KEY);
  } catch {
    token = null;
  }

  if (accessToken) {
    try {
      await fetch(`${API_BASE}/push/unregister`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ deviceId, token }),
      });
    } catch {
      // best-effort
    }
  }

  try {
    await SecureStore.deleteItemAsync(LAST_REGISTERED_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function setPushPreferenceOnBackend(accessToken: string, pushEnabled: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/push/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pushEnabled }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fire-and-forget registration after login / session restore. */
export function schedulePushRegistration(accessToken: string): void {
  setTimeout(() => {
    registerPushTokenWithBackend(accessToken).catch(() => {});
  }, 0);
}

/**
 * Controlled self-test via authenticated session.
 * Calls POST /push/test-self — does not move money.
 */
export async function sendTestPushNotification(accessToken: string): Promise<{ ok: boolean; reason?: string }> {
  if (!accessToken) return { ok: false, reason: 'no_auth' };
  // Ensure this device token is registered before asking the server to push.
  const reg = await registerPushTokenWithBackend(accessToken);
  if (!reg.ok && reg.reason !== 'opt_out') {
    // Still attempt test-self — server may have another registered device.
  }
  if (await isPushOptedOutLocally()) {
    return { ok: false, reason: 'opt_out' };
  }
  try {
    const res = await fetch(`${API_BASE}/push/test-self`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ confirm: 'SEND_TEST_PUSH_TO_ME' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: body.errorCode || body.error || `http_${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network' };
  }
}
