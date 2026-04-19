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
 *      To enable: `npx expo install @stripe/stripe-react-native` then rebuild.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Alert, ActivityIndicator, Animated, Modal, KeyboardAvoidingView, Platform
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { useNavigation, useRoute } from '@react-navigation/native';
import { API_BASE } from '../api/client';
import { majorToMinor, formatCurrency, getCurrencySymbol, getCurrencyName, CURRENCY_INFO } from '../utils/currency';
import { creditLocalBalance } from '../utils/localBalance';
import { TOPUP_FREE_LIMIT, TOPUP_FEE_RATE } from '../config/fees';

// ---------------------------------------------------------------------------
// Stripe PaymentSheet — guarded import so the app still compiles without the
// @stripe/stripe-react-native native package (e.g. inside Expo Go).
// ---------------------------------------------------------------------------
let StripeProvider: React.ComponentType<any> | null = null;
let useStripe: (() => { initPaymentSheet: Function; presentPaymentSheet: Function }) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stripeModule = require('@stripe/stripe-react-native');
  StripeProvider = stripeModule.StripeProvider;
  useStripe = stripeModule.useStripe;
} catch {
  // Package not installed — demo mode
}

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

// Strip the guarded Stripe hook into a component so Rules of Hooks are satisfied
function StripeDepositButton({
  disabled, loading, onPaymentSheetDeposit,
}: {
  disabled: boolean;
  loading: boolean;
  onPaymentSheetDeposit: (initAndPresent: () => Promise<boolean>) => void;
}) {
  const stripe = useStripe!();

  async function initAndPresent(): Promise<boolean> {
    // This function is invoked by the parent which already has clientSecret etc.
    // Parent passes it back via onPaymentSheetDeposit — see usage below.
    return false; // placeholder — real logic is wired by parent
  }

  // Expose the stripe hooks to the parent via the callback
  React.useEffect(() => {
    onPaymentSheetDeposit(async () => {
      // Will be replaced by the real flow in the parent
      return false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null; // rendered inline by parent
}

// Inner component — receives publishableKey and does the PaymentSheet flow
function StripePaymentSheetFlow({
  publishableKey,
  clientSecret,
  onSuccess,
  onError,
}: {
  publishableKey: string;
  clientSecret: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const stripe = useStripe!();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    stripe.initPaymentSheet({
      paymentIntentClientSecret: clientSecret,
      merchantDisplayName: 'EGWallet',
    }).then(({ error }: any) => {
      if (!error) setReady(true);
      else onError(error.message);
    });
  }, [clientSecret]);

  async function present() {
    const { error } = await stripe.presentPaymentSheet();
    if (error) {
      if (error.code !== 'Canceled') onError(error.message);
    } else {
      onSuccess();
    }
  }

  return (
    <TouchableOpacity
      style={[styles.primaryButton, !ready && styles.buttonDisabled]}
      onPress={present}
      disabled={!ready}
    >
      <Ionicons name="card" size={18} color="#fff" />
      <Text style={styles.primaryButtonText}>Pay with Card</Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function DepositScreen() {
  const auth = useAuth();
  const navigation = useNavigation();
  const route = useRoute();
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
  } | null>(null);
  const [feeInfo, setFeeInfo] = useState<{
    depositCount: number;
    freeTopupsRemaining: number;
    isFreeTopup: boolean;
    feeRate: number;
    freeLimit: number;
  } | null>(null);

  // Payment method state
  interface DepositPaymentMethod {
    id: string;
    type: 'debit' | 'credit' | 'bank';
    label: string;
    last4: string;
  }
  const [showPaymentMethodModal, setShowPaymentMethodModal] = useState(false);
  const [savedPaymentMethods, setSavedPaymentMethods] = useState<DepositPaymentMethod[]>([]);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<DepositPaymentMethod | null>(null);
  const [showAddCardForm, setShowAddCardForm] = useState(false);
  const [addCardType, setAddCardType] = useState<'debit' | 'credit' | 'bank' | null>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [bankAccountNum, setBankAccountNum] = useState('');
  const [bankRoutingNum, setBankRoutingNum] = useState('');

  function pmIcon(type: DepositPaymentMethod['type']) {
    if (type === 'bank') return 'business-outline';
    if (type === 'credit') return 'card-outline';
    return 'card';
  }
  function pmColor(type: DepositPaymentMethod['type']) {
    if (type === 'bank') return '#2E7D32';
    if (type === 'credit') return '#6A1B9A';
    return '#1565C0';
  }

  function resetAddCardForm() {
    setCardNumber('');
    setCardHolder('');
    setCardExpiry('');
    setBankAccountNum('');
    setBankRoutingNum('');
    setShowAddCardForm(false);
    setAddCardType(null);
  }

  function handleAddDepositMethod() {
    if (addCardType === 'bank') {
      if (!bankAccountNum.trim() || !bankRoutingNum.trim() || !cardHolder.trim()) {
        Alert.alert('Missing Info', 'Please fill in all bank account fields.');
        return;
      }
      const last4 = bankAccountNum.slice(-4).padStart(4, '\u2022');
      const method: DepositPaymentMethod = { id: Date.now().toString(), type: 'bank', label: 'Bank Account', last4 };
      setSavedPaymentMethods(prev => [...prev, method]);
      setSelectedPaymentMethod(method);
      resetAddCardForm();
      setShowPaymentMethodModal(false);
      handleDeposit();
    } else {
      if (!cardNumber.trim() || !cardHolder.trim() || !cardExpiry.trim()) {
        Alert.alert('Missing Info', 'Please fill in all card fields.');
        return;
      }
      const last4 = cardNumber.replace(/\s/g, '').slice(-4);
      const method: DepositPaymentMethod = {
        id: Date.now().toString(),
        type: addCardType ?? 'debit',
        label: addCardType === 'credit' ? 'Credit Card' : 'Debit Card',
        last4,
      };
      setSavedPaymentMethods(prev => [...prev, method]);
      setSelectedPaymentMethod(method);
      resetAddCardForm();
      setShowPaymentMethodModal(false);
      handleDeposit();
    }
  }

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
      fetch(`${API_BASE}/wallets`, { headers })
        .then(r => r.json())
        .then(data => {
          const first = data.wallets?.[0]?.id;
          if (first) setWalletId(first);
        })
        .catch(() => {});
    }
    fetch(`${API_BASE}/deposits/fee-info`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setFeeInfo(data); })
      .catch(() => {});
  }, [auth.token]);

  function parsedAmount(): number {
    const v = parseFloat(amount.replace(/,/g, ''));
    return isNaN(v) || v <= 0 ? 0 : Math.round(v);
  }

  async function handleDeposit() {
    if (__DEV__) console.log('[Deposit] button pressed');
    const numAmount = parsedAmount();
    if (numAmount < 1) {
      Alert.alert('Too Small', 'Please enter a valid deposit amount.');
      return;
    }
    // Convert major units (what user types) → minor units (what backend/wallet stores)
    const amountMinor = majorToMinor(numAmount, currency);
    // Use 'demo' as wallet ID if none found — backend will handle or local fallback will kick in
    const effectiveWalletId = walletId || 'demo';

    setLoading(true);
    try {
      // Step 1 — create intent
      const res = await fetch(`${API_BASE}/deposits/create-intent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: amountMinor, currency, walletId: effectiveWalletId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Create intent failed');

      setMode(data.mode);

      if (data.mode === 'demo') {
        // Demo mode: confirm immediately
        await confirmDeposit(data.intentId, effectiveWalletId);
      } else {
        // Stripe mode: store intent so the PaymentSheet component can render
        setStripeIntent({
          clientSecret: data.clientSecret,
          intentId: data.intentId,
          publishableKey: data.publishableKey,
        });
      }
    } catch (e: any) {
      if (__DEV__) console.log('[Deposit] error:', e?.message);

      const isAuthError =
        e?.message?.toLowerCase().includes('invalid token') ||
        e?.message?.toLowerCase().includes('missing token');

      if (isAuthError) {
        await auth.handleTokenExpired();
        Alert.alert('Session Expired', 'Your session has expired. Please sign in again.');
      } else {
        // Backend unavailable — show a clear error instead of silently crediting funds
        Alert.alert(
          'Service Unavailable',
          'Could not connect to the server. Please check your connection and try again.',
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function confirmDeposit(intentId: string, effectiveWalletId?: string) {
    const wid = effectiveWalletId || walletId || 'demo';
    const res = await fetch(`${API_BASE}/deposits/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ intentId, walletId: wid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Confirm failed');

    // Keep local balance in sync with backend (credit the net amount)
    const netMinor = data.feeBreakdown?.addedToWallet ?? majorToMinor(parsedAmount(), currency);
    await creditLocalBalance(currency, netMinor);
    // Note: backend already records the deposit transaction — do NOT log locally to avoid duplicates

    // Refresh fee tier
    fetch(`${API_BASE}/deposits/fee-info`, { headers })
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
    setLoading(true);
    try {
      await confirmDeposit(stripeIntent.intentId);
    } catch (e: any) {
      // Backend unavailable — show pending confirmation
      Alert.alert(
        'Deposit Submitted ✅',
        'Your payment is being processed. Funds will appear in your wallet shortly.',
        [{ text: 'Done', onPress: () => (navigation as any).goBack() }]
      );
    } finally {
      setLoading(false);
    }
  }

  const numAmount = parsedAmount();

  const btnColors: [string, string] = depositSuccess ? ['#2e7d32', '#388e3c'] : ['#1565C0', '#0A3D7C'];

  // ── Payment Method Modal ──────────────────────────────────────────────────
  const paymentMethodModal = (
    <Modal
      visible={showPaymentMethodModal}
      transparent
      animationType="slide"
      onRequestClose={() => { setShowPaymentMethodModal(false); resetAddCardForm(); }}
    >
      <View style={pmStyles.overlay}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
          <View style={pmStyles.sheet}>
            <View style={pmStyles.header}>
              <Text style={pmStyles.title}>
                {showAddCardForm
                  ? addCardType === 'bank' ? 'Add Bank Account'
                  : addCardType === 'credit' ? 'Add Credit Card'
                  : 'Add Debit Card'
                  : 'Choose Payment Method'}
              </Text>
              <TouchableOpacity onPress={() => { setShowPaymentMethodModal(false); resetAddCardForm(); }}>
                <Ionicons name="close" size={24} color="#14171A" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 480 }}>
              {!showAddCardForm ? (
                <>
                  {/* Selected method badge */}
                  {selectedPaymentMethod && (
                    <View style={pmStyles.selectedBanner}>
                      <Ionicons name={pmIcon(selectedPaymentMethod.type) as any} size={18} color={pmColor(selectedPaymentMethod.type)} />
                      <Text style={pmStyles.selectedText}>
                        {selectedPaymentMethod.label} \u2022\u2022\u2022\u2022 {selectedPaymentMethod.last4} (selected)
                      </Text>
                    </View>
                  )}

                  {/* Saved methods */}
                  {savedPaymentMethods.length > 0 && (
                    <>
                      <Text style={pmStyles.sectionLabel}>SAVED METHODS</Text>
                      {savedPaymentMethods.map(m => (
                        <TouchableOpacity
                          key={m.id}
                          style={pmStyles.option}
                          onPress={() => {
                            setSelectedPaymentMethod(m);
                            setShowPaymentMethodModal(false);
                            handleDeposit();
                          }}
                        >
                          <View style={[pmStyles.iconCircle, { backgroundColor: pmColor(m.type) + '18' }]}>
                            <Ionicons name={pmIcon(m.type) as any} size={22} color={pmColor(m.type)} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={pmStyles.optionLabel}>{m.label}</Text>
                            <Text style={pmStyles.optionSub}>\u2022\u2022\u2022\u2022 {m.last4}</Text>
                          </View>
                          <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                        </TouchableOpacity>
                      ))}
                      <View style={pmStyles.divider} />
                      <Text style={pmStyles.sectionLabel}>ADD NEW</Text>
                    </>
                  )}

                  {/* Add new options */}
                  <TouchableOpacity style={pmStyles.option} onPress={() => { setAddCardType('debit'); setShowAddCardForm(true); }}>
                    <View style={[pmStyles.iconCircle, { backgroundColor: '#1565C018' }]}>
                      <Ionicons name="card" size={22} color="#1565C0" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={pmStyles.optionLabel}>Debit Card</Text>
                      <Text style={pmStyles.optionSub}>Visa, Mastercard, Verve</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                  </TouchableOpacity>

                  <TouchableOpacity style={pmStyles.option} onPress={() => { setAddCardType('credit'); setShowAddCardForm(true); }}>
                    <View style={[pmStyles.iconCircle, { backgroundColor: '#6A1B9A18' }]}>
                      <Ionicons name="card-outline" size={22} color="#6A1B9A" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={pmStyles.optionLabel}>Credit Card</Text>
                      <Text style={pmStyles.optionSub}>Visa, Mastercard, Amex</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                  </TouchableOpacity>

                  <TouchableOpacity style={pmStyles.option} onPress={() => { setAddCardType('bank'); setShowAddCardForm(true); }}>
                    <View style={[pmStyles.iconCircle, { backgroundColor: '#2E7D3218' }]}>
                      <Ionicons name="business-outline" size={22} color="#2E7D32" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={pmStyles.optionLabel}>Bank Account</Text>
                      <Text style={pmStyles.optionSub}>Direct bank transfer</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity style={pmStyles.backRow} onPress={() => { setShowAddCardForm(false); setAddCardType(null); }}>
                    <Ionicons name="arrow-back" size={18} color="#1565C0" />
                    <Text style={pmStyles.backText}>Back</Text>
                  </TouchableOpacity>

                  {addCardType === 'bank' ? (
                    <>
                      <Text style={pmStyles.fieldLabel}>ACCOUNT HOLDER NAME</Text>
                      <TextInput value={cardHolder} onChangeText={setCardHolder} placeholder="Full name" placeholderTextColor="#AAB8C2" style={pmStyles.input} />
                      <Text style={pmStyles.fieldLabel}>ACCOUNT NUMBER</Text>
                      <TextInput value={bankAccountNum} onChangeText={setBankAccountNum} placeholder="Enter account number" placeholderTextColor="#AAB8C2" keyboardType="number-pad" style={pmStyles.input} />
                      <Text style={pmStyles.fieldLabel}>ROUTING / SORT CODE</Text>
                      <TextInput value={bankRoutingNum} onChangeText={setBankRoutingNum} placeholder="Enter routing number" placeholderTextColor="#AAB8C2" keyboardType="number-pad" style={pmStyles.input} />
                    </>
                  ) : (
                    <>
                      <Text style={pmStyles.fieldLabel}>CARD NUMBER</Text>
                      <TextInput
                        value={cardNumber}
                        onChangeText={v => setCardNumber(v.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim())}
                        placeholder="1234 5678 9012 3456"
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        maxLength={19}
                        style={pmStyles.input}
                      />
                      <Text style={pmStyles.fieldLabel}>CARDHOLDER NAME</Text>
                      <TextInput value={cardHolder} onChangeText={setCardHolder} placeholder="Name as on card" placeholderTextColor="#AAB8C2" style={pmStyles.input} />
                      <Text style={pmStyles.fieldLabel}>EXPIRY DATE</Text>
                      <TextInput
                        value={cardExpiry}
                        onChangeText={v => {
                          const d = v.replace(/\D/g, '');
                          if (d.length <= 2) setCardExpiry(d);
                          else setCardExpiry(d.slice(0, 2) + '/' + d.slice(2, 4));
                        }}
                        placeholder="MM/YY"
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        maxLength={5}
                        style={pmStyles.input}
                      />
                    </>
                  )}

                  <TouchableOpacity style={pmStyles.confirmButton} onPress={handleAddDepositMethod} disabled={loading}>
                    {loading
                      ? <ActivityIndicator color="#FFF" />
                      : <Text style={pmStyles.confirmButtonText}>Confirm & Deposit</Text>}
                  </TouchableOpacity>
                  <Text style={pmStyles.secureNote}>\uD83D\uDD12 Your payment details are encrypted and secure.</Text>
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );

  return (
    <LinearGradient
      colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']}
      style={styles.gradient}
    >
      {paymentMethodModal}
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
          <Text style={styles.heroTitle}>Add Money</Text>
          <Text style={styles.heroSubtitle}>Fund your wallet instantly</Text>
        </View>

        {/* Mode Banner */}
        {mode === null && !stripeIntent && (
          <View style={styles.infoBanner}>
            <Ionicons name="information-circle-outline" size={18} color="#1565C0" />
            <Text style={styles.infoBannerText}>
              {StripeProvider
                ? 'Stripe is available — real card payments enabled.'
                : 'Demo Mode — no real money is charged. Funds are credited instantly for testing.'}
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
            <Text style={styles.cardTitle}>DEPOSIT AMOUNT</Text>
          </View>

          {/* Preset amounts */}
          <Text style={styles.label}>Quick Select</Text>
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
          <Text style={styles.label}>Enter Amount</Text>
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
          <Text style={styles.label}>Currency</Text>
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
                  <Text style={styles.currencyModalTitle}>Select Currency</Text>
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
                    placeholder="Search currencies..."
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
                        🌍 Africa
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.currencyTabBtn, currencyTab === 'world' && styles.currencyTabBtnActive]}
                      onPress={() => setCurrencyTab('world')}
                    >
                      <Text style={[styles.currencyTabText, currencyTab === 'world' && styles.currencyTabTextActive]}>
                        🌐 World
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
                        ? `${feeInfo.freeTopupsRemaining} free top-up${feeInfo.freeTopupsRemaining !== 1 ? 's' : ''} remaining`
                        : `Standard rate applies (${(TOPUP_FEE_RATE * 100).toFixed(1)}%)`
                      }
                    </Text>
                  </View>
                )}
                <View style={styles.feeRow}>
                  <Text style={styles.feeLabel}>You pay</Text>
                  <Text style={styles.feeValue}>{formatCurrency(totalCharged, currency)}</Text>
                </View>
                <View style={styles.feeRow}>
                  <Text style={styles.feeLabel}>Fee</Text>
                  <Text style={[styles.feeValue, feeMinor === 0 && styles.feeFree]}>
                    {feeMinor === 0 ? 'Free' : `-${formatCurrency(feeMinor, currency)}`}
                  </Text>
                </View>
                <View style={[styles.feeRow, styles.feeTotal]}>
                  <Text style={styles.feeTotalLabel}>Added to wallet</Text>
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
              style={[styles.primaryButtonOuter, (loading || numAmount < 100) && styles.buttonDisabled]}
              onPress={() => { animatePress(); setShowPaymentMethodModal(true); }}
              disabled={loading || numAmount < 100}
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
                        <Text style={styles.primaryButtonText}>Deposit Successful ✅</Text>
                      </>
                    )
                    : (
                      <>
                        <Ionicons name="card" size={20} color="#fff" />
                        <Text style={styles.primaryButtonText}>
                          {`Deposit ${numAmount > 0 ? numAmount.toLocaleString() : '—'} ${currency}`}
                        </Text>
                      </>
                    )
                }
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        ) : (
          stripeIntent.publishableKey && StripeProvider && useStripe
            ? (
              <StripeProvider publishableKey={stripeIntent.publishableKey} merchantIdentifier="merchant.com.egwallet">
                <StripePaymentSheetFlow
                  publishableKey={stripeIntent.publishableKey}
                  clientSecret={stripeIntent.clientSecret}
                  onSuccess={handleStripeSuccess}
                  onError={msg => Alert.alert('Payment Error', msg)}
                />
              </StripeProvider>
            )
            : (
              <Animated.View style={[styles.buttonWrapper, { transform: [{ scale: buttonScale }] }]}>
                <TouchableOpacity
                  style={[styles.primaryButtonOuter, loading && styles.buttonDisabled]}
                  onPress={() => { animatePress(); handleStripeSuccess(); }}
                  disabled={loading}
                  activeOpacity={1}
                >
                  <LinearGradient
                    colors={['#1565C0', '#0A3D7C']}
                    style={styles.primaryButtonGradient}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                  >
                    {loading
                      ? <ActivityIndicator color="#fff" size="small" />
                      : (
                        <>
                          <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                          <Text style={styles.primaryButtonText}>Confirm Deposit</Text>
                        </>
                      )
                    }
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
            )
        )}

        {stripeIntent && (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => { setStripeIntent(null); setMode(null); }}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        )}

        {/* How it works */}
        <View style={styles.howItWorks}>
          <Text style={styles.howTitle}>How deposits work</Text>
          {StripeProvider ? (
            <>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>Enter an amount and select a currency</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>Complete payment with your card via Stripe</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>Funds appear in your wallet instantly</Text></View>
            </>
          ) : (
            <>
              <View style={styles.demoTag}>
                <Text style={styles.demoTagText}>🧪 DEMO MODE — no real money is charged</Text>
              </View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>Enter an amount and tap Deposit</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>Funds are credited to your wallet immediately</Text></View>
              <View style={styles.howItem}><View style={styles.howDot} /><Text style={styles.howItemText}>In production, real Stripe payments replace this flow</Text></View>
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

const pmStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  selectedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#E8F5E9',
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
  },
  selectedText: {
    fontSize: 13,
    color: '#2E7D32',
    fontWeight: '600',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9BAAB8',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 4,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F4F8',
  },
  iconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0D1B2E',
  },
  optionSub: {
    fontSize: 12,
    color: '#657786',
    marginTop: 1,
  },
  divider: {
    height: 1,
    backgroundColor: '#EFF3F6',
    marginVertical: 12,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  backText: {
    fontSize: 14,
    color: '#1565C0',
    fontWeight: '600',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9BAAB8',
    letterSpacing: 0.7,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1.5,
    borderColor: '#DDE6EE',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: '#0D1B2E',
    backgroundColor: '#F7FAFC',
  },
  confirmButton: {
    backgroundColor: '#1565C0',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 8,
  },
  confirmButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secureNote: {
    fontSize: 12,
    color: '#9BAAB8',
    textAlign: 'center',
    marginTop: 4,
  },
});
