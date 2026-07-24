import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, Share, Modal, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { useLanguage } from '../i18n/LanguageContext';
import { listWallets } from '../api/auth';
import { API_BASE, getApiLanguage } from '../api/client';
import { fetchWithTokenRefresh } from '../utils/tokenRefresh';
import { getCurrencySymbol, majorToMinor, formatMajorAmount, formatCurrency, decimalsFor } from '../utils/currency';
import { logLocalTransaction, debitLocalBalance } from '../utils/localBalance';
import { sendTransaction, generateId } from '../api/transactions';
import { getApiErrorMessage } from '../utils/apiErrorMessage';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import QRCode from 'react-native-qrcode-svg';
import { useToast } from '../utils/toast';
import { formatStatusLabel } from '../utils/safeDisplay';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalRequest {
  id: string;
  backendId?: string;  // backend-assigned ID — used for the shareable deep link
  type: 'contact' | 'employer';
  firstName: string;
  lastName: string;
  contactInfo: string;
  amount: number;
  currency: string;
  note: string;
  status: 'pending' | 'paid' | 'cancelled';
  createdAt: number;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  walletHandle: string;
}

interface IncomingRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  amount: number;
  currency: string;
  memo: string;
  status: string;
  createdAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_CURRENCIES = [
  'XAF', 'XOF', 'NGN', 'GHS', 'ZAR', 'KES', 'USD', 'EUR', 'GBP',
  'INR', 'CNY', 'JPY', 'BRL',
  'MAD', 'TND', 'EGP', 'RWF', 'UGX', 'TZS',
];

const QR_PURPOSES = [
  { label: '🛒 Grocery', memoKey: 'request.qr.groceryMemo' },
  { label: '🍺 Bar / Restaurant', memoKey: 'request.qr.barMemo' },
  { label: '🏪 Open Market', memoKey: 'request.qr.marketMemo' },
  { label: '👗 Clothing', memoKey: 'request.qr.clothingMemo' },
  { label: '📦 Other', memoKey: '' },
];

const DEMO_WALLET_ID = 'egwallet-demo-001'; // fallback only

// ─── Component ────────────────────────────────────────────────────────────────

export default function RequestScreen() {
  const auth = useAuth();
  const { t } = useLanguage();
  const { isOnline } = useNetworkStatus();
  const toast = useToast();
  const navigation = useNavigation();

  const [activeTab, setActiveTab] = useState<'contact' | 'employer' | 'qr'>('contact');

  // Stable idempotency key for payroll send — reused across retries; reset only after success
  const payrollIdempotencyKeyRef = useRef(generateId());

  // Single currency modal driven by which field opened it
  const [currencyModalFor, setCurrencyModalFor] = useState<'contact' | 'employer' | 'qr' | null>(null);

  // ── Incoming requests (from others) ───────────────────────────────────────
  const [incomingRequests, setIncomingRequests] = useState<IncomingRequest[]>([]);

  useFocusEffect(
    useCallback(() => {
      if (!auth.token) return;
      // Load incoming requests (others requesting money from me)
      fetchWithTokenRefresh(`${API_BASE}/payment-requests/incoming`, {
        headers: { Authorization: `Bearer ${auth.token}`, 'Accept-Language': getApiLanguage() },
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.requests) setIncomingRequests(d.requests); })
        .catch(() => {});
      // Sync status of my sent requests so cards show PAID/CANCELLED when recipient pays
      fetchWithTokenRefresh(`${API_BASE}/payment-requests`, {
        headers: { Authorization: `Bearer ${auth.token}`, 'Accept-Language': getApiLanguage() },
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d?.requests) return;
          setRequests(prev => prev.map(local => {
            if (!local.backendId) return local;
            const server = d.requests.find((r: any) => r.id === local.backendId);
            if (!server || server.status === local.status) return local;
            return { ...local, status: server.status };
          }));
        })
        .catch(() => {});
    }, [auth.token])
  );

  // ── Local request history ──────────────────────────────────────────────────
  const [requests, setRequests] = useState<LocalRequest[]>([]);

  // ── Contact tab ───────────────────────────────────────────────────────────
  const [contactFirstName, setContactFirstName] = useState('');
  const [contactLastName, setContactLastName] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [contactAmount, setContactAmount] = useState('');
  const [contactCurrency, setContactCurrency] = useState('USD');
  const [contactNote, setContactNote] = useState('');
  const [isSendingContact, setIsSendingContact] = useState(false);

  function formatAmountInput(text: string): string {
    const cleaned = text.replace(/[^0-9.]/g, '');
    const parts = cleaned.split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? intPart + '.' + parts[1] : intPart;
  }

  // ── Employer tab ──────────────────────────────────────────────────────────
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [empFirstName, setEmpFirstName] = useState('');
  const [empLastName, setEmpLastName] = useState('');
  const [empWalletHandle, setEmpWalletHandle] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [payrollAmount, setPayrollAmount] = useState('');
  const [payrollCurrency, setPayrollCurrency] = useState('USD');
  const [payrollNote, setPayrollNote] = useState('');
  const [isSendingPayroll, setIsSendingPayroll] = useState(false);

  // ── QR tab ────────────────────────────────────────────────────────────────
  const [staticQRValue, setStaticQRValue] = useState('');
  const [qrAmount, setQrAmount] = useState('');
  const [qrCurrency, setQrCurrency] = useState('XAF');
  const [qrMemo, setQrMemo] = useState('');
  const [qrPurpose, setQrPurpose] = useState('');
  const [dynamicQR, setDynamicQR] = useState<{ value: string; expiresAt: number } | null>(null);
  const [realWalletId, setRealWalletId] = useState<string>(DEMO_WALLET_ID);

  // Fetch the server-signed static QR from GET /qr/static.
  // This returns an HMAC-signed egwallet:// string that /qr/pay verifies.
  // Plain JSON QRs are no longer generated here.
  useEffect(() => {
    if (!auth.token) {
      setStaticQRValue('');
      return;
    }
    fetchWithTokenRefresh(`${API_BASE}/qr/static`, {
      headers: { 'Accept-Language': getApiLanguage() },
    })
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then((data: any) => {
        if (data?.qrCode) {
          setStaticQRValue(data.qrCode);
          if (data.payload?.walletId) setRealWalletId(data.payload.walletId);
        } else {
          setStaticQRValue('');
        }
      })
      .catch(() => {
        setStaticQRValue('');
      });
  }, [auth.token]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const currentCurrencyFor = (target: 'contact' | 'employer' | 'qr') => {
    if (target === 'contact') return contactCurrency;
    if (target === 'employer') return payrollCurrency;
    return qrCurrency;
  };

  const setCurrencyFor = (target: 'contact' | 'employer' | 'qr', value: string) => {
    if (target === 'contact') setContactCurrency(value);
    else if (target === 'employer') setPayrollCurrency(value);
    else setQrCurrency(value);
  };

  // ── Contact submit ────────────────────────────────────────────────────────

  const handleContactSubmit = async () => {
    if (__DEV__) console.log('[Request] Contact submit pressed');
    if (!contactFirstName.trim()) {
      return Alert.alert(t('send.missingInfo'), t('request.missingFirstName'));
    }
    if (!contactLastName.trim()) {
      return Alert.alert(t('send.missingInfo'), t('request.missingLastName'));
    }
    if (!contactInfo.trim()) {
      return Alert.alert(t('send.missingInfo'), t('request.missingContactMsg'));
    }
    const amountNum = parseFloat(contactAmount.replace(/,/g, ''));
    if (!contactAmount || isNaN(amountNum) || amountNum <= 0) {
      return Alert.alert(t('common.invalidAmount'), t('request.invalidAmount'));
    }
    if (isSendingContact) return;

    setIsSendingContact(true);

    const req: LocalRequest = {
      id: uid(),
      type: 'contact',
      firstName: contactFirstName.trim(),
      lastName: contactLastName.trim(),
      contactInfo: contactInfo.trim(),
      amount: amountNum,
      currency: contactCurrency,
      note: contactNote.trim(),
      status: 'pending',
      createdAt: Date.now(),
    };

    // Persist to backend so the share link resolves when recipient taps it
    if (auth.token && realWalletId !== DEMO_WALLET_ID) {
      try {
        const res = await fetchWithTokenRefresh(`${API_BASE}/payment-requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth.token}`,
            'Accept-Language': getApiLanguage(),
          },
          body: JSON.stringify({
            walletId: realWalletId,
            amount: majorToMinor(amountNum, contactCurrency),
            currency: contactCurrency,
            memo: req.note || t('request.requestFromMemo').replace('{{name}}', `${req.firstName} ${req.lastName}`),
            recipientHandle: contactInfo.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (res.ok && data.request?.id) {
          req.backendId = data.request.id;
        }
      } catch (_) {
        // Network unavailable — link will use local ID (non-resolvable by recipient)
      }
    }

    setRequests(prev => [req, ...prev]);
    await logLocalTransaction({
      type: 'payment_request',
      direction: 'out',
      amount: majorToMinor(amountNum, contactCurrency),
      currency: contactCurrency,
      memo: t('request.moneyRequestToMemo').replace('{{name}}', `${req.firstName} ${req.lastName}`),
    });
    setContactFirstName('');
    setContactLastName('');
    setContactInfo('');
    setContactAmount('');
    setContactNote('');
    setIsSendingContact(false);
    if (__DEV__) console.log('[Request] Contact request created:', req.id);
    toast.show(t('request.requestSentToast'));
    Alert.alert(
      t('request.sentTitle'),
      t('request.requestSentSuccessBody')
        .replace('{name}', `${req.firstName} ${req.lastName}`)
        .replace('{amount}', `${getCurrencySymbol(req.currency)}${formatMajorAmount(amountNum, req.currency)} ${req.currency}`)
    );
  };

  // ── Add Employee ──────────────────────────────────────────────────────────

  const handleAddEmployee = () => {
    if (!empFirstName.trim()) return Alert.alert(t('send.missingInfo'), t('request.missingFirstName'));
    if (!empLastName.trim()) return Alert.alert(t('send.missingInfo'), t('request.missingLastName'));
    if (!empWalletHandle.trim()) {
      return Alert.alert(t('common.error'), t('request.invalidWalletHandle'));
    }
    const emp: Employee = {
      id: uid(),
      firstName: empFirstName.trim(),
      lastName: empLastName.trim(),
      walletHandle: empWalletHandle.trim(),
    };
    setEmployees(prev => [...prev, emp]);
    setEmpFirstName('');
    setEmpLastName('');
    setEmpWalletHandle('');
    setShowAddEmployee(false);
    Alert.alert(t('request.employeeAddedTitle'), `${emp.firstName} ${emp.lastName} ${t('request.employeeAddedMsg')}`);
  };

  // ── Payroll request ───────────────────────────────────────────────────────

  const handlePayrollSubmit = () => {
    if (__DEV__) console.log('[Request] Payroll submit pressed');
    if (!selectedEmployee) {
      return Alert.alert(t('common.error'), t('request.selectEmployee'));
    }
    const amountNum = parseFloat(payrollAmount.replace(/,/g, ''));
    if (!payrollAmount || isNaN(amountNum) || amountNum <= 0) {
      return Alert.alert(t('common.invalidAmount'), t('request.invalidAmount'));
    }
    if (isSendingPayroll) return;

    Alert.alert(
      t('request.confirmPayrollTitle'),
      t('request.confirmPayrollBody')
        .replace('{{amount}}', `${getCurrencySymbol(payrollCurrency)}${formatMajorAmount(amountNum, payrollCurrency)} ${payrollCurrency}`)
        .replace('{{name}}', `${selectedEmployee.firstName} ${selectedEmployee.lastName}`),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('request.sendRequestBtn'),
          onPress: async () => {
            if (!auth.token || realWalletId === DEMO_WALLET_ID) {
              Alert.alert(t('common.error'), t('request.loginRequiredForPayroll'));
              return;
            }
            setIsSendingPayroll(true);
            try {
              await sendTransaction(
                auth.token,
                realWalletId,
                selectedEmployee.walletHandle,
                majorToMinor(amountNum, payrollCurrency),
                payrollCurrency,
                payrollNote.trim() || t('request.payrollPaymentToMemo').replace('{{name}}', `${selectedEmployee.firstName} ${selectedEmployee.lastName}`),
                payrollIdempotencyKeyRef.current,
              );
              // Reset only after confirmed success — retries reuse the same key
              payrollIdempotencyKeyRef.current = generateId();
              await debitLocalBalance(payrollCurrency, majorToMinor(amountNum, payrollCurrency));
              const req: LocalRequest = {
                id: uid(),
                type: 'employer',
                firstName: selectedEmployee.firstName,
                lastName: selectedEmployee.lastName,
                contactInfo: selectedEmployee.walletHandle,
                amount: amountNum,
                currency: payrollCurrency,
                note: payrollNote.trim() || t('request.payrollPaymentFallback'),
                status: 'paid',
                createdAt: Date.now(),
              };
              setRequests(prev => [req, ...prev]);
              await logLocalTransaction({
                type: 'payment_request',
                direction: 'out',
                amount: majorToMinor(amountNum, payrollCurrency),
                currency: payrollCurrency,
                memo: t('request.payrollToMemo').replace('{{name}}', `${req.firstName} ${req.lastName}`),
              });
              setPayrollAmount('');
              setPayrollNote('');
              setSelectedEmployee(null);
              if (__DEV__) console.log('[Request] Payroll sent:', req.id);
              toast.show(t('request.requestSentToast'));
              Alert.alert(t('request.sentTitle'), `${t('request.payrollSentMsg')} ${selectedEmployee.firstName} ${selectedEmployee.lastName}.`);
            } catch (err: any) {
              Alert.alert(t('common.error'), getApiErrorMessage(err, t));
            } finally {
              setIsSendingPayroll(false);
            }
          },
        },
      ]
    );
  };

  // ── Cancel / Share ────────────────────────────────────────────────────────

  const handleCancelRequest = (id: string) => {
    Alert.alert(t('request.cancelRequestTitle'), t('common.areYouSure'), [
      { text: t('common.no'), style: 'cancel' },
      {
        text: t('request.yesCancel'),
        style: 'destructive',
        onPress: () => setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'cancelled' } : r)),
      },
    ]);
  };

  const handleShare = async (req: LocalRequest) => {
    const id = req.backendId || req.id;
    const link = `egwallet://pay/${id}`;
    const noteSuffix = req.note ? t('request.shareNoteSuffix').replace('{{note}}', req.note) : '';
    const msg = t('request.sharePaymentMessage')
      .replace('{{firstName}}', req.firstName)
      .replace('{{amount}}', `${getCurrencySymbol(req.currency)}${formatMajorAmount(req.amount, req.currency)}`)
      .replace('{{currency}}', req.currency)
      .replace('{{noteSuffix}}', noteSuffix)
      .replace('{{link}}', link);
    try { await Share.share({ message: msg }); } catch (_) {}
  };

  // ── Dynamic QR ────────────────────────────────────────────────────────────

  const handleGenerateDynamicQR = async () => {
    if (__DEV__) console.log('[Request] Generate QR pressed');
    const amountNum = parseFloat(qrAmount.replace(/,/g, ''));
    if (!qrAmount || isNaN(amountNum) || amountNum <= 0) {
      return Alert.alert(t('common.invalidAmount'), t('request.invalidAmount'));
    }
    if (!auth.token) {
      return Alert.alert(t('common.error'), t('common.notAuthenticated'));
    }

    try {
      const res = await fetchWithTokenRefresh(`${API_BASE}/qr/dynamic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': getApiLanguage(),
        },
        body: JSON.stringify({
          amount: majorToMinor(amountNum, qrCurrency),
          currency: qrCurrency,
          memo: qrMemo || qrPurpose || t('common.payment'),
          expiryMinutes: 30,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const error = new Error(err.error || t('request.qrGenerateFailed')) as Error & { code?: string; limitType?: string; status?: number };
        error.code = err.code;
        error.limitType = err.limitType;
        error.status = res.status;
        throw error;
      }

      const data = await res.json();
      setDynamicQR({
        value: data.qrCode,
        expiresAt: data.expiresAt,
      });
    } catch (err: any) {
      Alert.alert(t('common.error'), getApiErrorMessage(err, t));
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const contactRequests = requests.filter(r => r.type === 'contact');
  const employerRequests = requests.filter(r => r.type === 'employer');

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <OfflineErrorBanner visible={!isOnline} onRetry={() => {}} />

      <View style={styles.header}>
        <Text style={styles.title}>{t('request.title')}</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        {(['contact', 'employer', 'qr'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
            activeOpacity={0.8}
          >
            <Ionicons
              name={tab === 'contact' ? 'people' : tab === 'employer' ? 'briefcase' : 'qr-code'}
              size={13}
              color={activeTab === tab ? '#fff' : '#657786'}
            />
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'contact' ? t('request.contactTab') : tab === 'employer' ? t('request.employerTab') : t('request.qrTab')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ══════════════════════ INCOMING REQUESTS (always visible) ══════════════════════ */}
      {incomingRequests.length > 0 && (
        <>
          <Text style={styles.historyTitle}>{t('request.incomingRequests')}</Text>
          {incomingRequests.map(req => (
            <View key={req.id} style={[styles.requestCard, { borderLeftColor: '#7C3AED', borderLeftWidth: 3 }]}>
              <View style={styles.requestHeader}>
                <View style={[styles.statusBadge, req.status === 'paid' && styles.statusPaid]}>
                  <Text style={[styles.statusText, req.status === 'paid' && { color: '#2E7D32' }]}>
                    {formatStatusLabel(req.status, 'pending')}
                  </Text>
                </View>
                <Text style={styles.dateText}>{formatDate(req.createdAt)}</Text>
              </View>
              <Text style={styles.requestName}>{req.requesterName}</Text>
              <Text style={styles.amountText}>
                {formatCurrency(req.amount, req.currency)}
              </Text>
              {req.memo ? <Text style={styles.memoText}>{req.memo}</Text> : null}
              {req.status === 'pending' && (
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.shareButton}
                    onPress={() => (navigation as any).navigate('PayRequest', { requestId: req.id })}
                  >
                    <Ionicons name="cash-outline" size={18} color="#7C3AED" />
                    <Text style={[styles.shareButtonText, { color: '#7C3AED' }]}>{t('request.payNow')}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))}
        </>
      )}

      {/* ══════════════════════ CONTACT TAB ══════════════════════ */}
      {activeTab === 'contact' && (
        <>
          <View style={styles.form}>
            <Text style={styles.formSectionTitle}>{t('request.from')}</Text>

            <View style={styles.nameRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{t('request.firstName')}</Text>
                <TextInput
                  style={styles.input}
                  value={contactFirstName}
                  onChangeText={setContactFirstName}
                  placeholder={t('request.contactFirstNamePlaceholder')}
                  placeholderTextColor="#999"
                  autoCapitalize="words"
                />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.label}>{t('request.lastName')}</Text>
                <TextInput
                  style={styles.input}
                  value={contactLastName}
                  onChangeText={setContactLastName}
                  placeholder={t('request.contactLastNamePlaceholder')}
                  placeholderTextColor="#999"
                  autoCapitalize="words"
                />
              </View>
            </View>

            <Text style={styles.label}>{t('request.walletIdOrUsername')}</Text>
            <TextInput
              style={styles.input}
              value={contactInfo}
              onChangeText={setContactInfo}
              placeholder={t('request.walletIdOrUsernamePlaceholder')}
              placeholderTextColor="#999"
              keyboardType="default"
              autoCapitalize="none"
            />

            <View style={styles.amountRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{t('request.amount')}</Text>
                <TextInput
                  style={styles.input}
                  value={contactAmount}
                  onChangeText={v => setContactAmount(formatAmountInput(v))}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor="#999"
                />
              </View>
              <View style={{ marginLeft: 12, minWidth: 90 }}>
                <Text style={styles.label}>{t('request.currency')}</Text>
                <TouchableOpacity
                  style={styles.currencyPicker}
                  onPress={() => setCurrencyModalFor('contact')}
                  activeOpacity={0.75}
                >
                  <Text style={styles.currencyText}>{contactCurrency}</Text>
                  <Ionicons name="chevron-down" size={16} color="#657786" />
                </TouchableOpacity>
              </View>
            </View>

            <Text style={styles.label}>{t('request.noteOptionalLabel')}</Text>
            <TextInput
              style={[styles.input, styles.memoInput]}
              value={contactNote}
              onChangeText={setContactNote}
              placeholder={t('request.notePlaceholder')}
              placeholderTextColor="#999"
              multiline
            />

            <TouchableOpacity
              style={[styles.createButton, isSendingContact && styles.buttonDisabled]}
              onPress={handleContactSubmit}
              activeOpacity={0.8}
              disabled={isSendingContact}
            >
              {isSendingContact
                ? <ActivityIndicator color="#FFFFFF" />
                : (
                  <>
                    <Ionicons name="send" size={20} color="#FFFFFF" />
                    <Text style={styles.createButtonText}>{t('request.sendRequest')}</Text>
                  </>
                )
              }
            </TouchableOpacity>
          </View>

          {/* Contact History */}
          {contactRequests.length > 0 && (
            <>
              <Text style={styles.historyTitle}>{t('request.history')}</Text>
              {contactRequests.map(req => (
                <View key={req.id} style={styles.requestCard}>
                  <View style={styles.requestHeader}>
                    <View style={[
                      styles.statusBadge,
                      req.status === 'paid' && styles.statusPaid,
                      req.status === 'cancelled' && styles.statusCancelled,
                    ]}>
                      <Text style={[
                        styles.statusText,
                        req.status === 'paid' && { color: '#2E7D32' },
                        req.status === 'cancelled' && { color: '#d32f2f' },
                      ]}>
                        {formatStatusLabel(req.status, 'pending')}
                      </Text>
                    </View>
                    <Text style={styles.dateText}>{formatDate(req.createdAt)}</Text>
                  </View>
                  <Text style={styles.requestName}>{req.firstName} {req.lastName}</Text>
                  <Text style={styles.requestContact}>{req.contactInfo}</Text>
                  <Text style={styles.amountText}>
                    {getCurrencySymbol(req.currency)}{formatMajorAmount(req.amount, req.currency)} {req.currency}
                  </Text>
                  {req.note ? <Text style={styles.memoText}>{req.note}</Text> : null}
                  {req.status === 'pending' && (
                    <View style={styles.actions}>
                      <TouchableOpacity style={styles.shareButton} onPress={() => handleShare(req)}>
                        <Ionicons name="share-social" size={18} color="#007AFF" />
                        <Text style={styles.shareButtonText}>{t('common.share')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.cancelButton} onPress={() => handleCancelRequest(req.id)}>
                        <Ionicons name="close-circle" size={18} color="#d32f2f" />
                        <Text style={styles.cancelButtonText}>{t('request.cancelRequest')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              ))}
            </>
          )}

        </>
      )}

      {/* ══════════════════════ EMPLOYER TAB ══════════════════════ */}
      {activeTab === 'employer' && (
        <>
          <View style={styles.employerSectionHeader}>
            <Text style={styles.formSectionTitle}>{t('request.teamMembers')}</Text>
            <TouchableOpacity
              style={styles.addEmployeeBtn}
              onPress={() => setShowAddEmployee(v => !v)}
              activeOpacity={0.8}
            >
              <Ionicons name={showAddEmployee ? 'close' : 'person-add'} size={16} color="#007AFF" />
              <Text style={styles.addEmployeeBtnText}>{showAddEmployee ? t('common.cancel') : t('request.addEmployeeBtn')}</Text>
            </TouchableOpacity>
          </View>

          {/* Add Employee Form */}
          {showAddEmployee && (
            <View style={[styles.form, { marginBottom: 12 }]}>
              <Text style={styles.formSectionTitle}>{t('request.newEmployee')}</Text>

              <Text style={styles.label}>{t('request.firstName')}</Text>
              <TextInput
                style={styles.input}
                value={empFirstName}
                onChangeText={setEmpFirstName}
                placeholder={t('request.employeeFirstNamePlaceholder')}
                placeholderTextColor="#999"
                autoCapitalize="words"
              />
              <Text style={styles.label}>{t('request.lastName')}</Text>
              <TextInput
                style={styles.input}
                value={empLastName}
                onChangeText={setEmpLastName}
                placeholder={t('request.employeeLastNamePlaceholder')}
                placeholderTextColor="#999"
                autoCapitalize="words"
              />
              <Text style={styles.label}>{t('request.walletIdOrUsername')}</Text>
              <TextInput
                style={styles.input}
                value={empWalletHandle}
                onChangeText={setEmpWalletHandle}
                placeholder={t('request.walletIdOrUsernamePlaceholder')}
                placeholderTextColor="#999"
                keyboardType="default"
                autoCapitalize="none"
              />

              <TouchableOpacity style={styles.createButton} onPress={handleAddEmployee} activeOpacity={0.8}>
                <Ionicons name="person-add" size={18} color="#FFFFFF" />
                <Text style={styles.createButtonText}>{t('request.saveEmployee')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Empty state */}
          {employees.length === 0 && !showAddEmployee && (
            <View style={styles.emptyContainer}>
              <Ionicons name="people-outline" size={56} color="#CCCCCC" />
              <Text style={styles.emptyTitle}>{t('request.noEmployees')}</Text>
              <Text style={styles.emptyText}>{t('request.addEmployee')}</Text>
              <TouchableOpacity
                style={[styles.createButton, { marginTop: 20, paddingHorizontal: 24 }]}
                onPress={() => setShowAddEmployee(true)}
              >
                <Ionicons name="person-add" size={18} color="#FFFFFF" />
                <Text style={styles.createButtonText}>{t('request.addFirstEmployee')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Employee list */}
          {employees.map(emp => (
            <TouchableOpacity
              key={emp.id}
              style={[styles.employeeCard, selectedEmployee?.id === emp.id && styles.employeeCardSelected]}
              onPress={() => setSelectedEmployee(s => s?.id === emp.id ? null : emp)}
              activeOpacity={0.8}
            >
              <View style={styles.employeeAvatar}>
                <Text style={styles.employeeAvatarText}>{emp.firstName[0]}{emp.lastName[0]}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.employerName}>{emp.firstName} {emp.lastName}</Text>
                <Text style={styles.employeeEmail}>{emp.walletHandle}</Text>
              </View>
              {selectedEmployee?.id === emp.id
                ? <Ionicons name="checkmark-circle" size={22} color="#007AFF" />
                : <Ionicons name="chevron-forward" size={18} color="#AAB8C2" />
              }
            </TouchableOpacity>
          ))}

          {/* Payroll Request Form */}
          {selectedEmployee && (
            <View style={[styles.form, { marginTop: 8 }]}>
              <Text style={styles.formSectionTitle}>{t('request.requestFrom')} {selectedEmployee.firstName}</Text>

              <View style={styles.amountRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>{t('request.amount')}</Text>
                  <TextInput
                    style={styles.input}
                    value={payrollAmount}
                    onChangeText={v => setPayrollAmount(formatAmountInput(v))}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#999"
                  />
                </View>
                <View style={{ marginLeft: 12, minWidth: 90 }}>
                  <Text style={styles.label}>{t('request.currency')}</Text>
                  <TouchableOpacity
                    style={styles.currencyPicker}
                    onPress={() => setCurrencyModalFor('employer')}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.currencyText}>{payrollCurrency}</Text>
                    <Ionicons name="chevron-down" size={16} color="#657786" />
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={styles.label}>{t('request.noteOptionalLabel')}</Text>
              <TextInput
                style={[styles.input, styles.memoInput]}
                value={payrollNote}
                onChangeText={setPayrollNote}
                placeholder={t('request.memoPlaceholder')}
                placeholderTextColor="#999"
                multiline
              />

              <TouchableOpacity
                style={[styles.createButton, isSendingPayroll && styles.buttonDisabled]}
                onPress={handlePayrollSubmit}
                activeOpacity={0.8}
                disabled={isSendingPayroll}
              >
                {isSendingPayroll
                  ? <ActivityIndicator color="#FFFFFF" />
                  : (
                    <>
                      <Ionicons name="cash-outline" size={18} color="#FFFFFF" />
                      <Text style={styles.createButtonText}>{t('request.payEmployee')}</Text>
                    </>
                  )
                }
              </TouchableOpacity>
            </View>
          )}

          {/* Payroll History */}
          {employerRequests.length > 0 && (
            <>
              <Text style={styles.historyTitle}>{t('request.payrollRequests')}</Text>
              {employerRequests.map(req => (
                <View key={req.id} style={styles.requestCard}>
                  <View style={styles.requestHeader}>
                    <View style={[
                      styles.statusBadge,
                      req.status === 'paid' && styles.statusPaid,
                      req.status === 'cancelled' && styles.statusCancelled,
                    ]}>
                      <Text style={[
                        styles.statusText,
                        req.status === 'paid' && { color: '#2E7D32' },
                        req.status === 'cancelled' && { color: '#d32f2f' },
                      ]}>
                        {formatStatusLabel(req.status, 'pending')}
                      </Text>
                    </View>
                    <Text style={styles.dateText}>{formatDate(req.createdAt)}</Text>
                  </View>
                  <Text style={styles.requestName}>{req.firstName} {req.lastName}</Text>
                  <Text style={styles.requestContact}>{req.contactInfo}</Text>
                  <Text style={styles.amountText}>
                    {getCurrencySymbol(req.currency)}{formatMajorAmount(req.amount, req.currency)} {req.currency}
                  </Text>
                  {req.note ? <Text style={styles.memoText}>{req.note}</Text> : null}
                  {req.status === 'pending' && (
                    <View style={styles.actions}>
                      <TouchableOpacity style={styles.cancelButton} onPress={() => handleCancelRequest(req.id)}>
                        <Ionicons name="close-circle" size={18} color="#d32f2f" />
                        <Text style={styles.cancelButtonText}>{t('request.cancelRequest')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              ))}
            </>
          )}
        </>
      )}

      {/* ══════════════════════ QR CODE TAB ══════════════════════ */}
      {activeTab === 'qr' && (
        <>
          {/* Static wallet QR — renders instantly, no API */}
          <View style={styles.qrCard}>
            <View style={styles.qrCardHeader}>
              <Ionicons name="qr-code" size={22} color="#007AFF" />
              <Text style={styles.qrCardTitle}>{t('request.staticQr')}</Text>
            </View>
            <Text style={styles.qrCardSub}>
              {t('request.qrDesc')}
            </Text>
            <View style={[styles.qrCenter, { marginTop: 4 }]}>
              <View style={styles.egwalletOnlyBadge}>
                <Ionicons name="phone-portrait-outline" size={13} color="#1565C0" />
                <Text style={styles.egwalletOnlyText}> {t('request.requiresApp')}</Text>
              </View>
              {staticQRValue ? (
                <QRCode value={staticQRValue} size={200} backgroundColor="white" />
              ) : (
                <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="qr-code" size={80} color="#E1E8ED" />
                </View>
              )}
              <Text style={styles.qrPermanentLabel}>{t('request.permanentNoExpiry')}</Text>
            </View>
          </View>

          {/* Divider */}
          <View style={styles.orDivider}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>{t('request.orRequestAmount')}</Text>
            <View style={styles.orLine} />
          </View>

          {/* Purpose presets */}
          <Text style={styles.label}>{t('request.purpose')}</Text>
          <View style={styles.purposeRow}>
            {QR_PURPOSES.map((p, idx) => (
              <TouchableOpacity
                key={p.label}
                style={[styles.purposeChip, qrPurpose === p.label && styles.purposeChipActive]}
                onPress={() => { setQrPurpose(p.label); setQrMemo(p.memoKey ? t(p.memoKey as any) : ''); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.purposeChipText, qrPurpose === p.label && styles.purposeChipTextActive]}>
                  {t((['request.qr.grocery', 'request.qr.barRestaurant', 'request.qr.openMarket', 'request.qr.clothing', 'request.qr.other'] as const)[idx] as any)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.amountRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t('request.amount')}</Text>
              <TextInput
                style={styles.input}
                value={qrAmount}
                onChangeText={v => setQrAmount(formatAmountInput(v))}
                keyboardType="decimal-pad"
                placeholder={decimalsFor(qrCurrency) === 0 ? '0' : decimalsFor(qrCurrency) === 3 ? '0.000' : '0.00'}
                placeholderTextColor="#999"
              />
            </View>
            <View style={{ marginLeft: 12, minWidth: 90 }}>
              <Text style={styles.label}>{t('request.currency')}</Text>
              <TouchableOpacity
                style={styles.currencyPicker}
                onPress={() => setCurrencyModalFor('qr')}
                activeOpacity={0.75}
              >
                <Text style={styles.currencyText}>{qrCurrency}</Text>
                <Ionicons name="chevron-down" size={16} color="#657786" />
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.label}>{t('request.noteOptionalLabel')}</Text>
          <TextInput
            style={styles.input}
            value={qrMemo}
            onChangeText={setQrMemo}
            placeholder={t('request.notePlaceholder')}
            placeholderTextColor="#999"
          />

          <TouchableOpacity
            style={[styles.createButton, { marginTop: 16, marginBottom: 8 }]}
            onPress={handleGenerateDynamicQR}
            activeOpacity={0.8}
          >
            <Ionicons name="qr-code" size={20} color="#FFFFFF" />
            <Text style={styles.createButtonText}>{t('request.generateDynamic')}</Text>
          </TouchableOpacity>

          {dynamicQR && (
            <View style={styles.generatedQRCard}>
              <View style={styles.qrCardHeader}>
                <Ionicons name="checkmark-circle" size={22} color="#2E7D32" />
                <Text style={[styles.qrCardTitle, { color: '#2E7D32' }]}>{t('request.qrReady')}</Text>
              </View>
              <Text style={{ textAlign: 'center', fontSize: 22, fontWeight: '700', color: '#0A3D7C', marginBottom: 8 }}>
                {formatCurrency(majorToMinor(parseFloat(qrAmount.replace(/,/g, '')), qrCurrency), qrCurrency)}
              </Text>
              {qrMemo ? <Text style={{ textAlign: 'center', fontSize: 13, color: '#657786', marginBottom: 8 }}>{qrMemo}</Text> : null}
              <View style={styles.qrCenter}>
                <QRCode value={dynamicQR.value} size={200} backgroundColor="white" />
              </View>
              <Text style={styles.qrExpiryLabel}>
                ⏱ Expires: {new Date(dynamicQR.expiresAt).toLocaleTimeString()}
              </Text>
              <TouchableOpacity
                style={styles.clearQRButton}
                onPress={() => { setDynamicQR(null); setQrAmount(''); setQrMemo(''); setQrPurpose(''); }}
              >
                <Text style={styles.clearQRText}>{t('request.generateNew')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      )}

      <View style={{ height: 40 }} />

      {/* Shared currency picker modal */}
      <Modal visible={currencyModalFor !== null} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{t('common.selectCurrency')}</Text>
            <FlatList
              data={ALL_CURRENCIES}
              keyExtractor={c => c}
              renderItem={({ item: c }) => {
                const isSelected = currencyModalFor ? c === currentCurrencyFor(currencyModalFor) : false;
                return (
                  <TouchableOpacity
                    style={styles.modalItem}
                    onPress={() => {
                      if (currencyModalFor) setCurrencyFor(currencyModalFor, c);
                      setCurrencyModalFor(null);
                    }}
                  >
                    <Text style={[styles.modalItemText, isSelected && { color: '#007AFF', fontWeight: '700' }]}>
                      {c}  {getCurrencySymbol(c)}
                    </Text>
                    {isSelected && <Ionicons name="checkmark" size={20} color="#007AFF" />}
                  </TouchableOpacity>
                );
              }}
            />
            <TouchableOpacity style={styles.modalClose} onPress={() => setCurrencyModalFor(null)}>
              <Text style={styles.modalCloseText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F7FA' },
  content: { padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#14171A' },

  // Tabs
  tabContainer: {
    flexDirection: 'row', backgroundColor: '#FFFFFF', borderRadius: 12, padding: 4, marginBottom: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  tab: {
    flex: 1, paddingVertical: 10, paddingHorizontal: 4, borderRadius: 8,
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 4,
  },
  tabActive: { backgroundColor: '#007AFF' },
  tabText: { fontSize: 12, fontWeight: '600', color: '#657786' },
  tabTextActive: { color: '#FFFFFF' },

  // Forms
  form: {
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 20, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 3,
  },
  formSectionTitle: { fontSize: 17, fontWeight: '700', color: '#14171A', marginBottom: 4 },
  nameRow: { flexDirection: 'row' },
  label: { fontSize: 14, fontWeight: '600', color: '#14171A', marginBottom: 8, marginTop: 16 },
  input: {
    backgroundColor: '#F5F7FA', borderRadius: 8, padding: 14,
    fontSize: 16, color: '#14171A', borderWidth: 1, borderColor: '#E1E8ED',
  },
  memoInput: { height: 80, textAlignVertical: 'top' },
  amountRow: { flexDirection: 'row', alignItems: 'flex-end' },
  currencyPicker: {
    backgroundColor: '#F5F7FA', borderRadius: 8, padding: 14, borderWidth: 1, borderColor: '#E1E8ED',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  currencyText: { fontSize: 16, color: '#14171A', fontWeight: '600' },
  createButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#007AFF', borderRadius: 8, padding: 16, marginTop: 24, gap: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  createButtonText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },

  // History cards
  historyTitle: { fontSize: 18, fontWeight: '700', color: '#14171A', marginBottom: 12, marginTop: 8 },
  requestCard: {
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 3,
  },
  requestHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  requestName: { fontSize: 16, fontWeight: '700', color: '#14171A' },
  requestContact: { fontSize: 13, color: '#657786', marginBottom: 6 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: '#FFF3E0' },
  statusPaid: { backgroundColor: '#E8F5E9' },
  statusCancelled: { backgroundColor: '#FFEBEE' },
  statusText: { fontSize: 11, fontWeight: '700', color: '#F57C00' },
  dateText: { fontSize: 13, color: '#657786' },
  amountText: { fontSize: 22, fontWeight: 'bold', color: '#14171A', marginBottom: 4 },
  memoText: { fontSize: 14, color: '#657786', marginBottom: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  shareButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    padding: 12, borderRadius: 8, backgroundColor: '#E8F5FE', gap: 6,
  },
  shareButtonText: { fontSize: 14, fontWeight: '600', color: '#007AFF' },
  cancelButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    padding: 12, borderRadius: 8, backgroundColor: '#FFEBEE', gap: 6,
  },
  cancelButtonText: { fontSize: 14, fontWeight: '600', color: '#d32f2f' },

  // Employer
  employerSectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  addEmployeeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#E8F5FE', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
  },
  addEmployeeBtnText: { fontSize: 13, fontWeight: '600', color: '#007AFF' },
  employeeCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF',
    borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 2, borderColor: 'transparent',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 4, elevation: 2,
  },
  employeeCardSelected: { borderColor: '#007AFF', backgroundColor: '#F0F7FF' },
  employeeAvatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#007AFF',
    alignItems: 'center', justifyContent: 'center',
  },
  employeeAvatarText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  employerName: { fontSize: 16, fontWeight: '600', color: '#14171A' },
  employeeEmail: { fontSize: 13, color: '#657786', marginTop: 2 },
  emptyContainer: { paddingVertical: 48, alignItems: 'center' },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#14171A', marginTop: 12 },
  emptyText: { fontSize: 14, color: '#657786', marginTop: 8, textAlign: 'center' },

  // QR
  qrCard: {
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 20, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 3,
  },
  qrCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  qrCardTitle: { fontSize: 18, fontWeight: '700', color: '#14171A' },
  qrCardSub: { fontSize: 14, color: '#657786', lineHeight: 20, marginBottom: 16 },
  qrCenter: { alignItems: 'center', paddingVertical: 8 },
  qrPermanentLabel: { marginTop: 12, fontSize: 13, color: '#2E7D32', fontWeight: '500' },
  egwalletOnlyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E3F2FD',
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginBottom: 14,
    alignSelf: 'center',
  },
  egwalletOnlyText: { fontSize: 12, color: '#1565C0', fontWeight: '600' },
  qrExpiryLabel: { textAlign: 'center', marginTop: 10, fontSize: 14, color: '#F57C00', fontWeight: '600' },
  orDivider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  orLine: { flex: 1, height: 1, backgroundColor: '#E1E8ED' },
  orText: { marginHorizontal: 12, fontSize: 11, fontWeight: '600', color: '#AAB8C2', letterSpacing: 0.5 },
  purposeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  purposeChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#F5F7FA', borderWidth: 1.5, borderColor: '#E1E8ED',
  },
  purposeChipActive: { backgroundColor: '#E8F5FE', borderColor: '#007AFF' },
  purposeChipText: { fontSize: 13, color: '#657786', fontWeight: '500' },
  purposeChipTextActive: { color: '#007AFF', fontWeight: '600' },
  generatedQRCard: {
    backgroundColor: '#F0FFF4', borderRadius: 12, padding: 20, marginTop: 16,
    borderWidth: 1.5, borderColor: '#2E7D32',
  },
  clearQRButton: { marginTop: 12, alignItems: 'center', padding: 12, borderRadius: 8, backgroundColor: '#E8F5FE' },
  clearQRText: { color: '#007AFF', fontWeight: '600', fontSize: 15 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: '60%',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#14171A', marginBottom: 16, textAlign: 'center' },
  modalItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F5F7FA',
  },
  modalItemText: { fontSize: 16, color: '#14171A' },
  modalClose: { marginTop: 16, padding: 14, alignItems: 'center', backgroundColor: '#F5F7FA', borderRadius: 10 },
  modalCloseText: { fontSize: 16, fontWeight: '600', color: '#657786' },
});

