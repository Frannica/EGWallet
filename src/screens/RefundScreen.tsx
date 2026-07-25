import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, TextInput, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useLanguage } from '../i18n/LanguageContext';
import { formatCurrency, minorToMajor, majorToMinor, decimalsFor } from '../utils/currency';
import {
  getRefundEligibility, requestRefund, RefundEligibility, RefundRequest,
} from '../api/refunds';
import { generateId } from '../api/transactions';
import { getApiErrorMessage } from '../utils/apiErrorMessage';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';

type Params = {
  transactionId: string;
  amount?: number;
  currency?: string;
};

export default function RefundScreen() {
  const { t } = useLanguage();
  const navigation = useNavigation();
  const route = useRoute() as RouteProp<Record<string, Params>, string>;
  const params = (route.params || {}) as unknown as Params;
  const { isOnline } = useNetworkStatus();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [eligibility, setEligibility] = useState<RefundEligibility | null>(null);
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [partialMajor, setPartialMajor] = useState('');
  const [result, setResult] = useState<RefundRequest | null>(null);
  const idempotencyKeyRef = useRef(generateId());

  const load = useCallback(async () => {
    if (!params.transactionId) return;
    setLoading(true);
    try {
      const data = await getRefundEligibility(params.transactionId);
      setEligibility(data);
      if (data.maxRefundable > 0) {
        setPartialMajor(String(minorToMajor(data.maxRefundable, data.currency)));
      }
    } catch (e: any) {
      Alert.alert(t('common.error'), getApiErrorMessage(e, t));
    } finally {
      setLoading(false);
    }
  }, [params.transactionId, t]);

  useEffect(() => { load(); }, [load]);

  async function onSubmit() {
    if (!eligibility || submitting) return;
    if (!eligibility.eligible) {
      Alert.alert(t('refund.notEligibleTitle'), t('refund.notEligibleMsg'));
      return;
    }

    const currency = eligibility.currency;
    let amountMinor: number | undefined;
    let amountMode: 'full' | 'partial' = mode;
    if (mode === 'partial') {
      const major = parseFloat(partialMajor.replace(/,/g, ''));
      if (!major || major <= 0) {
        return Alert.alert(t('common.error'), t('refund.enterValidAmount'));
      }
      amountMinor = majorToMinor(major, currency);
      if (amountMinor > eligibility.maxRefundable) {
        return Alert.alert(
          t('common.error'),
          t('refund.exceedsMax').replace('{max}', formatCurrency(eligibility.maxRefundable, currency)),
        );
      }
      if (amountMinor === eligibility.maxRefundable) amountMode = 'full';
    }

    Alert.alert(
      t('refund.confirmTitle'),
      t('refund.confirmMsg')
        .replace('{amount}', formatCurrency(
          amountMode === 'full' ? eligibility.maxRefundable : (amountMinor || 0),
          currency,
        )),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('refund.confirmButton'),
          onPress: async () => {
            setSubmitting(true);
            try {
              const res = await requestRefund({
                depositTransactionId: eligibility.depositTransactionId,
                amountMode,
                amount: amountMode === 'partial' ? amountMinor : undefined,
                idempotencyKey: idempotencyKeyRef.current,
              });
              idempotencyKeyRef.current = generateId();
              setResult(res.refund);
              (navigation as any).navigate('Receipt', {
                amount: res.refund.amount,
                currency: res.refund.currency,
                senderCurrency: res.refund.currency,
                recipientName: t('refund.originalPaymentMethod'),
                timestamp: res.refund.createdAt || Date.now(),
                transactionId: res.refund.id,
                paymentReference: res.refund.stripeRefundId || res.refund.stripePaymentIntentId,
                type: 'withdrawal',
                status: res.refund.status === 'succeeded' ? 'completed' : 'pending',
              });
            } catch (e: any) {
              Alert.alert(t('refund.failedTitle'), getApiErrorMessage(e, t));
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1565C0" />
      </View>
    );
  }

  if (!eligibility) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{t('refund.loadFailed')}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={load}>
          <Text style={styles.primaryBtnText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const currency = eligibility.currency;
  const dec = decimalsFor(currency);

  return (
    <View style={styles.container}>
      <OfflineErrorBanner visible={!isOnline} onRetry={load} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.banner}>
          <Ionicons name="card-outline" size={22} color="#1565C0" />
          <Text style={styles.bannerText}>{t('refund.destinationNotice')}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>{t('refund.depositAmount')}</Text>
          <Text style={styles.value}>{formatCurrency(eligibility.depositAmount, currency)}</Text>

          <Text style={[styles.label, { marginTop: 14 }]}>{t('refund.refundableAmount')}</Text>
          <Text style={styles.valueAccent}>{formatCurrency(eligibility.maxRefundable, currency)}</Text>

          {eligibility.stripePaymentIntentId ? (
            <>
              <Text style={[styles.label, { marginTop: 14 }]}>{t('receipt.paymentReference')}</Text>
              <Text style={styles.mono}>{eligibility.stripePaymentIntentId}</Text>
            </>
          ) : null}
        </View>

        {!eligibility.eligible ? (
          <View style={styles.warnCard}>
            <Ionicons name="alert-circle" size={20} color="#E65100" />
            <Text style={styles.warnText}>
              {!eligibility.withinRefundWindow
                ? t('refund.windowExpired').replace('{days}', String(eligibility.refundWindowDays))
                : eligibility.accountStatus !== 'ok'
                  ? t('refund.accountBlocked')
                  : !eligibility.stripe.available
                    ? t('refund.stripeUnavailable')
                    : t('refund.notEligibleMsg')}
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>{t('refund.chooseAmount')}</Text>
            <View style={styles.modeRow}>
              <TouchableOpacity
                style={[styles.modeBtn, mode === 'full' && styles.modeBtnActive]}
                onPress={() => setMode('full')}
              >
                <Text style={[styles.modeText, mode === 'full' && styles.modeTextActive]}>
                  {t('refund.fullRefund')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeBtn, mode === 'partial' && styles.modeBtnActive]}
                onPress={() => setMode('partial')}
              >
                <Text style={[styles.modeText, mode === 'partial' && styles.modeTextActive]}>
                  {t('refund.partialRefund')}
                </Text>
              </TouchableOpacity>
            </View>

            {mode === 'partial' && (
              <View style={styles.card}>
                <Text style={styles.label}>{t('refund.partialAmount')} ({currency})</Text>
                <TextInput
                  style={styles.input}
                  value={partialMajor}
                  onChangeText={setPartialMajor}
                  keyboardType="decimal-pad"
                  placeholder={dec === 0 ? '0' : '0.00'}
                  placeholderTextColor="#AAB8C2"
                  editable={!submitting}
                />
              </View>
            )}

            <TouchableOpacity
              style={[styles.primaryBtn, (!isOnline || submitting) && styles.primaryBtnDisabled]}
              onPress={onSubmit}
              disabled={!isOnline || submitting}
            >
              {submitting
                ? <ActivityIndicator color="#FFF" />
                : <Text style={styles.primaryBtnText}>{t('refund.submit')}</Text>}
            </TouchableOpacity>
          </>
        )}

        {result && (
          <View style={styles.card}>
            <Text style={styles.label}>{t('refund.status')}</Text>
            <Text style={styles.value}>{result.status}</Text>
            <Text style={[styles.label, { marginTop: 10 }]}>{t('receipt.reference')}</Text>
            <Text style={styles.mono}>{result.id}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#EBF4FE' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#EBF4FE' },
  scroll: { padding: 20, paddingBottom: 40 },
  banner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: '#E3F2FD', borderRadius: 12, padding: 14, marginBottom: 16,
  },
  bannerText: { flex: 1, color: '#0D47A1', fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: '#FFF', borderRadius: 14, padding: 16, marginBottom: 16,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, elevation: 1,
  },
  label: { color: '#657786', fontSize: 13, marginBottom: 4 },
  value: { color: '#14171A', fontSize: 20, fontWeight: '700' },
  valueAccent: { color: '#1565C0', fontSize: 22, fontWeight: '700' },
  mono: { color: '#14171A', fontSize: 13, fontFamily: 'monospace' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#14171A', marginBottom: 10 },
  modeRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  modeBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: '#FFF',
    borderWidth: 1.5, borderColor: '#D0DCE8', alignItems: 'center',
  },
  modeBtnActive: { borderColor: '#1565C0', backgroundColor: '#E3F2FD' },
  modeText: { color: '#657786', fontWeight: '600' },
  modeTextActive: { color: '#1565C0' },
  input: {
    borderWidth: 1, borderColor: '#D0DCE8', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 18, color: '#14171A',
    backgroundColor: '#FAFCFF',
  },
  primaryBtn: {
    backgroundColor: '#1565C0', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginTop: 4,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  warnCard: {
    flexDirection: 'row', gap: 10, backgroundColor: '#FFF3E0',
    borderRadius: 12, padding: 14, marginBottom: 16,
  },
  warnText: { flex: 1, color: '#E65100', fontSize: 14, lineHeight: 20 },
  errorText: { color: '#657786', marginBottom: 16, textAlign: 'center' },
});
