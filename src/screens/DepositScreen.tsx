/**
 * DepositScreen — Add money to wallet
 *
 * Two operating modes:
 *   1. DEMO MODE  — backend has no STRIPE_SECRET_KEY set.
 *      The backend issues a "demo intent"; this screen credits the wallet
 *      directly after confirmation. Works in Expo Go with zero native modules.
 *
 *   2. STRIPE MODE — STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY are set.
 *      The backend creates a real Stripe PaymentIntent; this screen renders
 *      the native Stripe PaymentSheet via @stripe/stripe-react-native.
 *      Requires a custom dev build (EAS Build / expo prebuild).
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Alert, ActivityIndicator, Animated, Modal
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { useNavigation, useRoute } from '@react-navigation/native';
import { API_BASE } from '../api/client';
import { useLanguage } from '../i18n/LanguageContext';
import { getApiErrorMessage } from '../utils/apiErrorMessage';
import { formatMinDepositLabel, minDepositMajor } from '../utils/depositLimits';
import { majorToMinor, formatCurrency, getCurrencySymbol, getCurrencyName, CURRENCY_INFO } from '../utils/currency';
import { creditLocalBalance } from '../utils/localBalance';
import { TOPUP_FREE_LIMIT, TOPUP_FEE_RATE } from '../config/fees';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';
import {
  STRIPE_SDK_AVAILABLE,
  StripeProvider,
  useStripe,
  runDepositPaymentSheetOnce,
} from '../stripe/stripeSdk';

const PRESET_AMOUNTS = [
  { label: '1,000', value: 1000 },
  { label: '5,000', value: 5000 },
  { label: '10,000', value: 10000 },
  { label: '25,000', value: 25000 },
  { label: '50,000', value: 50000 },
  { label: '100,000', value: 100000 },
];

const AFRICAN_CURRENCY_CODES = new Set([
  'XAF','XOF','NGN','GHS','KES','ZAR','TZS','UGX','ETB','EGP','MAD','TND','DZD',
  'RWF','MUR','BWP','ZMW','AOA','GMD','LYD','NAD','LSL','MZN','SDG','SOS','ZWL',
  'SCR','ERN','SLE','CDF','CVE','MWK',
]);

// All currencies from CURRENCY_INFO, sorted: Africa popular first, then rest
const ALL_CURRENCIES = Object.keys(CURRENCY_INFO);
const AFRICAN_CURRENCIES_SORTED = ALL_CURRENCIES.filter(c => AFRICAN_CURRENCY_CODES.has(c))
  .sort((a, b) => {
    const popular = ['XAF','XOF','NGN','GHS','KES','ZAR','EGP','MAD','TZS','UGX','ETB','RWF'];
    const ai = popular.indexOf(a);
    const bi = popular.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
const WORLD_CURRENCIES_SORTED = ALL_CURRENCIES.filter(c => !AFRICAN_CURRENCY_CODES.has(c))
  .sort((a, b) => {
    const popular = ['USD','EUR','GBP','CNY','JPY','INR','CAD','AUD','AED','BRL'];
    const ai = popular.indexOf(a);
    const bi = popular.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

// Stripe PaymentSheet — init + auto-present (no in-app card form; Stripe collects card data)
function StripePaymentSheetFlow({
  clientSecret,
  onSuccess,
  onError,
  onCancel,
}: {
  clientSecret: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const { t } = useLanguage();
  const [phase, setPhase] = useState<'init' | 'presenting' | 'failed'>('init');
  const startedForSecretRef = useRef<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  const onCancelRef = useRef(onCancel);
  onSuccessRef.current = onSuccess;
  onErrorRef.current = onError;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (startedForSecretRef.current === clientSecret) return;
    startedForSecretRef.current = clientSecret;
    let cancelled = false;

    (async () => {
      setPhase('init');
      const result = await runDepositPaymentSheetOnce(stripe, clientSecret, 'EGWallet');
      if (cancelled) return;

      if (result.status === 'success') {
        onSuccessRef.current();
        return;
      }
      if (result.status === 'cancelled') {
        onCancelRef.current();
        return;
      }
      setPhase('failed');
      onErrorRef.current(result.message);
    })();

    return () => { cancelled = true; };
    // clientSecret only — stripe hook identity changes on parent re-renders and must NOT re-present
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientSecret]);

  if (phase === 'failed') {
    return (
      <TouchableOpacity style={styles.primaryButton} onPress={onCancel}>
        <Text style={styles.primaryButtonText}>{t('common.cancel')}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.paymentProcessing}>
      <ActivityIndicator color="#1565C0" size="large" />
      <Text style={styles.paymentProcessingText}>{t('common.loading')}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function DepositScreen() {
  const auth = useAuth();
  const navigation = useNavigation();
  const route = useRoute();
  const { t } = useLanguage();
  const params = route.params as { walletId?: string } | undefined;

  const [walletId, setWalletId] = useState<string>(params?.walletId || '');
  const [amount, setAmount] = useState<string>('10,000');
  const [currency, setCurrency] = useState<string>('XAF');
  const [showCurrencyModal, setShowCurrencyModal] = useState(false);
  const [currencySearch, setCurrencySearch] = useState('');
  const [currencyTab, setCurrencyTab] = useState<'africa' | 'world'>('africa');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'demo' | 'stripe' | null>(null);
  const [stripeIntent, setStripeIntent] = useState<{
    clientSecret: string;
    intentId: string;
    publishableKey: string | null;
    resolvedWalletId: string;
  } | null>(null);
  const [feeInfo, setFeeInfo] = useState<{
    depositCount: number;
    freeTopupsRemaining: number;
    isFreeTopup: boolean;
    feeRate: number;
    freeLimit: number;
  } | null>(null);

  // Animations & UI helpers
  const buttonScale = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [depositSuccess, setDepositSuccess] = useState(false);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  function formatAmount(text: string): string {
    const raw = text.replace(/[^0-9]/g, '');
    if (!raw) return '';
    return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function animatePress() {
    Animated.sequence([
      Animated.spring(buttonScale, { toValue: 0.96, useNativeDriver: true, speed: 50, bounciness: 0 }),
      Animated.spring(buttonScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 4 }),
    ]).start();
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  };

  // Load user's first wallet + fee tier info on mount
  useEffect(() => {
    if (!auth.token) return;
    if (!walletId) {
      fetchWithTokenRefresh(`${API_BASE}/wallets`, { headers })
        .then(r => r.json())
        .then(data => {
          const first = data.wallets?.[0]?.id;
          if (first) setWalletId(first);
        })
        .catch(() => {});
    }
    fetchWithTokenRefresh(`${API_BASE}/deposits/fee-info`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setFeeInfo(data); })
      .catch(() => {});
  }, [auth.token]);

  function parsedAmount(): number {
    const v = parseFloat(amount.replace(/,/g, ''));
    return isNaN(v) || v <= 0 ? 0 : Math.round(v);
  }

  async function handleDeposit() {
    if (loading) return;
    if (!auth.token) return;
    if (!walletId) {
      Alert.alert(t('common.error'), t('deposit.walletNotLoaded'));
      return;
    }
    if (__DEV__) console.log('[Deposit] button pressed');
    const numAmount = parsedAmount();
    const minimumMajor = minDepositMajor(currency);
    if (numAmount < minimumMajor) {
      Alert.alert(
        t('common.error'),
        `${t('deposit.tooSmall')} (${formatMinDepositLabel(currency)})`,
      );
      return;
    }
    // Convert major units (what user types) → minor units (what backend/wallet stores)
    const amountMinor = majorToMinor(numAmount, currency);

    setLoading(true);
    try {
      // Step 1 — create intent
      const res = await fetchWithTokenRefresh(`${API_BASE}/deposits/create-intent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: amountMinor, currency, walletId }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err: any = new Error(data.error || data.message || 'Create intent failed');
        err.status = res.status;
        err.errorCode = data.errorCode;
        err.minimumMinor = data.minimumMinor;
        err.currency = data.currency;
        throw err;
      }

      setMode(data.mode);

      if (data.mode === 'demo') {
        // Demo mode: confirm immediately using the wallet ID resolved by the backend
        await confirmDeposit(data.intentId, data.resolvedWalletId || walletId);
      } else {
        // Stripe mode: store intent so the PaymentSheet component can render
        setStripeIntent({
          clientSecret: data.clientSecret,
          intentId: data.intentId,
          publishableKey: data.publishableKey,
          resolvedWalletId: data.resolvedWalletId || walletId,
        });
      }
    } catch (e: any) {
      if (__DEV__) console.log('[Deposit] error:', e?.message);
      const status = typeof e?.status === 'number' ? e.status : undefined;
      const isAuthError = status === 401 || status === 403;

      if (isAuthError) {
        const refreshed = await auth.handleTokenExpired();
        if (!refreshed) {
          Alert.alert(t('common.sessionExpired'), t('deposit.sessionExpired'));
        } else {
          const friendly = getApiErrorMessage({
            message: e?.message,
            errorCode: e?.errorCode,
          }, t);
          Alert.alert(t('common.error'), friendly);
        }
        return;
      } else {
        const friendly = getApiErrorMessage({
          message: e?.message,
          status,
          errorCode: e?.errorCode,
        }, t);
        Alert.alert(t('common.error'), friendly);
      }
    } finally {
      setLoading(false);
    }
  }

  async function confirmDeposit(intentId: string, resolvedWalletId: string) {
    const wid = resolvedWalletId;
    if (!wid) throw new Error('confirmDeposit called without a resolved wallet ID');
    const res = await fetchWithTokenRefresh(`${API_BASE}/deposits/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ intentId, walletId: wid }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err: any = new Error(data.error || data.message || 'Confirm failed');
      err.status = res.status;
      err.errorCode = data.errorCode;
      throw err;
    }

    // Keep local balance in sync with backend (credit the net amount)
    const netMinor = data.feeBreakdown?.addedToWallet ?? majorToMinor(parsedAmount(), currency);
    await creditLocalBalance(currency, netMinor);
    // Note: backend already records the deposit transaction — do NOT log locally to avoid duplicates

    // Refresh fee tier
    fetchWithTokenRefresh(`${API_BASE}/deposits/fee-info`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setFeeInfo(d); })
      .catch(() => {});

    setDepositSuccess(true);
    setTimeout(() => setDepositSuccess(false), 1500);

    const fb = data.feeBreakdown;
    setStripeIntent(null);
    (navigation as any).navigate('Receipt', {
      amount: netMinor,
      currency,
      senderCurrency: currency,
      fee: fb?.fee ?? 0,
      feeLabel: fb?.fee > 0 ? `Top-up Fee (${((fb.feeRate ?? 0) * 100).toFixed(1)}%)` : undefined,
      recipientName: 'Your Wallet',
      timestamp: Date.now(),
      type: 'deposit',
      status: 'completed',
    });
  }

  async function handleStripeSuccess() {
    if (!stripeIntent) return;
    // Capture before any async work so the catch closure never sees a stale value.
    const { intentId, resolvedWalletId } = stripeIntent;
    setLoading(true);
    try {
      await confirmDeposit(intentId, resolvedWalletId);
    } catch (e: any) {
      // Confirm failed (network / server error after card charged).
      // Offer a retry that re-calls /deposits/confirm with the same intentId —
      // the server's stripeIntentId idempotency guard prevents double-credit.
      // The payment_intent.succeeded webhook provides a second automatic fallback.
      Alert.alert(
        t('deposit.depositSubmitted'),
        t('deposit.paymentReceived'),
        [
          { text: t('common.done'), style: 'cancel', onPress: () => (navigation as any).goBack() },
          {
            text: t('common.retry'),
            onPress: async () => {
              setLoading(true);
              try {
                await confirmDeposit(intentId, resolvedWalletId);
              } catch {
                Alert.alert(
                  t('common.error'),
                  t('deposit.retryFailed'),
                );
              } finally {
                setLoading(false);
              }
            },
          },
        ]
      );
    } finally {
      setLoading(false);
    }
  }

  const numAmount = parsedAmount();

  const btnColors: [string, string] = depositSuccess ? ['#2e7d32', '#388e3c'] : ['#1565C0', '#0A3D7C'];

  function clearStripeFlow() {
    setStripeIntent(null);
    setMode(null);
  }

  return (
    <LinearGradient
      colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']}
      style={styles.gradient}
    >
      <Animated.ScrollView
        style={{ flex: 1, opacity: fadeAnim }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero Header */}
        <View style={styles.heroHeader}>
          <LinearGradient
            colors={['#1565C0', '#0A3D7C']}
            style={styles.heroIconCircle}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <Ionicons name="add" size={30} color="#fff" />
          </LinearGradient>
          <Text style={styles.heroTitle}>{t('deposit.addMoney')}</Text>
          <Text style={styles.heroSubtitle}>{t('deposit.fundWallet')}</Text>
        </View>

        {/* Mode Banner — Stripe only */}
        {mode === null && !stripeIntent && STRIPE_SDK_AVAILABLE && (
          <View style={styles.infoBanner}>
            <Ionicons name="information-circle-outline" size={18} color="#1565C0" />
            <Text style={styles.infoBannerText}>
              {t('deposit.stripeAvailable')}
            </Text>
          </View>
        )}

        {/* Amount Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <LinearGradient
              colors={['#1565C0', '#0A3D7C']}
              style={styles.cardIconBadge}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <Ionicons name="wallet-outline" size={14} color="#fff" />
            </LinearGradient>
            <Text style={styles.cardTitle}>{t('deposit.depositAmount')}</Text>
          </View>

          {/* Preset amounts */}
          <Text style={styles.label}>{t('deposit.quickSelect')}</Text>
          <View style={styles.presetGrid}>
            {PRESET_AMOUNTS.map(p => (
              <TouchableOpacity
                key={p.value}
                style={[styles.presetChip, parsedAmount() === p.value && styles.presetChipSelected]}
                onPress={() => setAmount(formatAmount(String(p.value)))}
                activeOpacity={0.7}
              >
                <Text style={[styles.presetChipText, parsedAmount() === p.value && styles.presetChipTextSelected]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Custom amount */}
          <Text style={styles.label}>{t('deposit.enterAmount')}</Text>
          <View style={styles.inputWrapper}>
            <Text style={styles.inputCurrencyLabel}>{currency}</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={v => setAmount(formatAmount(v))}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor="#b0c4de"
            />
          </View>

          {/* Currency picker */}
          <Text style={styles.label}>{t('deposit.currency')}</Text>
          <TouchableOpacity
            style={styles.currencySelector}
            onPress={() => { setCurrencySearch(''); setShowCurrencyModal(true); }}
            activeOpacity={0.8}
          >
            <View style={styles.currencySelectorLeft}>
              <Text style={styles.currencySelectorCode}>{getCurrencySymbol(currency)} {currency}</Text>
              <Text style={styles.currencySelectorName}>{getCurrencyName(currency)}</Text>
            </View>
            <Ionicons name="chevron-down" size={18} color="#1565C0" />
          </TouchableOpacity>

          {/* Currency Picker Modal */}
          <Modal
            visible={showCurrencyModal}
            transparent
            animationType="slide"
            onRequestClose={() => setShowCurrencyModal(false)}
          >
            <View style={styles.currencyModalOverlay}>
              <View style={styles.currencyModalSheet}>
                <View style={styles.currencyModalHeader}>
                  <Text style={styles.currencyModalTitle}>{t('deposit.selectCurrency')}</Text>
                  <TouchableOpacity onPress={() => setShowCurrencyModal(false)}>
                    <Ionicons name="close" size={24} color="#14171A" />
                  </TouchableOpacity>
                </View>

                {/* Search */}
                <View style={styles.currencySearchBox}>
                  <Ionicons name="search" size={16} color="#9BAAB8" style={{ marginRight: 8 }} />
                  <TextInput
                    value={currencySearch}
                    onChangeText={setCurrencySearch}
                    placeholder={t('deposit.searchCurrencies')}
                    placeholderTextColor="#9BAAB8"
                    style={styles.currencySearchInput}
                    autoCorrect={false}
                    autoCapitalize="characters"
                  />
                </View>

                {/* Tabs — only show when not searching */}
                {!currencySearch.trim() && (
                  <View style={styles.currencyTabRow}>
                    <TouchableOpacity
                      style={[styles.currencyTabBtn, currencyTab === 'africa' && styles.currencyTabBtnActive]}
                      onPress={() => setCurrencyTab('africa')}
                    >
                      <Text style={[styles.currencyTabText, currencyTab === 'africa' && styles.currencyTabTextActive]}>
                        🌍 {t('deposit.africa')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.currencyTabBtn, currencyTab === 'world' && styles.currencyTabBtnActive]}
                      onPress={() => setCurrencyTab('world')}
                    >
                      <Text style={[styles.currencyTabText, currencyTab === 'world' && styles.currencyTabTextActive]}>
                        🌐 {t('deposit.world')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Currency list */}
                <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
                  {(() => {
                    const q = currencySearch.toUpperCase().trim();
                    const list = q
                      ? [...AFRICAN_CURRENCIES_SORTED, ...WORLD_CURRENCIES_SORTED].filter(
                          c => c.includes(q) || CURRENCY_INFO[c]?.name.toUpperCase().includes(q)
                        )
                      : currencyTab === 'africa' ? AFRICAN_CURRENCIES_SORTED : WORLD_CURRENCIES_SORTED;
                    return list.map(code => (
                      <TouchableOpacity
                        key={code}
                        style={[styles.currencyItem, currency === code && styles.currencyItemSelected]}
                        onPress={() => { setCurrency(code); setShowCurrencyModal(false); }}
                        activeOpacity={0.7}
                      >
                        <View style={styles.currencyItemIconBox}>
                          <Text style={styles.currencyItemSymbol}>{getCurrencySymbol(code)}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.currencyItemCode}>{code}</Text>
                          <Text style={styles.currencyItemName}>{CURRENCY_INFO[code]?.name}</Text>
                        </View>
                        {currency === code && (
                          <Ionicons name="checkmark-circle" size={20} color="#1565C0" />
                        )}
                      </TouchableOpacity>
                    ));
                  })()}
                </ScrollView>
              </View>
            </View>
          </Modal>

          {/* Fee breakdown preview */}
          {(() => {
            const amtMinor = majorToMinor(numAmount, currency);
            const isActuallyFree = feeInfo ? feeInfo.isFreeTopup : true;
            const rate = isActuallyFree ? 0 : TOPUP_FEE_RATE;
            const feeMinor = Math.round(amtMinor * rate);
            const totalCharged = amtMinor + feeMinor;
            return numAmount > 0 ? (
              <View style={styles.feeBreakdown}>
                {feeInfo && (
                  <View style={styles.feeTierBadge}>
                    <Ionicons
                      name={isActuallyFree ? 'gift-outline' : 'pricetag-outline'}
                      size={14}
                      color={isActuallyFree ? '#2E7D32' : '#1565C0'}
                    />
                    <Text style={[styles.feeTierText, { color: isActuallyFree ? '#2E7D32' : '#1565C0' }]}>
                      {isActuallyFree
                        ? `${feeInfo.freeTopupsRemaining} ${feeInfo.freeTopupsRemaining !== 1 ? t('deposit.freeTopupsPlural') : t('deposit.freeTopupsSingular')}`
                        : `${t('deposit.standardRateApplies')} (${(TOPUP_FEE_RATE * 100).toFixed(1)}%)`
                      }
                    </Text>
                  </View>
                )}
                <View style={styles.feeRow}>
                  <Text style={styles.feeLabel}>{t('deposit.youPay')}</Text>
                  <Text style={styles.feeValue}>{formatCurrency(totalCharged, currency)}</Text>
                </View>
                <View style={styles.feeRow}>
                  <Text style={styles.feeLabel}>{t('deposit.fee')}</Text>
                  <Text style={[styles.feeValue, feeMinor === 0 && styles.feeFree]}>
                    {feeMinor === 0 ? t('deposit.free') : `-${formatCurrency(feeMinor, currency)}`}
                  </Text>
                </View>
                <View style={[styles.feeRow, styles.feeTotal]}>
                  <Text style={styles.feeTotalLabel}>{t('deposit.addedToWallet')}</Text>
                  <Text style={styles.feeTotalValue}>{formatCurrency(amtMinor, currency)}</Text>
                </View>
              </View>
            ) : null;
          })()}
        </View>

        {/* Deposit button */}
        {!stripeIntent ? (
          <Animated.View style={[styles.buttonWrapper, { transform: [{ scale: buttonScale }] }]}>
            <TouchableOpacity
              style={[styles.primaryButtonOuter, (loading || numAmount < minDepositMajor(currency) || !walletId) && styles.buttonDisabled]}
              onPress={() => { animatePress(); handleDeposit(); }}
              disabled={loading || numAmount < minDepositMajor(currency) || !walletId}
              activeOpacity={1}
            >
              <LinearGradient
                colors={btnColors}
                style={styles.primaryButtonGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                {loading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : depositSuccess
                    ? (
                      <>
                        <Ionicons name="checkmark-circle" size={20} color="#fff" />
                        <Text style={styles.primaryButtonText}>{t('deposit.depositSuccessful')}</Text>
                      </>
                    )
                    : (
                      <>
                        <Ionicons name="card" size={20} color="#fff" />
                        <Text style={styles.primaryButtonText}>
                          {`${t('deposit.depositAction')} ${numAmount > 0 ? numAmount.toLocaleString() : '-'} ${currency}`}
                        </Text>
                      </>
                    )
                }
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        ) : (
          stripeIntent.publishableKey && STRIPE_SDK_AVAILABLE
            ? (
              <StripeProvider publishableKey={stripeIntent.publishableKey} merchantIdentifier="merchant.com.egwallet">
                <StripePaymentSheetFlow
                  clientSecret={stripeIntent.clientSecret}
                  onSuccess={handleStripeSuccess}
                  onError={msg => Alert.alert(t('common.error'), getApiErrorMessage({ message: msg }, t))}
                  onCancel={clearStripeFlow}
                />
              </StripeProvider>
            )
            : (
              <View style={styles.stripeUnavailableBanner}>
                <Ionicons name="warning-outline" size={22} color="#C62828" />
                <Text style={styles.stripeUnavailableText}>
                  {t('deposit.stripeSdkUnavailable')}
                </Text>
              </View>
            )
        )}

        {stripeIntent && (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={clearStripeFlow}
          >
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        )}

        {/* How it works */}
        <View style={styles.howItWorks}>
          <Text style={styles.howTitle}>{t('deposit.howItWorks')}</Text>
          {STRIPE_SDK_AVAILABLE ? (
            <>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>{t('deposit.how1')}</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>{t('deposit.how2')}</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>{t('deposit.how3')}</Text></View>
            </>
          ) : (
            <>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>{t('deposit.demoHow1')}</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>{t('deposit.demoHow2')}</Text></View>
            </>
          )}
        </View>
      </Animated.ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 52,
  },
  heroHeader: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 24,
  },
  heroIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 10,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0A3D7C',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  heroSubtitle: {
    fontSize: 14,
    color: '#5580A0',
    fontWeight: '500',
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.15)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  infoBannerText: {
    flex: 1,
    fontSize: 13,
    color: '#1A4A8A',
    lineHeight: 19,
    fontWeight: '500',
  },
  stripeUnavailableBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,235,238,0.95)',
    borderRadius: 14,
    padding: 16,
    marginBottom: 8,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(198,40,40,0.25)',
  },
  stripeUnavailableText: {
    flex: 1,
    fontSize: 14,
    color: '#B71C1C',
    lineHeight: 20,
    fontWeight: '600',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderRadius: 20,
    padding: 20,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.95)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.13,
    shadowRadius: 18,
    elevation: 7,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
    gap: 10,
  },
  cardIconBadge: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0A3D7C',
    letterSpacing: 1.2,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0A3D7C',
    marginBottom: 8,
    marginTop: 4,
    letterSpacing: 0.2,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 18,
  },
  presetChip: {
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.22)',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  presetChipSelected: {
    borderColor: '#1565C0',
    backgroundColor: '#1565C0',
  },
  presetChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4a7aaa',
  },
  presetChipTextSelected: {
    color: '#fff',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.25)',
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.72)',
    marginBottom: 18,
    paddingLeft: 16,
    paddingRight: 8,
  },
  inputCurrencyLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1565C0',
    marginRight: 8,
    opacity: 0.85,
  },
  input: {
    flex: 1,
    fontSize: 28,
    fontWeight: '800',
    color: '#0A3D7C',
    paddingVertical: 14,
    textAlign: 'right',
  },
  currencyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 18,
  },
  currencyChip: {
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.22)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  currencyChipSelected: {
    borderColor: '#1565C0',
    backgroundColor: '#1565C0',
  },
  currencyChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4a7aaa',
  },
  currencyChipTextSelected: {
    color: '#fff',
  },
  // Currency selector button
  currencySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.3)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.85)',
    marginBottom: 18,
  },
  currencySelectorLeft: {
    flex: 1,
  },
  currencySelectorCode: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1565C0',
  },
  currencySelectorName: {
    fontSize: 12,
    color: '#5A7A9A',
    marginTop: 1,
  },
  // Currency modal
  currencyModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  currencyModalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    height: '80%',
  },
  currencyModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#EEF2F7',
  },
  currencyModalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1565C0',
  },
  currencySearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#F0F4FA',
    borderRadius: 10,
  },
  currencySearchInput: {
    flex: 1,
    fontSize: 15,
    color: '#14171A',
  },
  currencyTabRow: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginBottom: 8,
    backgroundColor: '#F0F4FA',
    borderRadius: 10,
    padding: 3,
  },
  currencyTabBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  currencyTabBtnActive: {
    backgroundColor: '#1565C0',
  },
  currencyTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#5A7A9A',
  },
  currencyTabTextActive: {
    color: '#fff',
  },
  currencyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F4FA',
  },
  currencyItemSelected: {
    backgroundColor: '#EEF5FF',
  },
  currencyItemIconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#EEF5FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  currencyItemSymbol: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1565C0',
  },
  currencyItemCode: {
    fontSize: 14,
    fontWeight: '700',
    color: '#14171A',
  },
  currencyItemName: {
    fontSize: 12,
    color: '#5A7A9A',
    marginTop: 1,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.1)',
  },
  summaryLabel: {
    fontSize: 13,
    color: '#5580A0',
    fontWeight: '600',
  },
  summaryValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0A3D7C',
  },
  // Fee breakdown styles
  feeBreakdown: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    marginTop: 4,
  },
  feeTierBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
    backgroundColor: 'rgba(21,101,192,0.06)',
    borderRadius: 8,
    padding: 8,
  },
  feeTierText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  feeLabel: {
    fontSize: 13,
    color: '#5580A0',
    fontWeight: '500',
  },
  feeValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0A3D7C',
  },
  feeFree: {
    color: '#2E7D32',
  },
  feeTotal: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(21,101,192,0.12)',
    marginTop: 6,
    paddingTop: 10,
  },
  feeTotalLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0A3D7C',
  },
  feeTotalValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1565C0',
  },
  buttonWrapper: {
    marginBottom: 12,
  },
  primaryButtonOuter: {
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 8,
  },
  primaryButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    paddingHorizontal: 24,
    gap: 10,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 24,
    gap: 8,
    marginBottom: 12,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 8,
  },
  paymentProcessing: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 12,
    marginBottom: 12,
  },
  paymentProcessingText: {
    fontSize: 14,
    color: '#657786',
    fontWeight: '600',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  buttonDisabled: {
    opacity: 0.5,
    shadowOpacity: 0,
    elevation: 0,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 14,
    marginBottom: 10,
  },
  cancelText: {
    fontSize: 15,
    color: '#5580A0',
    fontWeight: '600',
  },
  howItWorks: {
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderRadius: 18,
    padding: 18,
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
  howTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0A3D7C',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  howItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  howDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#1565C0',
    opacity: 0.6,
  },
  howItemText: {
    fontSize: 13,
    color: '#5580A0',
    lineHeight: 18,
    fontWeight: '500',
    flex: 1,
  },
  demoTag: {
    backgroundColor: 'rgba(21,101,192,0.08)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  demoTagText: {
    fontSize: 12,
    color: '#1565C0',
    fontWeight: '700',
  },
});

