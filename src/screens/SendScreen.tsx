import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TextInput, Alert, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Modal, KeyboardAvoidingView, Platform, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { sendTransaction, getWalletCurrency, fetchFxQuote, FxQuote } from '../api/transactions';
import { API_BASE } from '../api/client';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { majorToMinor, minorToMajor, decimalsFor, formatCurrency, CURRENCY_INFO } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { useToast } from '../utils/toast';
import { getLocalBalances, debitLocalBalance, syncLocalBalancesFromBackend, mergeWithLocalBalances, logLocalTransaction, getPendingWithdrawals, addPendingWithdrawal, clearPendingWithdrawal } from '../utils/localBalance';
import { WITHDRAW_LOCAL_RATE, WITHDRAW_INTL_RATE, FX_CONVERSION_RATE } from '../config/fees';
import { useLanguage } from '../i18n/LanguageContext';

interface PaymentMethod {
  id: string;
  type: 'debit' | 'credit' | 'bank';
  label: string;
  last4: string;
}

// Sends are FREE; FX fee is applied on cross-currency conversion (backend)
const FEE_PERCENTAGE = 0;

export default function SendScreen() {
  const auth = useAuth();
  const { t } = useLanguage();
  const { isOnline } = useNetworkStatus();
  const toast = useToast();
  const LOCAL_CURRENCIES = ['XAF', 'XOF'];
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'transfer' | 'withdraw'>('transfer');
  const [fromWalletId, setFromWalletId] = useState<string | null>(null);
  const [toWalletId, setToWalletId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [currency, setCurrency] = useState<string>('XAF');
  const isInternational = !LOCAL_CURRENCIES.includes(currency);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [scamAcknowledged, setScamAcknowledged] = useState(false);
  const [showScamTips, setShowScamTips] = useState(false);
  
  // Withdrawal fields
  const [bankName, setBankName] = useState<string>('');
  const [accountNumber, setAccountNumber] = useState<string>('');
  const [accountName, setAccountName] = useState<string>('');
  const [withdrawalMethod, setWithdrawalMethod] = useState<'bank' | 'mobile' | 'debit' | 'credit'>('debit');
  const [isIntlWithdrawal, setIsIntlWithdrawal] = useState(false);
  const [withdrawalCardNumber, setWithdrawalCardNumber] = useState<string>('');
  const [withdrawalCardExpiry, setWithdrawalCardExpiry] = useState<string>('');
  const [withdrawalCardCvc, setWithdrawalCardCvc] = useState<string>('');

  // Payment method (for send-without-balance flow)
  const [showPaymentMethodModal, setShowPaymentMethodModal] = useState(false);
  const [savedPaymentMethods, setSavedPaymentMethods] = useState<PaymentMethod[]>([]);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod | null>(null);
  const [showAddCardForm, setShowAddCardForm] = useState(false);
  const [addCardType, setAddCardType] = useState<'debit' | 'credit' | 'bank' | null>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [bankAccountNum, setBankAccountNum] = useState('');
  const [bankRoutingNum, setBankRoutingNum] = useState('');
  
  // FX state — receiver currency preview
  const [receiverCurrency, setReceiverCurrency] = useState<string | null>(null);
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);
  const fxDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const navigation = useNavigation();

  useEffect(() => { loadWallets(); }, [auth.token]);

  // Re-sync balances (only) when screen comes back into focus — e.g. returning
  // from the Receipt screen after a withdrawal. Does NOT reset currency or
  // fromWalletId so the user's in-progress form is preserved.
  useFocusEffect(
    React.useCallback(() => {
      if (!auth.token) return;
      (async () => {
        try {
          const res = await listWallets(auth.token!);
          await syncLocalBalancesFromBackend(res.wallets || []);
          const localBalances = await getLocalBalances();
          const merged = mergeWithLocalBalances(res.wallets || [], localBalances);
          setWallets(merged);
        } catch { /* silent — stale local data is fine */ }
      })();
    }, [auth.token])
  );

  // Debounced FX lookup: when wallet ID or amount/currency changes, fetch quote
  useEffect(() => {
    if (fxDebounceRef.current) clearTimeout(fxDebounceRef.current);
    setFxQuote(null);
    setReceiverCurrency(null);
    const isAtUsername = toWalletId.trim().startsWith('@');
    if (!toWalletId.trim() || (!isAtUsername && toWalletId.length < 8) || !auth.token) return;
    fxDebounceRef.current = setTimeout(async () => {
      const toCurrency = await getWalletCurrency(auth.token!, toWalletId.trim());
      setReceiverCurrency(toCurrency);
      const amt = parseFloat(amount.replace(/,/g, ''));
      if (amt > 0 && toCurrency !== currency) {
        const amtMinor = majorToMinor(amt, currency);
        const quote = await fetchFxQuote(auth.token!, currency, toCurrency, amtMinor);
        setFxQuote(quote);
      }
    }, 500);
  }, [toWalletId, currency, amount, auth.token]);

  async function loadWallets() {
    if (!auth.token) return;
    setLoading(true);
    try {
      const res = await listWallets(auth.token);
      await syncLocalBalancesFromBackend(res.wallets || []);
      const localBalances = await getLocalBalances();
      const mergedWallets = mergeWithLocalBalances(res.wallets || [], localBalances);
      setWallets(mergedWallets);
      if (mergedWallets.length > 0) {
        setFromWalletId(mergedWallets[0].id);
        // Auto-set send currency: prefer user's preferredCurrency if they have a balance, else highest balance
        const primaryWallet = mergedWallets[0];
        const balances: Array<{currency: string; amount: number}> = primaryWallet.balances || [];
        const prefCurr = auth.user?.preferredCurrency;
        const hasPref = prefCurr && balances.find((b: any) => b.currency === prefCurr && b.amount > 0);
        if (hasPref && prefCurr) {
          setCurrency(prefCurr);
        } else {
          const sorted = [...balances].sort((a: any, b: any) => b.amount - a.amount);
          if (sorted[0]?.currency) setCurrency(sorted[0].currency);
        }
      }
    } catch (e) {
      if (__DEV__) console.warn(e);
      // Demo fallback — show a placeholder wallet so the form is usable
      const demo = { id: 'demo', balances: [{ currency: 'XAF', amount: 0 }] };
      setWallets([demo]);
      setFromWalletId('demo');
    } finally { setLoading(false); }
  }

  async function onSend() {
    if (__DEV__) console.log('[Send] Send button pressed — amount:', amount, currency, 'mode:', activeTab, 'to:', toWalletId);
    if (!auth.token) return Alert.alert(t('common.error'), t('common.notAuthenticated'));
    if (!fromWalletId) return Alert.alert(t('common.error'), t('send.selectSourceWallet'));
    const amt = parseFloat(amount.replace(/,/g, ''));
    if (!amt || amt <= 0) return Alert.alert(t('common.error'), t('send.enterValidAmount'));
    
    if (activeTab === 'transfer') {
      if (!toWalletId.trim()) return Alert.alert(t('common.error'), t('send.enterDestWalletId'));
    } else {
      // Withdrawal validation
      if (withdrawalMethod === 'debit' || withdrawalMethod === 'credit') {
        if (!withdrawalCardNumber.trim()) return Alert.alert(t('common.error'), t('send.enterCardNumber'));
        if (!withdrawalCardExpiry.trim()) return Alert.alert(t('common.error'), t('send.enterCardExpiry'));
        if (!accountName.trim()) return Alert.alert(t('common.error'), t('send.enterCardholderName'));
      } else {
        if (!bankName.trim()) return Alert.alert(t('common.error'), t('send.enterBankName'));
        if (!accountNumber.trim()) return Alert.alert(t('common.error'), t('send.enterAccountNumber'));
        if (!accountName.trim()) return Alert.alert(t('common.error'), t('send.enterAccountHolderName'));
      }
      // Bank withdrawal: warn about processing time before proceeding
      if (withdrawalMethod === 'bank') {
        return Alert.alert(
          t('send.bankWithdrawal'),
          t('send.bankWithdrawalMsg'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.continue'), onPress: () => checkBalanceAndProceed(amt) },
          ]
        );
      }
    }
    
    checkBalanceAndProceed(amt);
  }

  async function checkBalanceAndProceed(amt: number) {
    const wallet = wallets.find(w => w.id === fromWalletId);
    const balance = wallet?.balances?.find((b: any) => b.currency === currency);
    // balances are in minor units; convert to major
    const backendMajor = balance ? balance.amount / Math.pow(10, decimalsFor(currency)) : 0;
    // Also check local balance (in minor units) — use the lower value to prevent overdraft
    const localBalances = await getLocalBalances();
    const localMinor = localBalances[currency] || 0;
    const localMajor = localMinor / Math.pow(10, decimalsFor(currency));
    // Conservative: if local balance data exists, take the minimum to prevent spending stale funds
    const grossMajor = localMinor > 0 ? Math.min(backendMajor, localMajor) : backendMajor;
    // Subtract any locally tracked pending withdrawals to get true available balance
    const pendingWithdrawals = await getPendingWithdrawals();
    const pendingMinor = pendingWithdrawals[currency] || 0;
    const pendingMajor = pendingMinor / Math.pow(10, decimalsFor(currency));
    const balanceMajor = Math.max(0, grossMajor - pendingMajor);

    if (balanceMajor >= amt) {
      setScamAcknowledged(false);
      setShowConfirmation(true);
    } else {
      // Insufficient balance — direct user to add money instead of a non-functional card form
      const shortfall = (amt - balanceMajor).toFixed(2);
      Alert.alert(
        t('send.insufficientBalance'),
        t('send.insufficientBalanceMsg')
          .replace('{balance}', balanceMajor.toFixed(2))
          .replace('{currency}', currency)
          .replace('{shortfall}', shortfall),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('deposit.addMoney'), onPress: () => (navigation as any).navigate('Deposit', { walletId: fromWalletId }) },
        ]
      );
    }
  }

  function getPaymentMethodIcon(type: PaymentMethod['type']) {
    if (type === 'bank') return 'business-outline';
    if (type === 'credit') return 'card-outline';
    return 'card';
  }

  function getPaymentMethodColor(type: PaymentMethod['type']) {
    if (type === 'bank') return '#2E7D32';
    if (type === 'credit') return '#6A1B9A';
    return '#1565C0';
  }

  function handleAddPaymentMethod() {
    if (addCardType === 'bank') {
      if (!bankAccountNum.trim() || !bankRoutingNum.trim() || !cardHolder.trim()) {
        Alert.alert(t('send.missingInfo'), t('send.pleaseFillFields'));
        return;
      }
      const last4 = bankAccountNum.slice(-4).padStart(4, '•');
      const method: PaymentMethod = {
        id: Date.now().toString(),
        type: 'bank',
        label: 'Bank Account',
        last4,
      };
      const updated = [...savedPaymentMethods, method];
      setSavedPaymentMethods(updated);
      setSelectedPaymentMethod(method);
      resetAddCardForm();
      completeSendWithPaymentMethod(method);
    } else {
      if (!cardNumber.trim() || !cardHolder.trim() || !cardExpiry.trim()) {
        Alert.alert(t('send.missingInfo'), t('send.pleaseFillFields'));
        return;
      }
      const last4 = cardNumber.replace(/\s/g, '').slice(-4);
      const method: PaymentMethod = {
        id: Date.now().toString(),
        type: addCardType ?? 'debit',
        label: addCardType === 'credit' ? 'Credit Card' : 'Debit Card',
        last4,
      };
      const updated = [...savedPaymentMethods, method];
      setSavedPaymentMethods(updated);
      setSelectedPaymentMethod(method);
      resetAddCardForm();
      completeSendWithPaymentMethod(method);
    }
  }

  function resetAddCardForm() {
    setCardNumber('');
    setCardHolder('');
    setCardExpiry('');
    setCardCvc('');
    setBankAccountNum('');
    setBankRoutingNum('');
    setShowAddCardForm(false);
    setAddCardType(null);
    setShowPaymentMethodModal(false);
  }

  async function completeSendWithPaymentMethod(method: PaymentMethod) {
    if (__DEV__) console.log('[Send] completeSendWithPaymentMethod — method:', method.label);
    if (!auth.token || !fromWalletId) return Alert.alert(t('common.error'), t('common.notAuthenticated'));
    const amt = parseFloat(amount.replace(/,/g, ''));
    if (!amt || amt <= 0) return Alert.alert(t('common.error'), t('send.enterValidAmount'));
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert(t('common.error'), t('send.enterDestWalletId'));
    setLoading(true);
    try {
      const res = await sendTransaction(auth.token, fromWalletId, toWalletId, amountMinor, currency);
      await debitLocalBalance(currency, amountMinor);
      await loadWallets();
      setAmount('');
      setToWalletId('');
      setSelectedPaymentMethod(method);
      setShowPaymentMethodModal(false);
      toast.show(t('send.paymentSentToast'));
      (navigation as any).navigate('Receipt', {
        amount: amountMinor,
        currency,
        senderCurrency: currency,
        recipientName: toWalletId || 'Recipient',
        recipientId: toWalletId,
        timestamp: Date.now(),
        transactionId: (res as any)?.transaction?.id,
        type: 'send',
        status: 'completed',
      });
    } catch (e: any) {
      Alert.alert(t('send.transactionFailed'), e?.message || t('send.backendUnavailable'));
    } finally {
      setLoading(false);
    }
  }
  
  async function onWithdrawConfirmed() {
    if (__DEV__) console.log('[Send] Withdraw confirmed — currency:', currency, 'method:', withdrawalMethod);
    if (!auth.token || !fromWalletId) return;
    
    const amt = parseFloat(amount.replace(/,/g, ''));
    const amountMinor = majorToMinor(amt, currency);

    // Set loading FIRST — collapses the TOCTOU window between two rapid taps.
    // Any re-render from here disables the confirm button (disabled={loading}).
    setLoading(true);
    try {
      // Client-side balance guard — defence-in-depth; backend enforces the real check.
      const localBals = await getLocalBalances();
      const localAvailable = localBals[currency] ?? 0;
      const walletBalance = wallets[0]?.balances?.find((b: any) => b.currency === currency)?.amount ?? 0;
      const effectiveBalance = localAvailable > 0 ? localAvailable : walletBalance;
      // Subtract any already-pending local withdrawals from available balance
      const pendingWithdrawals = await getPendingWithdrawals();
      const alreadyPendingMinor = pendingWithdrawals[currency] || 0;
      const trueAvailable = Math.max(0, effectiveBalance - alreadyPendingMinor);
      // Block if insufficient — note: no short-circuit on zero (zero balance must also be blocked)
      if (amountMinor > trueAvailable) {
        Alert.alert(
          t('send.insufficientFunds'),
          t('send.insufficientFundsMsg')
            .replace('{balance}', minorToMajor(trueAvailable, currency).toFixed(2))
            .replace('{currency}', currency)
        );
        return;
      }

      // Lock funds locally before the network request (pending deduction prevents double-spend)
      await addPendingWithdrawal(currency, amountMinor);

      const response = await fetch(`${API_BASE}/withdrawals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          fromWalletId,
          amount: amountMinor,
          currency,
          method: withdrawalMethod,
          isInternational: isIntlWithdrawal,
          bankName: withdrawalMethod === 'credit' ? 'Credit Card' : withdrawalMethod === 'debit' ? 'Debit Card' : bankName,
          accountNumber: (withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? withdrawalCardNumber.replace(/\s/g, '') : accountNumber,
          accountHolderName: accountName,
          ...((withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && { cardExpiry: withdrawalCardExpiry }),
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Withdrawal failed');
      }
      
      // Debit local balance and log locally (backend stores withdrawals
      // in db.withdrawals, NOT db.transactions, so we must log here)
      await debitLocalBalance(currency, amountMinor);
      await clearPendingWithdrawal(currency, amountMinor);
      await logLocalTransaction({
        type: 'withdrawal',
        direction: 'out',
        amount: amountMinor,
        currency,
        memo: `Withdrawal to ${withdrawalMethod === 'debit' ? 'Debit Card' : withdrawalMethod === 'credit' ? 'Credit Card' : bankName}`,
      });
      const wData = await response.json();
      const feeCalc = wData.feeBreakdown;
      await loadWallets();
      setAmount('');
      setBankName('');
      setAccountNumber('');
      setAccountName('');
      setShowConfirmation(false);
      (navigation as any).navigate('Receipt', {
        amount: amountMinor,
        currency,
        senderCurrency: currency,
        fee: feeCalc?.fee ?? Math.round(amountMinor * (isIntlWithdrawal ? WITHDRAW_INTL_RATE : WITHDRAW_LOCAL_RATE)),
        feeLabel: `Withdrawal Fee (${isIntlWithdrawal ? '1.75%' : '1.28%'})`,
        recipientName: accountName || (withdrawalMethod === 'credit' ? 'Credit Card' : withdrawalMethod === 'debit' ? 'Debit Card' : bankName),
        recipientId: (withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? `Card ending ${withdrawalCardNumber.replace(/\s/g, '').slice(-4)}` : accountNumber,
        timestamp: Date.now(),
        transactionId: wData.withdrawal?.id,
        type: 'withdrawal',
        status: 'pending',
      });
    } catch (e: any) {
      // Release the pending lock on failure so user can retry
      await clearPendingWithdrawal(currency, amountMinor);
      Alert.alert(t('send.transactionFailed'), e?.message || t('send.backendUnavailable'));
      return;
    } finally {
      setLoading(false);
    }
  }

  function calculatePreview() {
    const amt = parseFloat(amount.replace(/,/g, ''));
    if (!amt || amt <= 0) return null;

    // Transfers: FREE (0 sender fee). FX fee is deducted on the received side by backend.
    // Withdrawals: fee is deducted from the sent amount.
    const feeRate = activeTab === 'withdraw'
      ? (isIntlWithdrawal ? WITHDRAW_INTL_RATE : WITHDRAW_LOCAL_RATE)
      : 0;
    const fee = amt * feeRate;
    const total = amt + (activeTab === 'withdraw' ? 0 : 0); // total deducted from wallet = amount
    const netSent = amt - fee; // amount after withdrawal fee (or same as amt for transfers)

    // FX-aware receiver amount
    const effectiveToCurrency = receiverCurrency || currency;
    const isCrossCurrency = effectiveToCurrency !== currency;

    // For transfers: FX fee (1.15%) is taken from the converted amount on receiver's side
    const fxFeeRate = isCrossCurrency && activeTab === 'transfer' ? FX_CONVERSION_RATE : 0;

    let receiverGetsMinor: number;
    if (isCrossCurrency && fxQuote) {
      // Backend quote already applies 1.15% FX fee — use receivedAmountMinorAfterFee if present
      receiverGetsMinor = (fxQuote as any).receivedAmountMinorAfterFee ?? fxQuote.receivedAmountMinor;
    } else {
      receiverGetsMinor = majorToMinor(netSent, currency);
    }

    return {
      amount: amt,
      fee,          // withdrawal fee (0 for transfers)
      feeRate,
      fxFeeRate,
      total: amt,    // wallet always debited the full entered amount
      recipientGets: netSent,
      receiverGetsMinor,
      receiverCurrency: effectiveToCurrency,
      isCrossCurrency,
      rateDisplay: fxQuote?.rateDisplay ?? null,
      fxFeeAmount: isCrossCurrency && fxQuote
        ? ((fxQuote as any).fxFeeAmount ?? Math.round(fxQuote.receivedAmountMinor * FX_CONVERSION_RATE))
        : 0,
    };
  }

  function isHighAmount(): boolean {
    const amt = parseFloat(amount.replace(/,/g, ''));
    if (!amt) return false;
    // High amount thresholds (in major currency units)
    const thresholds: Record<string, number> = {
      USD: 500,
      EUR: 500,
      GBP: 400,
      XAF: 300000,
      NGN: 200000,
      GHS: 3000,
      ZAR: 8000,
      KES: 50000,
      INR: 40000,
      CNY: 3500,
      JPY: 70000,
      BRL: 2500,
    };
    return amt >= (thresholds[currency] || 500);
  }

  async function onSendConfirmed() {
    if (__DEV__) console.log('[Send] Confirm & Send pressed — currency:', currency);
    if (!auth.token) return Alert.alert(t('common.error'), t('common.notAuthenticated'));
    if (!fromWalletId) return Alert.alert(t('common.error'), t('send.selectSourceWallet'));
    const amt = parseFloat(amount.replace(/,/g, ''));
    if (!amt || amt <= 0) return Alert.alert(t('common.error'), t('send.enterValidAmount'));
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert(t('common.error'), t('send.enterDestWalletId'));
    
    // Check scam acknowledgement for high amounts
    if (isHighAmount() && !scamAcknowledged) {
      return Alert.alert(t('send.acknowledgeRequired'), t('send.acknowledgeRequiredMsg'));
    }

    setLoading(true);
    try {
      const res = await sendTransaction(auth.token, fromWalletId, toWalletId, amountMinor, currency);
      await debitLocalBalance(currency, amountMinor);
      await loadWallets();
      setAmount('');
      setShowConfirmation(false);
      toast.show(t('send.paymentSentToast'));
      (navigation as any).navigate('Receipt', {
        amount: amountMinor,
        currency,
        senderCurrency: currency,
        receiverCurrency: preview?.receiverCurrency ?? currency,
        fee: preview?.fxFeeAmount ?? 0,
        feeLabel: preview?.isCrossCurrency ? 'FX Conversion Fee (1.15%)' : undefined,
        fxRate: preview?.rateDisplay ?? undefined,
        recipientName: toWalletId || 'Recipient',
        recipientId: toWalletId,
        timestamp: Date.now(),
        transactionId: (res as any)?.transaction?.id,
        type: 'send',
        status: 'completed',
      });
      setToWalletId('');
    } catch (e: any) {
      Alert.alert(t('send.transactionFailed'), e?.message || t('send.backendUnavailable'));
      return;
    } finally {
      setLoading(false);
    }
  }

  /** Strip commas, reformat with thousands separators. Preserves one decimal point. */
  function formatAmount(text: string): string {
    // Allow digits and at most one decimal point
    const cleaned = text.replace(/[^0-9.]/g, '');
    const parts = cleaned.split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (parts.length > 1) return intPart + '.' + parts[1];
    return intPart;
  }

  const preview = calculatePreview();
  const POPULAR_CURRENCIES = ['XAF', 'XOF', 'USD', 'EUR', 'GBP', 'NGN', 'GHS', 'ZAR', 'KES', 'MAD', 'INR', 'CNY', 'JPY', 'BRL', 'CAD', 'AUD', 'AED'];
  const CURRENCIES = Object.keys(CURRENCY_INFO).sort((a, b) => {
    const ai = POPULAR_CURRENCIES.indexOf(a);
    const bi = POPULAR_CURRENCIES.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  // Payment Method Modal (for insufficient balance flow)
  const paymentMethodModal = (
    <Modal
      visible={showPaymentMethodModal}
      transparent
      animationType="slide"
      onRequestClose={() => { setShowPaymentMethodModal(false); setShowAddCardForm(false); setAddCardType(null); }}
    >
      <View style={styles.modalOverlay}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {showAddCardForm ? (addCardType === 'bank' ? t('send.addBankAccount') : addCardType === 'credit' ? t('send.addCreditCard') : t('send.addDebitCard')) : t('send.addPaymentMethod')}
              </Text>
              <TouchableOpacity onPress={() => { setShowPaymentMethodModal(false); setShowAddCardForm(false); setAddCardType(null); }}>
                <Ionicons name="close" size={24} color="#14171A" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalScroll}>
              {!showAddCardForm ? (
                <>
                  {/* Insufficient balance banner */}
                  <View style={styles.insufficientBanner}>
                    <Ionicons name="information-circle" size={20} color="#1565C0" />
                    <Text style={styles.insufficientText}>
                      {t('send.insufficientBanner')}
                    </Text>
                  </View>

                  {/* Saved methods */}
                  {savedPaymentMethods.length > 0 && (
                    <>
                      <Text style={styles.pmSectionLabel}>{t('send.savedMethods')}</Text>
                      {savedPaymentMethods.map(method => (
                        <TouchableOpacity
                          key={method.id}
                          style={styles.pmOption}
                          onPress={() => { setSelectedPaymentMethod(method); setShowPaymentMethodModal(false); completeSendWithPaymentMethod(method); }}
                        >
                          <View style={[styles.pmIconCircle, { backgroundColor: getPaymentMethodColor(method.type) + '18' }]}>
                            <Ionicons name={getPaymentMethodIcon(method.type) as any} size={22} color={getPaymentMethodColor(method.type)} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.pmLabel}>{method.label}</Text>
                            <Text style={styles.pmSub}>•••• {method.last4}</Text>
                          </View>
                          <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                        </TouchableOpacity>
                      ))}
                      <View style={styles.pmDivider} />
                      <Text style={styles.pmSectionLabel}>{t('send.addNew')}</Text>
                    </>
                  )}

                  {/* Add new method options */}
                  <TouchableOpacity style={styles.pmOption} onPress={() => { setAddCardType('debit'); setShowAddCardForm(true); }}>
                    <View style={[styles.pmIconCircle, { backgroundColor: '#1565C018' }]}>
                      <Ionicons name="card" size={22} color="#1565C0" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pmLabel}>{t('send.addDebitCard')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.pmOption} onPress={() => { setAddCardType('credit'); setShowAddCardForm(true); }}>
                    <View style={[styles.pmIconCircle, { backgroundColor: '#6A1B9A18' }]}>
                      <Ionicons name="card-outline" size={22} color="#6A1B9A" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pmLabel}>{t('send.addCreditCard')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.pmOption} onPress={() => { setAddCardType('bank'); setShowAddCardForm(true); }}>
                    <View style={[styles.pmIconCircle, { backgroundColor: '#2E7D3218' }]}>
                      <Ionicons name="business-outline" size={22} color="#2E7D32" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pmLabel}>{t('send.addBankAccount')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity style={styles.pmBackRow} onPress={() => { setShowAddCardForm(false); setAddCardType(null); }}>
                    <Ionicons name="arrow-back" size={18} color="#1565C0" />
                    <Text style={styles.pmBackText}>{t('deposit.back')}</Text>
                  </TouchableOpacity>

                  {addCardType === 'bank' ? (
                    <>
                      <Text style={styles.pmFormLabel}>{t('deposit.accountHolderName')}</Text>
                      <TextInput
                        value={cardHolder}
                        onChangeText={setCardHolder}
                        placeholder={t('deposit.fullName')}
                        placeholderTextColor="#AAB8C2"
                        style={styles.pmInput}
                      />
                      <Text style={styles.pmFormLabel}>{t('deposit.accountNumber')}</Text>
                      <TextInput
                        value={bankAccountNum}
                        onChangeText={setBankAccountNum}
                        placeholder={t('deposit.enterAccountNum')}
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        style={styles.pmInput}
                      />
                      <Text style={styles.pmFormLabel}>{t('deposit.routingCode')}</Text>
                      <TextInput
                        value={bankRoutingNum}
                        onChangeText={setBankRoutingNum}
                        placeholder={t('deposit.enterRoutingNum')}
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        style={styles.pmInput}
                      />
                    </>
                  ) : (
                    <>
                      <Text style={styles.pmFormLabel}>{t('deposit.cardNumber')}</Text>
                      <TextInput
                        value={cardNumber}
                        onChangeText={v => setCardNumber(v.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim())}
                        placeholder="1234 5678 9012 3456"
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        maxLength={19}
                        style={styles.pmInput}
                      />
                      <Text style={styles.pmFormLabel}>{t('deposit.cardholderName')}</Text>
                      <TextInput
                        value={cardHolder}
                        onChangeText={setCardHolder}
                        placeholder={t('deposit.nameAsOnCard')}
                        placeholderTextColor="#AAB8C2"
                        style={styles.pmInput}
                      />
                      <Text style={styles.pmFormLabel}>{t('deposit.expiryDate')}</Text>
                      <TextInput
                        value={cardExpiry}
                        onChangeText={v => {
                          const digits = v.replace(/\D/g, '');
                          if (digits.length <= 2) setCardExpiry(digits);
                          else setCardExpiry(digits.slice(0, 2) + '/' + digits.slice(2, 4));
                        }}
                        placeholder="MM/YY"
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        maxLength={5}
                        style={styles.pmInput}
                      />
                    </>
                  )}

                  <TouchableOpacity style={styles.pmConfirmButton} onPress={handleAddPaymentMethod} disabled={loading}>
                    {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.pmConfirmButtonText}>{t('send.payNow')}</Text>}
                  </TouchableOpacity>
                  <Text style={styles.pmSecureNote}>{t('deposit.secureNote')}</Text>
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );

  // Scam Tips Modal
  const scamTipsModal = (
    <Modal
      visible={showScamTips}
      transparent
      animationType="slide"
      onRequestClose={() => setShowScamTips(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>🚨 {t('send.scamWarningSigns')}</Text>
            <TouchableOpacity onPress={() => setShowScamTips(false)}>
              <Ionicons name="close" size={24} color="#14171A" />
            </TouchableOpacity>
          </View>
          
          <ScrollView style={styles.modalScroll}>
            <View style={styles.tipItem}>
              <Ionicons name="alert-circle" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>{t('send.scamTip1Title')}</Text>
                <Text style={styles.tipText}>{t('send.scamTip1Text')}</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="heart-dislike" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>{t('send.scamTip2Title')}</Text>
                <Text style={styles.tipText}>{t('send.scamTip2Text')}</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="trophy" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>{t('send.scamTip3Title')}</Text>
                <Text style={styles.tipText}>{t('send.scamTip3Text')}</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="shield-checkmark" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>{t('send.scamTip4Title')}</Text>
                <Text style={styles.tipText}>{t('send.scamTip4Text')}</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="card" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>{t('send.scamTip5Title')}</Text>
                <Text style={styles.tipText}>{t('send.scamTip5Text')}</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="hand-left" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>{t('send.scamTip6Title')}</Text>
                <Text style={styles.tipText}>{t('send.scamTip6Text')}</Text>
              </View>
            </View>
            
            <View style={styles.safetyBox}>
              <Ionicons name="checkmark-circle" size={24} color="#2E7D32" />
              <Text style={styles.safetyText}>
                <Text style={styles.safetyBold}>{t('send.staySafe')}</Text> {t('send.staySafeText')}
              </Text>
            </View>
          </ScrollView>
          
          <TouchableOpacity 
            style={styles.modalCloseButton} 
            onPress={() => setShowScamTips(false)}
          >
            <Text style={styles.modalCloseText}>{t('common.gotIt')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // Confirmation screen
  if (showConfirmation && preview) {
    return (
      <View style={styles.container}>
        {scamTipsModal}
        {paymentMethodModal}
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.confirmHeader}>
            <Text style={styles.confirmTitle}>{activeTab === 'transfer' ? t('send.reviewTransaction') : t('send.reviewWithdrawal')}</Text>
          <Text style={styles.confirmSubtitle}>{t('send.confirmDetails')}</Text>
            {selectedPaymentMethod && (
              <View style={styles.pmBadge}>
                <Ionicons name={getPaymentMethodIcon(selectedPaymentMethod.type) as any} size={14} color="#1565C0" />
                <Text style={styles.pmBadgeText}>
                  {t('send.payingFrom')}: {selectedPaymentMethod.label} •••• {selectedPaymentMethod.last4}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t('send.fromWallet')}</Text>
              <Text style={styles.summaryValue}>{fromWalletId?.substring(0, 12)}...</Text>
            </View>
            {activeTab === 'transfer' ? (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('send.toWallet')}</Text>
                <Text style={styles.summaryValue}>{toWalletId.substring(0, 12)}...</Text>
              </View>
            ) : (withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('card.number')}</Text>
                  <Text style={styles.summaryValue}>•••• •••• •••• {withdrawalCardNumber.replace(/\s/g, '').slice(-4)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('card.expiry')}</Text>
                  <Text style={styles.summaryValue}>{withdrawalCardExpiry}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('send.cardholder')}</Text>
                  <Text style={styles.summaryValue}>{accountName}</Text>
                </View>
              </>
            ) : (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{withdrawalMethod === 'bank' ? t('send.bankWithdrawal') : t('send.mobileOperator')}</Text>
                  <Text style={styles.summaryValue}>{bankName}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{withdrawalMethod === 'bank' ? t('send.accountLabel') : t('send.phoneLabel')}</Text>
                  <Text style={styles.summaryValue}>{accountNumber}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('send.name')}</Text>
                  <Text style={styles.summaryValue}>{accountName}</Text>
                </View>
              </>
            )}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t('common.currency')}</Text>
              <Text style={styles.summaryValueBold}>{currency}</Text>
            </View>
          </View>

          <View style={styles.amountCard}>
            {/* You send / You withdraw */}
            <View style={styles.amountRow}>
              <Text style={styles.amountLabel}>{activeTab === 'withdraw' ? t('send.youWithdraw') : t('send.youSend')}</Text>
              <Text style={styles.amountValue}>{formatCurrency(majorToMinor(preview.amount, currency), currency)}</Text>
            </View>
            {/* Sender / Your currency */}
            <View style={styles.amountRow}>
              <Text style={styles.amountLabel}>{activeTab === 'withdraw' ? t('send.yourCurrency') : t('send.senderCurrency')}</Text>
              <Text style={styles.amountLabel}>{currency}</Text>
            </View>
            {activeTab === 'withdraw' && preview.fee > 0 && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>
                  {preview.feeRate ? `${t('send.withdrawalFee')} (${(preview.feeRate * 100).toFixed(2)}%)` : t('send.withdrawalFee')}
                  {isIntlWithdrawal ? ` · ${t('send.international')}` : ` · ${t('send.local')}`}
                </Text>
                <Text style={styles.feeValue}>-{formatCurrency(majorToMinor(preview.fee, currency), currency)}</Text>
              </View>
            )}
            {activeTab === 'transfer' && preview.isCrossCurrency && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>{t('send.fxConversionFee')}</Text>
                <Text style={styles.feeValue}>-{formatCurrency(preview.fxFeeAmount, preview.receiverCurrency)}</Text>
              </View>
            )}
            {activeTab === 'transfer' && !preview.isCrossCurrency && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>{t('send.transferFee')}</Text>
                <Text style={[styles.feeValue, { color: '#2E7D32' }]}>{t('send.free')}</Text>
              </View>
            )}
            {/* FX rate */}
            {preview.isCrossCurrency && preview.rateDisplay && (
              <View style={styles.amountRow}>
                <Text style={[styles.amountLabel, { color: '#7C3AED', fontSize: 12 }]}>{t('send.fxRate')}</Text>
                <Text style={[styles.amountLabel, { color: '#7C3AED', fontSize: 12 }]}>{preview.rateDisplay}</Text>
              </View>
            )}
            {/* Recipient currency */}
            {preview.isCrossCurrency && (
              <View style={styles.amountRow}>
                <Text style={[styles.amountLabel, { color: '#7C3AED' }]}>{t('send.recipientCurrency')}</Text>
                <Text style={[styles.amountLabel, { color: '#7C3AED' }]}>{preview.receiverCurrency}</Text>
              </View>
            )}
            {/* They receive / You receive — total row */}
            <View style={[styles.amountRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>{activeTab === 'withdraw' ? t('send.youReceive') : t('send.theyReceive')}</Text>
              <Text style={styles.totalValue}>
                {formatCurrency(preview.receiverGetsMinor, preview.receiverCurrency)}
              </Text>
            </View>
            {/* Total charged from wallet */}
            <View style={[styles.amountRow, { borderTopWidth: 1, borderTopColor: '#E8F0FC', marginTop: 4, paddingTop: 10 }]}>
              <Text style={[styles.amountLabel, { fontWeight: '700', color: '#0D1B2E' }]}>{t('send.totalCharged')}</Text>
              <Text style={[styles.amountValue, { color: '#0D1B2E' }]}>{formatCurrency(majorToMinor(preview.amount, currency), currency)}</Text>
            </View>
          </View>

          <View style={styles.infoBox}>
            <Text style={styles.infoText}>
              {activeTab === 'withdraw'
                ? `ℹ️ ${isIntlWithdrawal ? 'International' : 'Local'} ${t('send.withdrawalFeeInfo')}: ${isIntlWithdrawal ? t('send.intlFeeHint') : t('send.localFeeHint')} deducted from the amount.`
                : preview.isCrossCurrency
                  ? `ℹ️ ${t('send.fxFeeInfo')} is deducted from the converted amount (${preview.receiverCurrency}).`
                  : t('send.sameCurrencyFree')
              }
            </Text>
          </View>

          {/* Scam Warning */}
          <View style={styles.scamWarning}>
            <View style={styles.scamWarningHeader}>
              <Ionicons name="warning" size={20} color="#D32F2F" />
              <Text style={styles.scamWarningTitle}>{t('send.scamWarning')}</Text>
            </View>
            <Text style={styles.scamWarningText}>
              {t('send.scamWarningText')}
            </Text>
            <TouchableOpacity 
              style={styles.learnMoreButton}
              onPress={() => setShowScamTips(true)}
            >
              <Text style={styles.learnMoreText}>{t('send.learnScamSigns')}</Text>
              <Ionicons name="chevron-forward" size={16} color="#1565C0" />
            </TouchableOpacity>
          </View>

          {/* Scam Acknowledgement Checkbox */}
          {isHighAmount() && (
            <TouchableOpacity 
              style={styles.checkboxContainer}
              onPress={() => setScamAcknowledged(!scamAcknowledged)}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, scamAcknowledged && styles.checkboxChecked]}>
                {scamAcknowledged && (
                  <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                )}
              </View>
              <Text style={styles.checkboxLabel}>
                {t('send.scamAcknowledge')}
              </Text>
            </TouchableOpacity>
          )}

          <View style={styles.buttonContainer}>
            <TouchableOpacity 
              style={[styles.button, styles.cancelButton]} 
              onPress={() => setShowConfirmation(false)}
              disabled={loading}
            >
              <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[
                styles.button, 
                styles.confirmButton,
                (loading || (isHighAmount() && !scamAcknowledged)) && styles.confirmButtonDisabled
              ]} 
              onPress={activeTab === 'transfer' ? onSendConfirmed : onWithdrawConfirmed}
              disabled={loading || (isHighAmount() && !scamAcknowledged)}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.confirmButtonText}>{activeTab === 'withdraw' ? t('send.confirmWithdrawal') : t('send.confirmAndSend')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => loadWallets()} />
      {scamTipsModal}
      {paymentMethodModal}
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('send.title')}</Text>
          <Text style={styles.subtitle}>{activeTab === 'transfer' ? t('send.transferSubtitle') : t('send.withdrawSubtitle')}</Text>
        </View>

        {/* Tab Switcher */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'transfer' && styles.tabActive]}
            onPress={() => setActiveTab('transfer')}
          >
            <Ionicons name="send" size={18} color={activeTab === 'transfer' ? '#1565C0' : '#657786'} />
            <Text style={[styles.tabText, activeTab === 'transfer' && styles.tabTextActive]}>{t('send.transfer')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'withdraw' && styles.tabActive]}
            onPress={() => setActiveTab('withdraw')}
          >
            <Ionicons name="cash-outline" size={18} color={activeTab === 'withdraw' ? '#1565C0' : '#657786'} />
            <Text style={[styles.tabText, activeTab === 'withdraw' && styles.tabTextActive]}>{t('wallet.withdraw')}</Text>
          </TouchableOpacity>
        </View>

        {loading && wallets.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#1565C0" />
            <Text style={styles.loadingText}>{t('send.loadingWallets')}</Text>
          </View>
        ) : (
          <>
            <View style={styles.section}>
              <Text style={styles.label}>{t('send.fromWallet')}</Text>
              {wallets.length === 0 ? (
                <View style={styles.emptyWallet}>
                  <Text style={styles.emptyWalletText}>{t('send.demoWallet')} (XAF 0.00)</Text>
                </View>
              ) : (
                <View style={styles.walletSelector}>
                  {wallets.map(w => (
                    <TouchableOpacity
                      key={w.id}
                      onPress={() => setFromWalletId(w.id)}
                      style={[
                        styles.walletOption,
                        fromWalletId === w.id && styles.walletOptionSelected
                      ]}
                    >
                      <Text style={[
                        styles.walletOptionText,
                        fromWalletId === w.id && styles.walletOptionTextSelected
                      ]}>
                        {w.id.substring(0, 12)}...
                      </Text>
                      {(() => {
                        const bal = (w.balances || []).find((b: any) => b.currency === currency);
                        return (
                          <Text style={{ fontSize: 13, color: fromWalletId === w.id ? '#1565C0' : '#5C6E8A', marginTop: 3 }}>
                            {bal ? formatCurrency(bal.amount, currency) : `${currency} 0.00`}
                          </Text>
                        );
                      })()}
                      <TouchableOpacity
                        onPress={() => Share.share({ message: `My EGWallet ID: ${w.id}`, title: 'Share Wallet ID' })}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ marginTop: 6, alignSelf: 'flex-start' }}
                      >
                        <Ionicons name="share-social-outline" size={18} color={fromWalletId === w.id ? '#1565C0' : '#9BAEC8'} />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {activeTab === 'transfer' ? (
              <>
                <View style={styles.section}>
                  <Text style={styles.label}>{t('send.recipient')}</Text>
                  <TextInput
                    value={toWalletId}
                    onChangeText={setToWalletId}
                    placeholder={t('send.recipientPlaceholder')}
                    placeholderTextColor="#AAB8C2"
                    autoCapitalize="none"
                    editable={!loading}
                    style={styles.input}
                  />
                </View>
              </>
            ) : (
              <>
                {/* Available / Pending Balance Banner */}
                {(() => {
                  const w = wallets.find(x => x.id === fromWalletId);
                  const bal = (w?.balances || []).find((b: any) => b.currency === currency);
                  const availableMinor = bal?.amount ?? 0;
                  const pendingMinor: number = w?.holdBalance?.[currency] ?? 0;
                  if (!w) return null;
                  return (
                    <View style={styles.balanceSummaryBanner}>
                      <View style={styles.balanceSummaryRow}>
                        <Text style={styles.balanceSummaryLabel}>{t('send.availableToWithdraw')}</Text>
                        <Text style={styles.balanceSummaryValue}>{formatCurrency(availableMinor, currency)}</Text>
                      </View>
                      {pendingMinor > 0 && (
                        <View style={styles.balanceSummaryRow}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="time-outline" size={13} color="#E65100" />
                            <Text style={[styles.balanceSummaryLabel, { color: '#E65100' }]}>{t('send.pendingWithdrawal')}</Text>
                          </View>
                          <Text style={[styles.balanceSummaryValue, { color: '#E65100' }]}>-{formatCurrency(pendingMinor, currency)}</Text>
                        </View>
                      )}
                    </View>
                  );
                })()}
                <View style={styles.section}>
                  <Text style={styles.label}>{t('send.withdrawalMethod')}</Text>
                  <View style={styles.methodSelector}>
                    <TouchableOpacity
                      style={[styles.methodOption, withdrawalMethod === 'debit' && styles.methodOptionActive]}
                      onPress={() => setWithdrawalMethod('debit')}
                    >
                      <Ionicons name="card" size={20} color={withdrawalMethod === 'debit' ? '#1565C0' : '#657786'} />
                      <Text style={[styles.methodText, withdrawalMethod === 'debit' && styles.methodTextActive]}>{t('send.debitCard')}</Text>
                      <Text style={styles.methodBadge}>{t('send.instant')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.methodOption, withdrawalMethod === 'credit' && styles.methodOptionActive]}
                      onPress={() => setWithdrawalMethod('credit')}
                    >
                      <Ionicons name="card-outline" size={20} color={withdrawalMethod === 'credit' ? '#1565C0' : '#657786'} />
                      <Text style={[styles.methodText, withdrawalMethod === 'credit' && styles.methodTextActive]}>{t('send.creditCard')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.methodOption, withdrawalMethod === 'bank' && styles.methodOptionActive]}
                      onPress={() => setWithdrawalMethod('bank')}
                    >
                      <Ionicons name="business" size={20} color={withdrawalMethod === 'bank' ? '#1565C0' : '#657786'} />
                      <Text style={[styles.methodText, withdrawalMethod === 'bank' && styles.methodTextActive]}>{t('send.bank')}</Text>
                      <Text style={styles.methodBadgeSlow}>{t('send.bankDays')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.methodOption, withdrawalMethod === 'mobile' && styles.methodOptionActive]}
                      onPress={() => setWithdrawalMethod('mobile')}
                    >
                      <Ionicons name="phone-portrait" size={20} color={withdrawalMethod === 'mobile' ? '#1565C0' : '#657786'} />
                      <Text style={[styles.methodText, withdrawalMethod === 'mobile' && styles.methodTextActive]}>{t('send.mobileMoney')}</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* International withdrawal toggle */}
                <View style={styles.section}>
                  <TouchableOpacity
                    style={styles.intlToggle}
                    onPress={() => setIsIntlWithdrawal(v => !v)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.intlToggleBox, isIntlWithdrawal && styles.intlToggleBoxActive]}>
                      {isIntlWithdrawal && <Ionicons name="checkmark" size={14} color="#fff" />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.intlToggleLabel}>{t('send.internationalWithdrawal')}</Text>
                      <Text style={styles.intlToggleHint}>
                        {isIntlWithdrawal
                          ? t('send.intlFeeHint')
                          : t('send.localFeeHint')}
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>

                {(withdrawalMethod === 'debit' || withdrawalMethod === 'credit') ? (
                  <>
                    <View style={styles.section}>
                      <Text style={styles.label}>{t('card.number')}</Text>
                      <TextInput
                        value={withdrawalCardNumber}
                        onChangeText={v => setWithdrawalCardNumber(v.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim())}
                        placeholder="1234 5678 9012 3456"
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        maxLength={19}
                        editable={!loading}
                        style={styles.input}
                      />
                    </View>
                    <View style={styles.section}>
                      <Text style={styles.label}>{t('send.expiryDate')}</Text>
                      <TextInput
                        value={withdrawalCardExpiry}
                        onChangeText={v => {
                          const digits = v.replace(/\D/g, '');
                          if (digits.length <= 2) setWithdrawalCardExpiry(digits);
                          else setWithdrawalCardExpiry(digits.slice(0, 2) + '/' + digits.slice(2, 4));
                        }}
                        placeholder="MM/YY"
                        placeholderTextColor="#AAB8C2"
                        keyboardType="number-pad"
                        maxLength={5}
                        editable={!loading}
                        style={styles.input}
                      />
                    </View>
                    <View style={styles.section}>
                      <Text style={styles.label}>{t('send.cardholderName')}</Text>
                      <TextInput
                        value={accountName}
                        onChangeText={setAccountName}
                        placeholder={t('deposit.nameAsOnCard')}
                        placeholderTextColor="#AAB8C2"
                        editable={!loading}
                        style={styles.input}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.section}>
                      <Text style={styles.label}>{withdrawalMethod === 'bank' ? t('send.bankWithdrawal') : t('send.mobileOperator')}</Text>
                      <TextInput
                        value={bankName}
                        onChangeText={setBankName}
                        placeholder={withdrawalMethod === 'bank' ? 'Enter bank name' : 'e.g., MTN, Orange'}
                        placeholderTextColor="#AAB8C2"
                        editable={!loading}
                        style={styles.input}
                      />
                    </View>

                    <View style={styles.section}>
                      <Text style={styles.label}>{withdrawalMethod === 'bank' ? t('send.accountLabel') : t('send.phoneLabel')}</Text>
                      <TextInput
                        value={accountNumber}
                        onChangeText={setAccountNumber}
                        placeholder={withdrawalMethod === 'bank' ? 'Enter account number' : 'Enter mobile number'}
                        placeholderTextColor="#AAB8C2"
                        keyboardType={withdrawalMethod === 'mobile' ? 'phone-pad' : 'default'}
                        editable={!loading}
                        style={styles.input}
                      />
                    </View>

                    <View style={styles.section}>
                      <Text style={styles.label}>{t('send.accountHolderName')}</Text>
                      <TextInput
                        value={accountName}
                        onChangeText={setAccountName}
                        placeholder="Full name as on account"
                        placeholderTextColor="#AAB8C2"
                        editable={!loading}
                        style={styles.input}
                      />
                    </View>
                  </>
                )}
              </>
            )}

            <View style={styles.section}>
              <Text style={styles.label}>{t('send.amount')}</Text>
              <View style={styles.amountInputContainer}>
                <TextInput
                  value={amount}
                  onChangeText={v => setAmount(formatAmount(v))}
                  placeholder="0.00"
                  placeholderTextColor="#AAB8C2"
                  keyboardType="decimal-pad"
                  editable={!loading}
                  style={styles.amountInput}
                />
                <View style={styles.currencyBadge}>
                  <Text style={styles.currencyBadgeText}>{currency}</Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>{t('send.sendCurrency')}</Text>

              {/* Wallet balance currencies — shown as chips with amounts */}
              {(() => {
                const wallet = wallets.find(w => w.id === fromWalletId);
                const ownedBalances = (wallet?.balances || [])
                  .filter((b: any) => b.amount > 0)
                  .sort((a: any, z: any) => z.amount - a.amount);
                if (ownedBalances.length === 0) return null;
                return (
                  <View style={{ marginBottom: 10 }}>
                    <Text style={{ fontSize: 11, color: '#9BAEC8', marginBottom: 6 }}>{t('send.yourBalances')}</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      {ownedBalances.map((b: any) => (
                        <TouchableOpacity
                          key={b.currency}
                          onPress={() => setCurrency(b.currency)}
                          style={[styles.balanceChip, currency === b.currency && styles.balanceChipActive]}
                        >
                          <Text style={[styles.balanceChipCurrency, currency === b.currency && styles.balanceChipCurrencyActive]}>
                            {b.currency}
                          </Text>
                          <Text style={[styles.balanceChipAmount, currency === b.currency && styles.balanceChipAmountActive]}>
                            {formatCurrency(b.amount, b.currency)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                );
              })()}

              {/* "Send in a different currency" expander */}
              <TouchableOpacity
                onPress={() => setShowAllCurrencies(v => !v)}
                style={{ flexDirection: 'row', alignItems: 'center', marginBottom: showAllCurrencies ? 8 : 0 }}
                activeOpacity={0.7}
              >
                <Ionicons name={showAllCurrencies ? 'chevron-up' : 'chevron-down'} size={14} color="#1565C0" style={{ marginRight: 4 }} />
                <Text style={{ fontSize: 12, color: '#1565C0', fontWeight: '600' }}>
                  {showAllCurrencies ? t('send.hideCurrencies') : t('send.sendInDifferentCurrency')}
                </Text>
              </TouchableOpacity>
              {showAllCurrencies && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.currencyScroll, { marginTop: 4 }]}>
                  {CURRENCIES.filter(c => {
                    const wallet = wallets.find(w => w.id === fromWalletId);
                    const ownedCurrencies = (wallet?.balances || []).filter((b: any) => b.amount > 0).map((b: any) => b.currency);
                    return !ownedCurrencies.includes(c);
                  }).map(c => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => { setCurrency(c); setShowAllCurrencies(false); }}
                      style={[styles.currencyButton, currency === c && styles.currencyButtonActive]}
                    >
                      <Text style={[styles.currencyButtonText, currency === c && styles.currencyButtonTextActive]}>
                        {c}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>

            {isInternational && activeTab === 'transfer' && (
              <View style={styles.intlBadge}>
                <Text style={styles.intlBadgeText}>{t('send.internationalTransfer')}</Text>
              </View>
            )}

            {/* Live FX conversion preview: You send X → They receive Y */}
            {activeTab === 'transfer' && receiverCurrency && parseFloat(amount.replace(/,/g, '')) > 0 && (
              <View style={styles.fxPreviewCard}>
                <View style={styles.fxPreviewRow}>
                  <View style={styles.fxPreviewItem}>
                    <Text style={styles.fxPreviewLabel}>{t('send.youSend')}</Text>
                    <Text style={styles.fxPreviewAmountText}>
                      {formatCurrency(majorToMinor(parseFloat(amount.replace(/,/g, '')), currency), currency)}
                    </Text>
                    <Text style={styles.fxPreviewCurr}>{currency}</Text>
                  </View>
                  <Ionicons name="arrow-forward-circle" size={30} color="#7C3AED" />
                  <View style={styles.fxPreviewItem}>
                    <Text style={styles.fxPreviewLabel}>{t('send.theyReceive')}</Text>
                    <Text style={[styles.fxPreviewAmountText, { color: '#2E7D32' }]}>
                      {preview?.isCrossCurrency && fxQuote
                        ? formatCurrency((fxQuote as any).receivedAmountMinorAfterFee ?? fxQuote.receivedAmountMinor, receiverCurrency)
                        : formatCurrency(majorToMinor(parseFloat(amount.replace(/,/g, '')) || 0, currency), receiverCurrency)
                      }
                    </Text>
                    <Text style={styles.fxPreviewCurr}>{receiverCurrency}</Text>
                  </View>
                </View>
                {preview?.isCrossCurrency ? (
                  <Text style={styles.fxPreviewNote}>
                    {preview.rateDisplay ? `${t('send.fxRateLabel')}: ${preview.rateDisplay}  ·  ` : ''}{t('send.fxFeeIncluded')}
                  </Text>
                ) : (
                  <Text style={styles.fxPreviewNote}>{t('send.noConversionFee')}</Text>
                )}
              </View>
            )}

            <View style={styles.infoBox}>
              <Text style={styles.infoText}>
                {activeTab === 'withdraw'
                  ? `ℹ️ ${t('send.intlFeeHint')}${isIntlWithdrawal ? ' (international)' : ` — ${t('send.withdrawalFeeInfo')}`}`
                  : t('send.transferFreeInfo')
                }
              </Text>
            </View>

            {/* Scam Warning Banner on Send Screen */}
            <View style={styles.scamBanner}>
              <View style={styles.scamBannerHeader}>
                <Ionicons name="shield-checkmark" size={18} color="#D32F2F" />
                <Text style={styles.scamBannerTitle}>{t('send.scamWarning')}</Text>
              </View>
              <Text style={styles.scamBannerText}>
                {t('send.scamWarningBody')}
              </Text>
            </View>

            <TouchableOpacity
              style={[
                styles.sendButton, 
                (
                  !amount || 
                  loading || 
                  !isOnline || 
                  (activeTab === 'transfer' && !toWalletId) ||
                  (activeTab === 'withdraw' && withdrawalMethod !== 'debit' && withdrawalMethod !== 'credit' && (!bankName || !accountNumber || !accountName)) ||
                  (activeTab === 'withdraw' && (withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && (!withdrawalCardNumber || !withdrawalCardExpiry || !accountName))
                ) && styles.sendButtonDisabled
              ]}
              onPress={onSend}
              disabled={
                !amount || 
                loading || 
                !isOnline || 
                (activeTab === 'transfer' && !toWalletId) ||
                (activeTab === 'withdraw' && withdrawalMethod !== 'debit' && withdrawalMethod !== 'credit' && (!bankName || !accountNumber || !accountName)) ||
                (activeTab === 'withdraw' && (withdrawalMethod === 'debit' || withdrawalMethod === 'credit') && (!withdrawalCardNumber || !withdrawalCardExpiry || !accountName))
              }
            >
              <Text style={styles.sendButtonText}>
                {activeTab === 'transfer' ? t('send.reviewTransaction') : t('send.reviewWithdrawal')}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#EBF4FE',
  },
  scrollContent: {
    padding: 20,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0D1B2E',
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#5C6E8A',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    padding: 4,
    marginBottom: 24,
    gap: 4,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 10,
    elevation: 2,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    gap: 6,
  },
  tabActive: {
    backgroundColor: '#1565C0',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#5C6E8A',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  methodSelector: {
    flexDirection: 'row',
    gap: 8,
  },
  methodOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.15)',
    gap: 8,
  },
  methodOptionActive: {
    borderColor: '#1565C0',
    backgroundColor: '#DBEAFE',
  },
  methodText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#5C6E8A',
  },
  methodTextActive: {
    color: '#1565C0',
  },
  methodBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: '#2E7D32',
    backgroundColor: '#E8F5E9',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  methodBadgeSlow: {
    fontSize: 10,
    fontWeight: '700',
    color: '#E65100',
    backgroundColor: '#FFF3E0',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  balanceSummaryBanner: {
    backgroundColor: '#EEF4FF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.18)',
    marginHorizontal: 4,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
  },
  balanceSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  balanceSummaryLabel: {
    fontSize: 13,
    color: '#5C6E8A',
    fontWeight: '500',
  },
  balanceSummaryValue: {
    fontSize: 13,
    color: '#1565C0',
    fontWeight: '700',
  },
  intlToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(21,101,192,0.06)',
    borderRadius: 12,
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.15)',
  },
  intlToggleBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#AAB8C2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  intlToggleBoxActive: {
    backgroundColor: '#1565C0',
    borderColor: '#1565C0',
  },
  intlToggleLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0D1B2E',
    marginBottom: 2,
  },
  intlToggleHint: {
    fontSize: 12,
    color: '#657786',
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#5C6E8A',
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#5C6E8A',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  walletSelector: {
    gap: 8,
  },
  walletOption: {
    padding: 15,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.15)',
  },
  walletOptionSelected: {
    borderColor: '#1565C0',
    backgroundColor: '#DBEAFE',
  },
  walletOptionText: {
    fontSize: 14,
    color: '#0D1B2E',
    fontWeight: '500',
  },
  walletOptionTextSelected: {
    color: '#1565C0',
    fontWeight: '700',
  },
  emptyWallet: {
    padding: 15,
    backgroundColor: '#FFF9E6',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(161,98,7,0.2)',
  },
  emptyWalletText: {
    color: '#A16207',
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    padding: 16,
    borderRadius: 14,
    fontSize: 16,
    color: '#0D1B2E',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.1)',
  },
  amountInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.1)',
    overflow: 'hidden',
  },
  amountInput: {
    flex: 1,
    padding: 16,
    fontSize: 26,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  currencyBadge: {
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 0,
  },
  currencyBadgeText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1565C0',
  },
  currencyScroll: {
    flexGrow: 0,
  },
  currencyButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.9)',
    marginRight: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.15)',
  },
  currencyButtonActive: {
    backgroundColor: '#1565C0',
    borderColor: '#1565C0',
  },
  currencyButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  currencyButtonTextActive: {
    color: '#FFFFFF',
  },
  // Balance chip — shows currency + available amount
  balanceChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.9)',
    marginRight: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.18)',
    alignItems: 'center',
    minWidth: 70,
  },
  balanceChipActive: {
    backgroundColor: '#1565C0',
    borderColor: '#1565C0',
  },
  balanceChipCurrency: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  balanceChipCurrencyActive: {
    color: '#FFFFFF',
  },
  balanceChipAmount: {
    fontSize: 11,
    color: '#657786',
    marginTop: 2,
  },
  balanceChipAmountActive: {
    color: 'rgba(255,255,255,0.8)',
  },
  // Live FX conversion preview card
  fxPreviewCard: {
    backgroundColor: '#F5F0FF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#DDD0FA',
  },
  fxPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  fxPreviewItem: {
    flex: 1,
    alignItems: 'center',
  },
  fxPreviewLabel: {
    fontSize: 10,
    color: '#7C3AED',
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fxPreviewAmountText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0D1B2E',
  },
  fxPreviewCurr: {
    fontSize: 11,
    color: '#9575CD',
    marginTop: 2,
  },
  fxPreviewNote: {
    fontSize: 11,
    color: '#7C3AED',
    textAlign: 'center',
  },
  infoBox: {
    backgroundColor: '#EFF6FF',
    padding: 14,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#1565C0',
    marginBottom: 20,
  },
  infoText: {
    fontSize: 13,
    color: '#1E40AF',
    lineHeight: 18,
  },
  sendButton: {
    backgroundColor: '#1565C0',
    padding: 17,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  sendButtonDisabled: {
    backgroundColor: '#9BAAB8',
    shadowOpacity: 0,
    elevation: 0,
  },
  sendButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.3,
  },
  // Confirmation Screen
  confirmHeader: {
    marginBottom: 24,
  },
  confirmTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0D1B2E',
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  confirmSubtitle: {
    fontSize: 14,
    color: '#5C6E8A',
  },
  summaryCard: {
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 10,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.07)',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.06)',
  },
  summaryLabel: {
    fontSize: 13,
    color: '#5C6E8A',
  },
  summaryValue: {
    fontSize: 13,
    color: '#0D1B2E',
    fontWeight: '500',
  },
  summaryValueBold: {
    fontSize: 13,
    color: '#0D1B2E',
    fontWeight: '700',
  },
  amountCard: {
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 10,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.07)',
  },
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 9,
  },
  amountLabel: {
    fontSize: 14,
    color: '#5C6E8A',
  },
  amountValue: {
    fontSize: 14,
    color: '#0D1B2E',
    fontWeight: '500',
  },
  feeValue: {
    fontSize: 14,
    color: '#DC2626',
    fontWeight: '500',
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(21,101,192,0.1)',
    marginTop: 8,
    paddingTop: 12,
  },
  totalLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  totalValue: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0D1B2E',
  },
  recipientRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    backgroundColor: '#DCFCE7',
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
  },
  recipientLabel: {
    fontSize: 14,
    color: '#15803D',
    fontWeight: '600',
  },
  recipientValue: {
    fontSize: 14,
    color: '#15803D',
    fontWeight: '700',
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  button: {
    flex: 1,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.2)',
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#5C6E8A',
  },
  confirmButton: {
    backgroundColor: '#1565C0',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.32,
    shadowRadius: 10,
    elevation: 5,
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  confirmButtonDisabled: {
    backgroundColor: '#9BAAB8',
    shadowOpacity: 0,
    elevation: 0,
  },
  scamBanner: {
    backgroundColor: '#FFF7ED',
    padding: 12,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#F97316',
    marginBottom: 16,
  },
  scamBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  scamBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#C2410C',
  },
  scamBannerText: {
    fontSize: 12,
    color: '#C2410C',
    lineHeight: 16,
  },
  scamWarning: {
    backgroundColor: '#FFF1F2',
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(220,38,38,0.2)',
    marginBottom: 16,
  },
  scamWarningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  scamWarningTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#991B1B',
  },
  scamWarningText: {
    fontSize: 14,
    color: '#991B1B',
    lineHeight: 20,
    marginBottom: 12,
  },
  learnMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  learnMoreText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1565C0',
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#1565C0',
    marginBottom: 16,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#9BAAB8',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  checkboxChecked: {
    backgroundColor: '#1565C0',
    borderColor: '#1565C0',
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
    color: '#14171A',
    fontWeight: '500',
  },
  // Scam Tips Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '80%',
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#14171A',
  },
  modalScroll: {
    padding: 20,
  },
  tipItem: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 18,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.06)',
  },
  tipContent: {
    flex: 1,
  },
  tipTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0D1B2E',
    marginBottom: 4,
  },
  tipText: {
    fontSize: 13,
    color: '#5C6E8A',
    lineHeight: 19,
  },
  safetyBox: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: '#DCFCE7',
    padding: 16,
    borderRadius: 14,
    marginTop: 8,
  },
  safetyText: {
    flex: 1,
    fontSize: 13,
    color: '#15803D',
    lineHeight: 19,
  },
  safetyBold: {
    fontWeight: '700',
  },
  modalCloseButton: {
    backgroundColor: '#1565C0',
    marginHorizontal: 20,
    marginTop: 16,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
    elevation: 5,
  },
  modalCloseText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  // Payment Method Modal styles
  insufficientBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#EFF6FF',
    padding: 14,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#1565C0',
    marginBottom: 20,
  },
  insufficientText: {
    flex: 1,
    fontSize: 13,
    color: '#1E40AF',
    lineHeight: 18,
  },
  pmSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9BAAB8',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
    marginTop: 4,
  },
  pmOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  pmIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pmLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0D1B2E',
    marginBottom: 2,
  },
  pmSub: {
    fontSize: 12,
    color: '#5C6E8A',
  },
  pmDivider: {
    height: 1,
    backgroundColor: 'rgba(21,101,192,0.08)',
    marginVertical: 14,
  },
  pmBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 20,
  },
  pmBackText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1565C0',
  },
  pmFormLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#5C6E8A',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 4,
  },
  pmInput: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    padding: 14,
    borderRadius: 12,
    fontSize: 16,
    color: '#0D1B2E',
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.15)',
    marginBottom: 16,
  },
  pmConfirmButton: {
    backgroundColor: '#1565C0',
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.32,
    shadowRadius: 10,
    elevation: 5,
  },
  pmConfirmButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  pmSecureNote: {
    textAlign: 'center',
    fontSize: 12,
    color: '#9BAAB8',
    marginTop: 12,
    marginBottom: 8,
  },
  pmBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  pmBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1565C0',
  },
  intlBadge: {
    backgroundColor: '#EDE9FE',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
    alignItems: 'center',
  },
  intlBadgeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7C3AED',
  },
});

