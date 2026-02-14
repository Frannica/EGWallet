import React, { useState, useEffect } from 'react';
import { View, Text, Button, Alert } from 'react-native';
import * as Network from 'expo-network';

interface OfflineErrorProps {
  onRetry: () => void;
  visible: boolean;
}

/**
 * Offline Error Banner
 * Shows when network is unavailable with retry button
 */
export function OfflineErrorBanner({ visible, onRetry }: OfflineErrorProps) {
  if (!visible) return null;

  return (
    <View style={{ backgroundColor: '#d32f2f', padding: 12, alignItems: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '600', marginBottom: 8 }}>
        ⚠️ No Internet Connection
      </Text>
      <Text style={{ color: '#fff', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
        Check your connection and try again.
      </Text>
      <Button title="Retry" onPress={onRetry} color="#fff" />
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
 * Provides context-aware error messages for network failures
 */
export function handleNetworkError(error: any, context: string) {
  const message = error?.message || 'Network error';

  if (message.includes('Network') || message.includes('fetch')) {
    Alert.alert('No Connection', 'Please check your internet connection and try again.');
    return;
  }

  if (message.includes('Timeout')) {
    Alert.alert('Connection Slow', 'Your connection is slow. Please retry when connection improves.');
    return;
  }

  Alert.alert('Error', `${context}: ${message}`);
}
