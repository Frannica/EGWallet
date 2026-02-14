import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const NOTIFICATION_ENABLED_KEY = 'egwallet_notifications_enabled';

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Request notification permissions
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('Notification permission denied');
      return false;
    }

    // For Android, create notification channel
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'EGWallet Transactions',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#007AFF',
        sound: 'default',
      });
    }

    return true;
  } catch (e) {
    console.warn('Failed to request notification permissions', e);
    return false;
  }
}

/**
 * Check if notifications are enabled
 */
export async function areNotificationsEnabled(): Promise<boolean> {
  try {
    const enabled = await AsyncStorage.getItem(NOTIFICATION_ENABLED_KEY);
    return enabled !== 'false'; // Default to true
  } catch (e) {
    return true;
  }
}

/**
 * Enable/disable notifications
 */
export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(NOTIFICATION_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (e) {
    console.warn('Failed to save notification preference', e);
  }
}

/**
 * Send transaction received notification
 */
export async function notifyTransactionReceived(
  amount: number,
  currency: string,
  from?: string
): Promise<void> {
  const enabled = await areNotificationsEnabled();
  if (!enabled) return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '💰 Money Received',
        body: `You received ${amount.toFixed(2)} ${currency}${from ? ` from ${from}` : ''}`,
        data: { type: 'transaction_received', amount, currency },
        sound: 'default',
      },
      trigger: null, // Show immediately
    });
  } catch (e) {
    console.warn('Failed to send notification', e);
  }
}

/**
 * Send transaction sent notification
 */
export async function notifyTransactionSent(
  amount: number,
  currency: string,
  to?: string
): Promise<void> {
  const enabled = await areNotificationsEnabled();
  if (!enabled) return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '✅ Transaction Complete',
        body: `Sent ${amount.toFixed(2)} ${currency}${to ? ` to ${to}` : ''}`,
        data: { type: 'transaction_sent', amount, currency },
        sound: 'default',
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('Failed to send notification', e);
  }
}

/**
 * Send rate alert notification
 */
export async function notifyRateAlert(
  currency: string,
  oldRate: number,
  newRate: number,
  changePercent: number
): Promise<void> {
  const enabled = await areNotificationsEnabled();
  if (!enabled) return;

  try {
    const direction = changePercent > 0 ? '📈' : '📉';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${direction} ${currency} Rate Alert`,
        body: `${currency} rate changed by ${Math.abs(changePercent).toFixed(1)}%`,
        data: { type: 'rate_alert', currency, oldRate, newRate },
        sound: 'default',
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('Failed to send rate alert', e);
  }
}

/**
 * Send budget limit notification
 */
export async function notifyBudgetLimit(
  category: string,
  spent: number,
  limit: number,
  percentUsed: number
): Promise<void> {
  const enabled = await areNotificationsEnabled();
  if (!enabled) return;

  try {
    let title = '';
    let body = '';

    if (percentUsed >= 100) {
      title = '⚠️ Budget Exceeded';
      body = `You've exceeded your ${category} budget limit`;
    } else if (percentUsed >= 90) {
      title = '⚠️ Budget Alert';
      body = `You've used ${percentUsed.toFixed(0)}% of your ${category} budget`;
    } else if (percentUsed >= 75) {
      title = '💡 Budget Warning';
      body = `You've used ${percentUsed.toFixed(0)}% of your ${category} budget`;
    }

    if (title) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data: { type: 'budget_alert', category, spent, limit },
          sound: 'default',
        },
        trigger: null,
      });
    }
  } catch (e) {
    console.warn('Failed to send budget notification', e);
  }
}

/**
 * Cancel all notifications
 */
export async function cancelAllNotifications(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (e) {
    console.warn('Failed to cancel notifications', e);
  }
}
