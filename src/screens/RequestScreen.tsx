import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, Share, Modal, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { getCurrencySymbol } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import QRCode from 'react-native-qrcode-svg';
import { useToast } from '../utils/toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalRequest {
  id: string;
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
  email: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_CURRENCIES = [
  'XAF', 'XOF', 'NGN', 'GHS', 'ZAR', 'KES', 'USD', 'EUR', 'GBP',
  'INR', 'CNY', 'JPY', 'BRL',
  'MAD', 'TND', 'EGP', 'RWF', 'UGX', 'TZS',
];

const QR_PURPOSES = [
  { label: '🛒 Grocery', memo: 'Grocery Payment' },
  { label: '🍺 Bar / Restaurant', memo: 'Bar / Restaurant' },
  { label: '🏪 Open Market', memo: 'Market Payment' },
  { label: '📦 Other', memo: '' },
];

const DEMO_WALLET_ID = 'egwallet-demo-001'; // fallback only

// ─── Component ────────────────────────────────────────────────────────────────

export default function RequestScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<'contact' | 'employer' | 'qr'>('contact');

  // Single currency modal driven by which field opened it
  const [currencyModalFor, setCurrencyModalFor] = useState<'contact' | 'employer' | 'qr' | null>(null);

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

  // ── Employer tab ──────────────────────────────────────────────────────────
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [empFirstName, setEmpFirstName] = useState('');
  const [empLastName, setEmpLastName] = useState('');
  const [empEmail, setEmpEmail] = useState('');
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

  // Fetch the real wallet ID then generate the static QR
  useEffect(() => {
    if (!auth.token) {
      setStaticQRValue(JSON.stringify({ type: 'wallet_address', walletId: DEMO_WALLET_ID, version: 1 }));
      return;
    }
    listWallets(auth.token)
      .then(res => {
        const wid = res.wallets?.[0]?.id || DEMO_WALLET_ID;
        setRealWalletId(wid);
        setStaticQRValue(JSON.stringify({ type: 'wallet_address', walletId: wid, version: 1 }));
      })
      .catch(() => {
        setStaticQRValue(JSON.stringify({ type: 'wallet_address', walletId: DEMO_WALLET_ID, version: 1 }));
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

  const handleContactSubmit = () => {
    console.log('[Request] Contact submit pressed —', contactFirstName, contactAmount, contactCurrency);
    if (!contactFirstName.trim()) {
      return Alert.alert('Missing Info', 'Please enter a first name.');
    }
    if (!contactLastName.trim()) {
      return Alert.alert('Missing Info', 'Please enter a last name.');
    }
    if (!contactInfo.trim()) {
      return Alert.alert('Missing Info', 'Please enter an email or phone number.');
    }
    const amountNum = parseFloat(contactAmount);
    if (!contactAmount || isNaN(amountNum) || amountNum <= 0) {
      return Alert.alert('Invalid Amount', 'Please enter a valid amount greater than 0.');
    }
    if (isSendingContact) return;

    setIsSendingContact(true);
    setTimeout(() => {
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
      setRequests(prev => [req, ...prev]);
      setContactFirstName('');
      setContactLastName('');
      setContactInfo('');
      setContactAmount('');
      setContactNote('');
      setIsSendingContact(false);
      console.log('[Request] Contact request created:', req.id);
      toast.show('Request sent ✅');
      Alert.alert(
        '✅ Request Sent',
        `Your request to ${req.firstName} ${req.lastName} for ${getCurrencySymbol(req.currency)}${amountNum.toFixed(2)} ${req.currency} has been sent successfully.`
      );
    }, 600);
  };

  // ── Add Employee ──────────────────────────────────────────────────────────

  const handleAddEmployee = () => {
    if (!empFirstName.trim()) return Alert.alert('Missing Info', 'Please enter a first name.');
    if (!empLastName.trim()) return Alert.alert('Missing Info', 'Please enter a last name.');
    if (!empEmail.trim() || !empEmail.includes('@')) {
      return Alert.alert('Invalid Email', 'Please enter a valid email address.');
    }
    const emp: Employee = {
      id: uid(),
      firstName: empFirstName.trim(),
      lastName: empLastName.trim(),
      email: empEmail.trim().toLowerCase(),
    };
    setEmployees(prev => [...prev, emp]);
    setEmpFirstName('');
    setEmpLastName('');
    setEmpEmail('');
    setShowAddEmployee(false);
    Alert.alert('✅ Employee Added', `${emp.firstName} ${emp.lastName} has been added to your team.`);
  };

  // ── Payroll request ───────────────────────────────────────────────────────

  const handlePayrollSubmit = () => {
    console.log('[Request] Payroll/Employer submit pressed —', selectedEmployee?.firstName, payrollAmount, payrollCurrency);
    if (!selectedEmployee) {
      return Alert.alert('Select Employee', 'Please select an employee first.');
    }
    const amountNum = parseFloat(payrollAmount);
    if (!payrollAmount || isNaN(amountNum) || amountNum <= 0) {
      return Alert.alert('Invalid Amount', 'Please enter a valid amount.');
    }
    if (isSendingPayroll) return;

    Alert.alert(
      'Confirm Payroll Request',
      `Request ${getCurrencySymbol(payrollCurrency)}${amountNum.toFixed(2)} ${payrollCurrency} from ${selectedEmployee.firstName} ${selectedEmployee.lastName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Request',
          onPress: () => {
            setIsSendingPayroll(true);
            setTimeout(() => {
              const req: LocalRequest = {
                id: uid(),
                type: 'employer',
                firstName: selectedEmployee.firstName,
                lastName: selectedEmployee.lastName,
                contactInfo: selectedEmployee.email,
                amount: amountNum,
                currency: payrollCurrency,
                note: payrollNote.trim() || 'Payroll request',
                status: 'pending',
                createdAt: Date.now(),
              };
              setRequests(prev => [req, ...prev]);
              setPayrollAmount('');
              setPayrollNote('');
              setSelectedEmployee(null);
              setIsSendingPayroll(false);
              console.log('[Request] Employer request created:', req.id);
              toast.show('Request sent ✅');
              Alert.alert('✅ Request Sent', `Payment request sent to ${req.firstName} ${req.lastName}.`);
            }, 600);
          },
        },
      ]
    );
  };

  // ── Cancel / Share ────────────────────────────────────────────────────────

  const handleCancelRequest = (id: string) => {
    Alert.alert('Cancel Request', 'Are you sure?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: () => setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'cancelled' } : r)),
      },
    ]);
  };

  const handleShare = async (req: LocalRequest) => {
    const link = `egwallet://pay/${req.id}`;
    const msg = `Hi ${req.firstName}, I'm requesting ${getCurrencySymbol(req.currency)}${req.amount.toFixed(2)} ${req.currency}${req.note ? ` for "${req.note}"` : ''}.\n\nPay via EGWallet: ${link}`;
    try { await Share.share({ message: msg }); } catch (_) {}
  };

  // ── Dynamic QR ────────────────────────────────────────────────────────────

  const handleGenerateDynamicQR = () => {
    console.log('[Request] Generate QR pressed —', qrAmount, qrCurrency);
    const amountNum = parseFloat(qrAmount);
    if (!qrAmount || isNaN(amountNum) || amountNum <= 0) {
      return Alert.alert('Invalid Amount', 'Please enter a valid amount.');
    }
    setDynamicQR({
      value: JSON.stringify({
        type: 'payment_request',
        walletId: realWalletId,
        amount: amountNum,
        currency: qrCurrency,
        memo: qrMemo || qrPurpose || 'Payment',
        requestId: `req-${Date.now()}`,
        expiresAt: Date.now() + 30 * 60000,
      }),
      expiresAt: Date.now() + 30 * 60000,
    });
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const contactRequests = requests.filter(r => r.type === 'contact');
  const employerRequests = requests.filter(r => r.type === 'employer');

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <OfflineErrorBanner visible={!isOnline} onRetry={() => {}} />

      <View style={styles.header}>
        <Text style={styles.title}>Request</Text>
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
              {tab === 'contact' ? 'Contact' : tab === 'employer' ? 'Employer' : 'QR Code'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ══════════════════════ CONTACT TAB ══════════════════════ */}
      {activeTab === 'contact' && (
        <>
          <View style={styles.form}>
            <Text style={styles.formSectionTitle}>Request Money From</Text>

            <View style={styles.nameRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>First Name</Text>
                <TextInput
                  style={styles.input}
                  value={contactFirstName}
                  onChangeText={setContactFirstName}
                  placeholder="Jane"
                  placeholderTextColor="#999"
                  autoCapitalize="words"
                />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.label}>Last Name</Text>
                <TextInput
                  style={styles.input}
                  value={contactLastName}
                  onChangeText={setContactLastName}
                  placeholder="Doe"
                  placeholderTextColor="#999"
                  autoCapitalize="words"
                />
              </View>
            </View>

            <Text style={styles.label}>Email or Phone</Text>
            <TextInput
              style={styles.input}
              value={contactInfo}
              onChangeText={setContactInfo}
              placeholder="jane@example.com or +1 555 000 0000"
              placeholderTextColor="#999"
              keyboardType="email-address"
              autoCapitalize="none"
            />

            <View style={styles.amountRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Amount</Text>
                <TextInput
                  style={styles.input}
                  value={contactAmount}
                  onChangeText={setContactAmount}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor="#999"
                />
              </View>
              <View style={{ marginLeft: 12, minWidth: 90 }}>
                <Text style={styles.label}>Currency</Text>
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

            <Text style={styles.label}>Note (Optional)</Text>
            <TextInput
              style={[styles.input, styles.memoInput]}
              value={contactNote}
              onChangeText={setContactNote}
              placeholder="What's this for?"
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
                    <Text style={styles.createButtonText}>Send Request</Text>
                  </>
                )
              }
            </TouchableOpacity>
          </View>

          {/* Contact History */}
          {contactRequests.length > 0 && (
            <>
              <Text style={styles.historyTitle}>Request History</Text>
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
                        {req.status.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.dateText}>{formatDate(req.createdAt)}</Text>
                  </View>
                  <Text style={styles.requestName}>{req.firstName} {req.lastName}</Text>
                  <Text style={styles.requestContact}>{req.contactInfo}</Text>
                  <Text style={styles.amountText}>
                    {getCurrencySymbol(req.currency)}{req.amount.toFixed(2)} {req.currency}
                  </Text>
                  {req.note ? <Text style={styles.memoText}>{req.note}</Text> : null}
                  {req.status === 'pending' && (
                    <View style={styles.actions}>
                      <TouchableOpacity style={styles.shareButton} onPress={() => handleShare(req)}>
                        <Ionicons name="share-social" size={18} color="#007AFF" />
                        <Text style={styles.shareButtonText}>Share</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.cancelButton} onPress={() => handleCancelRequest(req.id)}>
                        <Ionicons name="close-circle" size={18} color="#d32f2f" />
                        <Text style={styles.cancelButtonText}>Cancel</Text>
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
            <Text style={styles.formSectionTitle}>Team Members</Text>
            <TouchableOpacity
              style={styles.addEmployeeBtn}
              onPress={() => setShowAddEmployee(v => !v)}
              activeOpacity={0.8}
            >
              <Ionicons name={showAddEmployee ? 'close' : 'person-add'} size={16} color="#007AFF" />
              <Text style={styles.addEmployeeBtnText}>{showAddEmployee ? 'Cancel' : 'Add Employee'}</Text>
            </TouchableOpacity>
          </View>

          {/* Add Employee Form */}
          {showAddEmployee && (
            <View style={[styles.form, { marginBottom: 12 }]}>
              <Text style={styles.formSectionTitle}>New Employee</Text>

              <Text style={styles.label}>First Name</Text>
              <TextInput
                style={styles.input}
                value={empFirstName}
                onChangeText={setEmpFirstName}
                placeholder="John"
                placeholderTextColor="#999"
                autoCapitalize="words"
              />
              <Text style={styles.label}>Last Name</Text>
              <TextInput
                style={styles.input}
                value={empLastName}
                onChangeText={setEmpLastName}
                placeholder="Smith"
                placeholderTextColor="#999"
                autoCapitalize="words"
              />
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={empEmail}
                onChangeText={setEmpEmail}
                placeholder="john@company.com"
                placeholderTextColor="#999"
                keyboardType="email-address"
                autoCapitalize="none"
              />

              <TouchableOpacity style={styles.createButton} onPress={handleAddEmployee} activeOpacity={0.8}>
                <Ionicons name="person-add" size={18} color="#FFFFFF" />
                <Text style={styles.createButtonText}>Save Employee</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Empty state */}
          {employees.length === 0 && !showAddEmployee && (
            <View style={styles.emptyContainer}>
              <Ionicons name="people-outline" size={56} color="#CCCCCC" />
              <Text style={styles.emptyTitle}>No Employees Yet</Text>
              <Text style={styles.emptyText}>Add employees to request payments from them</Text>
              <TouchableOpacity
                style={[styles.createButton, { marginTop: 20, paddingHorizontal: 24 }]}
                onPress={() => setShowAddEmployee(true)}
              >
                <Ionicons name="person-add" size={18} color="#FFFFFF" />
                <Text style={styles.createButtonText}>Add First Employee</Text>
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
                <Text style={styles.employeeEmail}>{emp.email}</Text>
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
              <Text style={styles.formSectionTitle}>Request from {selectedEmployee.firstName}</Text>

              <View style={styles.amountRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Amount</Text>
                  <TextInput
                    style={styles.input}
                    value={payrollAmount}
                    onChangeText={setPayrollAmount}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#999"
                  />
                </View>
                <View style={{ marginLeft: 12, minWidth: 90 }}>
                  <Text style={styles.label}>Currency</Text>
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

              <Text style={styles.label}>Note (Optional)</Text>
              <TextInput
                style={[styles.input, styles.memoInput]}
                value={payrollNote}
                onChangeText={setPayrollNote}
                placeholder="January salary, bonus..."
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
                      <Ionicons name="send" size={18} color="#FFFFFF" />
                      <Text style={styles.createButtonText}>Send Request</Text>
                    </>
                  )
                }
              </TouchableOpacity>
            </View>
          )}

          {/* Payroll History */}
          {employerRequests.length > 0 && (
            <>
              <Text style={styles.historyTitle}>Payroll Requests</Text>
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
                        {req.status.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.dateText}>{formatDate(req.createdAt)}</Text>
                  </View>
                  <Text style={styles.requestName}>{req.firstName} {req.lastName}</Text>
                  <Text style={styles.requestContact}>{req.contactInfo}</Text>
                  <Text style={styles.amountText}>
                    {getCurrencySymbol(req.currency)}{req.amount.toFixed(2)} {req.currency}
                  </Text>
                  {req.note ? <Text style={styles.memoText}>{req.note}</Text> : null}
                  {req.status === 'pending' && (
                    <View style={styles.actions}>
                      <TouchableOpacity style={styles.cancelButton} onPress={() => handleCancelRequest(req.id)}>
                        <Ionicons name="close-circle" size={18} color="#d32f2f" />
                        <Text style={styles.cancelButtonText}>Cancel</Text>
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
              <Text style={styles.qrCardTitle}>Your Wallet QR Code</Text>
            </View>
            <Text style={styles.qrCardSub}>
              Show this to anyone — they scan and pay you instantly. Perfect for grocery stores, bars, open markets and more.
            </Text>
            <View style={styles.qrCenter}>
              {staticQRValue ? (
                <QRCode value={staticQRValue} size={200} backgroundColor="white" />
              ) : (
                <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="qr-code" size={80} color="#E1E8ED" />
                </View>
              )}
              <Text style={styles.qrPermanentLabel}>Permanent · No expiry</Text>
            </View>
          </View>

          {/* Divider */}
          <View style={styles.orDivider}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>OR REQUEST SPECIFIC AMOUNT</Text>
            <View style={styles.orLine} />
          </View>

          {/* Purpose presets */}
          <Text style={styles.label}>Select Purpose</Text>
          <View style={styles.purposeRow}>
            {QR_PURPOSES.map(p => (
              <TouchableOpacity
                key={p.label}
                style={[styles.purposeChip, qrPurpose === p.label && styles.purposeChipActive]}
                onPress={() => { setQrPurpose(p.label); setQrMemo(p.memo); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.purposeChipText, qrPurpose === p.label && styles.purposeChipTextActive]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.amountRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Amount</Text>
              <TextInput
                style={styles.input}
                value={qrAmount}
                onChangeText={setQrAmount}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor="#999"
              />
            </View>
            <View style={{ marginLeft: 12, minWidth: 90 }}>
              <Text style={styles.label}>Currency</Text>
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

          <Text style={styles.label}>Note (Optional)</Text>
          <TextInput
            style={styles.input}
            value={qrMemo}
            onChangeText={setQrMemo}
            placeholder="What's this for?"
            placeholderTextColor="#999"
          />

          <TouchableOpacity
            style={[styles.createButton, { marginTop: 16, marginBottom: 8 }]}
            onPress={handleGenerateDynamicQR}
            activeOpacity={0.8}
          >
            <Ionicons name="qr-code" size={20} color="#FFFFFF" />
            <Text style={styles.createButtonText}>Generate QR Code</Text>
          </TouchableOpacity>

          {dynamicQR && (
            <View style={styles.generatedQRCard}>
              <View style={styles.qrCardHeader}>
                <Ionicons name="checkmark-circle" size={22} color="#2E7D32" />
                <Text style={[styles.qrCardTitle, { color: '#2E7D32' }]}>QR Code Ready</Text>
              </View>
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
                <Text style={styles.clearQRText}>Generate New QR</Text>
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
            <Text style={styles.modalTitle}>Select Currency</Text>
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
              <Text style={styles.modalCloseText}>Cancel</Text>
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
