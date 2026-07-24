import React, { useState, useEffect } from 'react';
import { View, Text, Button, Alert } from 'react-native';
import * as Network from 'expo-network';
import { useLanguage } from '../i18n/LanguageContext';

interface OfflineErrorProps {
  onRetry: () => void;
  visible: boolean;
}

/**
 * Offline Error Banner
 * Shows when network is unavailable with retry button
 */
export function OfflineErrorBanner({ visible, onRetry }: OfflineErrorProps) {
  const { t } = useLanguage();
  if (!visible) return null;

  return (
    <View style={{ backgroundColor: '#d32f2f', padding: 12, alignItems: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '600', marginBottom: 8 }}>
        ⚠️ {t('offline.noConnectionTitle')}
      </Text>
      <Text style={{ color: '#fff', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
        {t('offline.checkConnection')}
      </Text>
      <Button title={t('common.retry')} onPress={onRetry} color="#fff" />
    </View>
  );
}

/**
 * Hook to monitor network connectivity
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [isSlowNetwork, setIsSlowNetwork] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Get initial state
        const state = await Network.getNetworkStateAsync();
        setIsOnline(state.isConnected ?? true);
        
        // Check if network is slow
        if (state.type === Network.NetworkStateType.CELLULAR) {
          setIsSlowNetwork(true);
        }

        // Note: Network.onNetworkStateChange is not available in expo-network v5
        // Consider using NetInfo from @react-native-community/netinfo if real-time updates are needed
      } catch (e) {
        if (__DEV__) console.warn('Network status check failed', e);
      }
    })();

    return () => {
      // Cleanup if needed
    };
  }, []);

  return { isOnline, isSlowNetwork };
}

/**
 * Offline-first error handler
 * Provides context-aware error messages for network failures.
 * Accepts an optional translator (from useLanguage()) so callers inside
 * LanguageProvider get localized copy; falls back to English otherwise.
 */
export function handleNetworkError(error: any, context: string, t?: (key: string) => string) {
  const translate = t || ((key: string) => {
    const fallback: Record<string, string> = {
      'offline.noConnectionAlertTitle': 'No Connection',
      'offline.noConnectionAlertMsg': 'Please check your internet connection and try again.',
      'offline.slowConnectionTitle': 'Connection Slow',
      'offline.slowConnectionMsg': 'Your connection is slow. Please retry when connection improves.',
      'common.error': 'Error',
      'offline.somethingWentWrong': 'Something went wrong. Please try again.',
    };
    return fallback[key] ?? key;
  });
  const message = error?.message || '';

  if (message.includes('Network') || message.includes('fetch')) {
    Alert.alert(translate('offline.noConnectionAlertTitle'), translate('offline.noConnectionAlertMsg'));
    return;
  }

  if (message.includes('Timeout') || message.includes('timeout')) {
    Alert.alert(translate('offline.slowConnectionTitle'), translate('offline.slowConnectionMsg'));
    return;
  }

  Alert.alert(translate('common.error'), `${context}: ${message || translate('offline.somethingWentWrong')}`);
}

