import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';
import { useLanguage } from '../i18n/LanguageContext';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'IDR', 'XOF', 'XAF', 'CLP', 'HUF', 'PYG',
  'UGX', 'RWF', 'GNF', 'MGA', 'KMF', 'DJF', 'BIF',
]);

function minorToMajor(amount: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? amount : amount / 100;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentRequest {
  id: string;
  requesterId: string;
  walletId: string;
  amount: number;
  currency: string;
  memo: string;
  status: 'pending' | 'paid' | 'cancelled';
  createdAt: number;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function PayRequestScreen({ route, navigation }: any) {
  const { requestId } = route.params || {};
  const auth = useAuth();
  const { t } = useLanguage();

  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [requesterEmail, setRequesterEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!requestId) {
      setError(t('payRequest.invalidLink'));
      setLoading(false);
      return;
    }
    fetch(`${API_BASE}/payment-requests/${requestId}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setError(data.error === 'Request not found'
            ? 'This payment request no longer exists or has expired.'
            : data.error);
        } else {
          setRequest(data.request);
          setRequesterEmail(data.requesterEmail || '');
        }
      })
      .catch(() => setError(t('payRequest.loadError')))
      .finally(() => setLoading(false));
  }, [requestId]);

  const handlePay = async () => {
    if (!auth.token) {
      Alert.alert(
        t('payRequest.loginRequired'),
        t('payRequest.loginMsg'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('payRequest.logIn'), onPress: () => navigation.navigate('Auth') },
        ]
      );
      return;
    }
    if (!request) return;
    setPaying(true);
    try {
      // Fetch user's wallet
      const walletsRes = await fetch(`${API_BASE}/wallets`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      const walletsData = await walletsRes.json();
      const walletId = walletsData.wallets?.[0]?.id;
      if (!walletId) throw new Error(t('payRequest.noWallet'));

      const payRes = await fetch(`${API_BASE}/payment-requests/${request.id}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ fromWalletId: walletId }),
      });
      const payData = await payRes.json();
      if (!payRes.ok) throw new Error(payData.error || 'Payment failed');

      const displayAmount = minorToMajor(request.amount, request.currency).toFixed(2);
      setRequest(prev => prev ? { ...prev, status: 'paid' } : prev);
      Alert.alert(
        t('payRequest.paymentSentTitle'),
        t('payRequest.paymentSentMsg').replace('{{amount}}', displayAmount).replace('{{currency}}', request.currency),
        [{ text: t('common.done'), onPress: () => navigation.goBack() }]
      );
    } catch (e: any) {
      Alert.alert(t('payRequest.paymentFailed'), e.message || t('payRequest.couldNotProcess'));
    } finally {
      setPaying(false);
    }
  };

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1565C0" />
        <Text style={styles.loadingText}>{t('payRequest.loading')}</Text>
      </View>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  if (error || !request) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={52} color="#E53935" />
        <Text style={styles.errorText}>{error || 'Request not found.'}</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backBtnText}>{t('payRequest.goBack')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  const isPaid = request.status === 'paid';
  const isCancelled = request.status === 'cancelled';
  const displayAmount = minorToMajor(request.amount, request.currency);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={[styles.iconCircle, isPaid && styles.iconCirclePaid]}>
          <Ionicons
            name={isPaid ? 'checkmark-circle' : 'cash-outline'}
            size={44}
            color={isPaid ? '#2e7d32' : '#1565C0'}
          />
        </View>

        <Text style={styles.title}>
          {isPaid ? t('payRequest.alreadyPaid') : isCancelled ? t('payRequest.requestCancelled') : t('payRequest.paymentRequest')}
        </Text>

        <Text style={styles.fromLabel}>{t('payRequest.requestedBy')}</Text>
        <Text style={styles.fromValue}>{requesterEmail || t('payRequest.egWalletUser')}</Text>

        <Text style={styles.amount}>
          {displayAmount.toFixed(2)}
          <Text style={styles.currency}> {request.currency}</Text>
        </Text>

        {!!request.memo && (
          <Text style={styles.memo}>"{request.memo}"</Text>
        )}

        {!isPaid && !isCancelled && (
          <TouchableOpacity
            style={[styles.payBtn, paying && styles.payBtnDisabled]}
            onPress={handlePay}
            disabled={paying}
            activeOpacity={0.85}
          >
            {paying
              ? <ActivityIndicator color="#fff" size="small" />
              : (
                <Text style={styles.payBtnText}>
                  Pay {displayAmount.toFixed(2)} {request.currency}
                </Text>
              )
            }
          </TouchableOpacity>
        )}

        {isPaid && (
          <View style={styles.statusBadge}>
            <Ionicons name="checkmark-circle" size={18} color="#2e7d32" />
            <Text style={[styles.statusText, { color: '#2e7d32' }]}> {t('payRequest.paid')}</Text>
          </View>
        )}

        {isCancelled && (
          <View style={styles.statusBadge}>
            <Ionicons name="close-circle" size={18} color="#999" />
            <Text style={[styles.statusText, { color: '#999' }]}> {t('payRequest.cancelled')}</Text>
          </View>
        )}

        <TouchableOpacity style={styles.backLink} onPress={() => navigation.goBack()}>
          <Text style={styles.backLinkText}>{t('payRequest.back')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#F5F9FF',
  },
  loadingText: {
    marginTop: 14,
    fontSize: 14,
    color: '#666',
  },
  container: {
    flex: 1,
    backgroundColor: '#F5F9FF',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 32,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 10,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 18,
  },
  iconCirclePaid: {
    backgroundColor: '#E8F5E9',
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0D1B2E',
    marginBottom: 12,
    textAlign: 'center',
  },
  fromLabel: {
    fontSize: 12,
    color: '#9BAAB8',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  fromValue: {
    fontSize: 15,
    color: '#444',
    fontWeight: '600',
    marginBottom: 20,
    textAlign: 'center',
  },
  amount: {
    fontSize: 44,
    fontWeight: '900',
    color: '#1565C0',
    letterSpacing: -1,
    marginBottom: 6,
  },
  currency: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1565C0',
  },
  memo: {
    fontSize: 14,
    color: '#777',
    fontStyle: 'italic',
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 8,
  },
  payBtn: {
    backgroundColor: '#1565C0',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 40,
    width: '100%',
    alignItems: 'center',
    marginTop: 12,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  payBtnDisabled: {
    opacity: 0.6,
  },
  payBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 0.3,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '700',
  },
  backLink: {
    marginTop: 20,
  },
  backLinkText: {
    fontSize: 14,
    color: '#1565C0',
    fontWeight: '600',
  },
  errorText: {
    fontSize: 15,
    color: '#E53935',
    textAlign: 'center',
    marginVertical: 18,
    lineHeight: 22,
  },
  backBtn: {
    backgroundColor: '#1565C0',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 36,
    marginTop: 8,
  },
  backBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
});
