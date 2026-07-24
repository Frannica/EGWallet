import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Linking, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { useLanguage } from '../i18n/LanguageContext';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { getApiErrorMessage } from '../utils/apiErrorMessage';
import {
  getStripeConnectStatus,
  startStripeConnectOnboarding,
  refreshStripeConnectLink,
  syncStripeConnectStatus,
  StripeConnectStatus,
} from '../api/stripeConnect';

/**
 * Onboarding-status screen for Stripe Connect (Express) bank withdrawals —
 * US/UK/European corridors only. Every call here is safe to make even while
 * the backend feature is disabled: /stripe-connect/status simply reports
 * exists:false, and onboard/sync surface a normal, localized error instead
 * of ever fabricating a working payout method.
 */
export default function StripeConnectOnboardingScreen() {
  const auth = useAuth();
  const { t } = useLanguage();
  const { isOnline } = useNetworkStatus();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [status, setStatus] = useState<StripeConnectStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await getStripeConnectStatus();
      setStatus(s);
      setLoadError(null);
    } catch (error: any) {
      setLoadError(getApiErrorMessage(error, t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useFocusEffect(
    React.useCallback(() => {
      loadStatus();
    }, [loadStatus])
  );

  const handleStart = async () => {
    if (!auth.token) return;
    setActionLoading(true);
    try {
      const region = auth.user?.region || '';
      const link = status?.exists
        ? await refreshStripeConnectLink()
        : await startStripeConnectOnboarding(region);
      const supported = await Linking.canOpenURL(link.url);
      if (!supported) throw new Error('Unable to open the Stripe onboarding link.');
      await Linking.openURL(link.url);
    } catch (error: any) {
      Alert.alert(t('common.error'), getApiErrorMessage(error, t));
    } finally {
      setActionLoading(false);
    }
  };

  const handleSync = async () => {
    setActionLoading(true);
    try {
      const s = await syncStripeConnectStatus();
      setStatus((prev) => ({ ...(prev || { exists: true }), ...s }));
    } catch (error: any) {
      Alert.alert(t('common.error'), getApiErrorMessage(error, t));
    } finally {
      setActionLoading(false);
    }
  };

  const onboardingStatus = status?.onboardingStatus || 'not_started';

  const statusMeta: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string; label: string; desc: string }> = {
    not_started: {
      icon: 'time-outline', color: '#657786',
      label: t('stripeConnect.statusNotStarted'), desc: t('stripeConnect.statusNotStartedDesc'),
    },
    onboarding: {
      icon: 'hourglass-outline', color: '#B26A00',
      label: t('stripeConnect.statusOnboarding'), desc: t('stripeConnect.statusOnboardingDesc'),
    },
    pending_verification: {
      icon: 'hourglass-outline', color: '#B26A00',
      label: t('stripeConnect.statusPendingVerification'), desc: t('stripeConnect.statusPendingVerificationDesc'),
    },
    complete: {
      icon: 'checkmark-circle', color: '#2E7D32',
      label: t('stripeConnect.statusComplete'), desc: t('stripeConnect.statusCompleteDesc'),
    },
    restricted: {
      icon: 'alert-circle', color: '#DC2626',
      label: t('stripeConnect.statusRestricted'), desc: status?.disabledReason || t('stripeConnect.statusRestrictedDesc'),
    },
  };
  const meta = statusMeta[onboardingStatus] || statusMeta.not_started;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <OfflineErrorBanner visible={!isOnline} onRetry={loadStatus} />

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#1565C0" />
        </View>
      ) : loadError ? (
        <View style={styles.centered}>
          <Ionicons name="warning-outline" size={40} color="#DC2626" />
          <Text style={styles.errorText}>{loadError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadStatus}>
            <Text style={styles.retryButtonText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={styles.statusCard}>
            <View style={[styles.statusIconWrap, { backgroundColor: `${meta.color}1A` }]}>
              <Ionicons name={meta.icon} size={32} color={meta.color} />
            </View>
            <Text style={styles.statusLabel}>{meta.label}</Text>
            <Text style={styles.statusDesc}>{meta.desc}</Text>

            {!!status?.currentlyDue?.length && onboardingStatus !== 'complete' && (
              <View style={styles.requirementsBox}>
                <Text style={styles.requirementsTitle}>{t('stripeConnect.requirementsTitle')}</Text>
                {status.currentlyDue!.slice(0, 6).map((req) => (
                  <Text key={req} style={styles.requirementItem}>• {req.replace(/_/g, ' ')}</Text>
                ))}
              </View>
            )}
          </View>

          {onboardingStatus !== 'complete' && (
            <TouchableOpacity
              style={[styles.primaryButton, actionLoading && styles.buttonDisabled]}
              onPress={handleStart}
              disabled={actionLoading}
              activeOpacity={0.85}
            >
              {actionLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {onboardingStatus === 'not_started' ? t('stripeConnect.startButton') : t('stripeConnect.continueButton')}
                </Text>
              )}
            </TouchableOpacity>
          )}

          {status?.exists && (
            <TouchableOpacity
              style={[styles.secondaryButton, actionLoading && styles.buttonDisabled]}
              onPress={handleSync}
              disabled={actionLoading}
              activeOpacity={0.85}
            >
              <Ionicons name="refresh" size={18} color="#1565C0" />
              <Text style={styles.secondaryButtonText}>{t('stripeConnect.syncButton')}</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.disclaimer}>{t('stripeConnect.disclaimer')}</Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F9FF' },
  content: { padding: 20, paddingBottom: 40 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  errorText: { fontSize: 14, color: '#657786', textAlign: 'center', marginTop: 12, marginBottom: 16 },
  retryButton: { backgroundColor: '#1565C0', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10 },
  retryButtonText: { color: '#fff', fontWeight: '700' },
  statusCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 24, alignItems: 'center',
    shadowColor: '#1565C0', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 3,
    marginBottom: 20,
  },
  statusIconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  statusLabel: { fontSize: 18, fontWeight: '800', color: '#0D1B2E', marginBottom: 6, textAlign: 'center' },
  statusDesc: { fontSize: 14, color: '#657786', textAlign: 'center', lineHeight: 20 },
  requirementsBox: { marginTop: 16, alignSelf: 'stretch', backgroundColor: '#FFF7E6', borderRadius: 10, padding: 14 },
  requirementsTitle: { fontSize: 13, fontWeight: '700', color: '#B26A00', marginBottom: 6 },
  requirementItem: { fontSize: 13, color: '#8A6100', marginBottom: 2, textTransform: 'capitalize' },
  primaryButton: {
    backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginBottom: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryButton: {
    flexDirection: 'row', gap: 8, backgroundColor: '#EAF2FF', borderRadius: 12, paddingVertical: 13,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  secondaryButtonText: { color: '#1565C0', fontSize: 15, fontWeight: '700' },
  disclaimer: { fontSize: 12, color: '#9BAEC8', textAlign: 'center', lineHeight: 18 },
});
