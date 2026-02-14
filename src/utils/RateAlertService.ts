import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchRates, Rates } from '../api/client';
import { notifyRateAlert } from './NotificationService';

export interface RateAlert {
  id: string;
  currency: string;
  threshold: number;
  direction: 'above' | 'below';
  enabled: boolean;
  lastRate?: number;
  createdAt: number;
}

const RATE_ALERTS_KEY = 'egwallet_rate_alerts';
const LAST_RATES_KEY = 'egwallet_last_rates';

/**
 * Load all rate alerts
 */
export async function loadRateAlerts(): Promise<RateAlert[]> {
  try {
    const data = await AsyncStorage.getItem(RATE_ALERTS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.warn('Failed to load rate alerts', e);
    return [];
  }
}

/**
 * Save rate alert
 */
export async function saveRateAlert(alert: Omit<RateAlert, 'id' | 'createdAt'>): Promise<RateAlert> {
  try {
    const alerts = await loadRateAlerts();
    const newAlert: RateAlert = {
      ...alert,
      id: Date.now().toString(),
      createdAt: Date.now(),
    };
    alerts.push(newAlert);
    await AsyncStorage.setItem(RATE_ALERTS_KEY, JSON.stringify(alerts));
    return newAlert;
  } catch (e) {
    console.warn('Failed to save rate alert', e);
    throw new Error('Failed to save rate alert');
  }
}

/**
 * Update rate alert
 */
export async function updateRateAlert(id: string, updates: Partial<RateAlert>): Promise<void> {
  try {
    const alerts = await loadRateAlerts();
    const index = alerts.findIndex(a => a.id === id);
    if (index !== -1) {
      alerts[index] = { ...alerts[index], ...updates };
      await AsyncStorage.setItem(RATE_ALERTS_KEY, JSON.stringify(alerts));
    }
  } catch (e) {
    console.warn('Failed to update rate alert', e);
  }
}

/**
 * Delete rate alert
 */
export async function deleteRateAlert(id: string): Promise<void> {
  try {
    const alerts = await loadRateAlerts();
    const filtered = alerts.filter(a => a.id !== id);
    await AsyncStorage.setItem(RATE_ALERTS_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.warn('Failed to delete rate alert', e);
  }
}

/**
 * Check all rate alerts and send notifications if triggered
 */
export async function checkRateAlerts(): Promise<void> {
  try {
    const alerts = await loadRateAlerts();
    const enabledAlerts = alerts.filter(a => a.enabled);
    
    if (enabledAlerts.length === 0) return;

    // Fetch current rates
    const rates = await fetchRates();
    if (!rates) return;

    // Get last known rates
    const lastRatesData = await AsyncStorage.getItem(LAST_RATES_KEY);
    const lastRates: Record<string, number> = lastRatesData ? JSON.parse(lastRatesData) : {};

    // Check each alert
    for (const alert of enabledAlerts) {
      const currentRate = (rates as any)[alert.currency];
      if (!currentRate) continue;

      const lastRate = lastRates[alert.currency];
      
      // Check if alert should trigger
      let shouldAlert = false;
      if (alert.direction === 'above' && currentRate > alert.threshold) {
        shouldAlert = true;
      } else if (alert.direction === 'below' && currentRate < alert.threshold) {
        shouldAlert = true;
      }

      // Send notification if triggered and rate changed significantly
      if (shouldAlert && lastRate) {
        const changePercent = ((currentRate - lastRate) / lastRate) * 100;
        if (Math.abs(changePercent) >= 1.0) { // 1% change threshold
          await notifyRateAlert(alert.currency, lastRate, currentRate, changePercent);
        }
      }

      // Update last rate for this alert
      await updateRateAlert(alert.id, { lastRate: currentRate });
    }

    // Save current rates as last rates
    await AsyncStorage.setItem(LAST_RATES_KEY, JSON.stringify(rates));
  } catch (e) {
    console.warn('Failed to check rate alerts', e);
  }
}

/**
 * Start monitoring rates (call this periodically, e.g., every 15 minutes)
 */
export function startRateMonitoring(intervalMs: number = 15 * 60 * 1000): NodeJS.Timeout {
  // Initial check
  checkRateAlerts();
  
  // Set up periodic checking
  return setInterval(() => {
    checkRateAlerts();
  }, intervalMs);
}

/**
 * Stop monitoring rates
 */
export function stopRateMonitoring(intervalId: NodeJS.Timeout): void {
  clearInterval(intervalId);
}
