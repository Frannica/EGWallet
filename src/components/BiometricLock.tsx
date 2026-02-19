import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useBiometric } from '../auth/BiometricContext';

export default function BiometricLock() {
  const { unlock, biometricType } = useBiometric();

  useEffect(() => {
    // Automatically trigger biometric auth on mount
    attemptUnlock();
  }, []);

  async function attemptUnlock() {
    await unlock();
  }

  const getIcon = () => {
    switch (biometricType) {
      case 'fingerprint':
        return 'finger-print';
      case 'face':
        return 'scan';
      case 'iris':
        return 'eye';
      default:
        return 'lock-closed';
    }
  };

  const getMessage = () => {
    switch (biometricType) {
      case 'fingerprint':
        return 'Touch fingerprint sensor to unlock';
      case 'face':
        return 'Look at your device to unlock';
      case 'iris':
        return 'Look at your device to unlock';
      default:
        return 'Authenticate to unlock';
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name={getIcon() as any} size={80} color="#007AFF" />
        </View>
        
        <Text style={styles.title}>EGWallet is Locked</Text>
        <Text style={styles.subtitle}>{getMessage()}</Text>

        <TouchableOpacity style={styles.unlockButton} onPress={attemptUnlock}>
          <Ionicons name="lock-open" size={24} color="#FFFFFF" />
          <Text style={styles.unlockButtonText}>Unlock</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        Your wallet is secured with biometric authentication
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  iconContainer: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1C1E21',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#657786',
    marginBottom: 40,
    textAlign: 'center',
    paddingHorizontal: 40,
    lineHeight: 24,
  },
  unlockButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 10,
  },
  unlockButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  footer: {
    fontSize: 14,
    color: '#AAB8C2',
    textAlign: 'center',
    marginBottom: 20,
  },
});
