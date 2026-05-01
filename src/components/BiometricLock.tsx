import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useBiometric } from '../auth/BiometricContext';
import { useLanguage } from '../i18n/LanguageContext';

export default function BiometricLock() {
  const { unlock, biometricType } = useBiometric();
  const { t } = useLanguage();

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
        return t('biometric.touchFingerprint');
      case 'face':
        return t('biometric.lookAtDevice');
      case 'iris':
        return t('biometric.lookAtDevice');
      default:
        return t('biometric.authenticate');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name={getIcon() as any} size={80} color="#007AFF" />
        </View>
        
        <Text style={styles.title}>{t('biometric.title')}</Text>
        <Text style={styles.subtitle}>{getMessage()}</Text>

        <TouchableOpacity style={styles.unlockButton} onPress={attemptUnlock}>
          <Ionicons name="lock-open" size={24} color="#FFFFFF" />
          <Text style={styles.unlockButtonText}>{t('biometric.unlock')}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        {t('biometric.footer')}
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
