import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';

interface Balance {
  currency: string;
  amount: number;
}

interface EmployerProfile {
  id: string;
  companyName: string;
  taxId: string;
  verificationStatus: string;
  fundingWalletId: string;
  totalPayrollSent: number;
  totalBatches: number;
  fundingWallet: { id: string; balances: Balance[] } | null;
}

interface Employee {
  id: string;
  workerId: string;
  workerEmail: string;
  workerName: string;
  position: string;
  walletId?: string;
  status: string;
}

interface PayrollResultItem {
  workerId: string;
  workerEmail: string;
  status: 'success' | 'failed';
  amount?: number;
  currency?: string;
  transactionId?: string;
  error?: string;
}

interface BatchResult {
  batchId: string;
  successCount: number;
  failureCount: number;
  status: string;
  results: PayrollResultItem[];
}

type ActiveTab = 'employees' | 'payroll' | 'history';

export default function EmployerDashboardScreen() {
  const auth = useAuth();

  const [profile, setProfile] = useState<EmployerProfile | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollHistory, setPayrollHistory] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('employees');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [lastBatchResult, setLastBatchResult] = useState<BatchResult | null>(null);

  // Registration form — pre-filled with test data
  const [companyName, setCompanyName] = useState('EGWallet Demo Corp');
  const [taxId, setTaxId] = useState('GQ-2026-001');
  const [employeeCount, setEmployeeCount] = useState('5');

  // Add employee form — pre-filled with current user
  const [employeeEmail, setEmployeeEmail] = useState(auth.user?.email || '');
  const [employeeName, setEmployeeName] = useState('Demo Employee');
  const [employeePosition, setEmployeePosition] = useState('Software Engineer');

  // Payroll form — pre-filled with test values
  const [payrollAmount, setPayrollAmount] = useState('1000');
  const [payrollCurrency, setPayrollCurrency] = useState('XAF');
  const [payrollMemo, setPayrollMemo] = useState('Monthly Salary - March 2026');

  const buildHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  }), [auth.token]);

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/employer/profile`, {
        headers: buildHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data);
      } else {
        setProfile(null);
      }
    } catch {
      setProfile(null);
    }
  }, [auth.token]);

  const loadEmployees = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/employer/employees`, {
        headers: buildHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setEmployees(data.employees || []);
      }
    } catch {}
  }, [auth.token]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/employer/payroll-history`, {
        headers: buildHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setPayrollHistory(data.batches || []);
      }
    } catch {}
  }, [auth.token]);

  const loadAll = useCallback(async () => {
    await loadProfile();
    await loadEmployees();
    await loadHistory();
  }, [loadProfile, loadEmployees, loadHistory]);

  useEffect(() => {
    loadAll().finally(() => setInitialLoading(false));
  }, []);

  // Auto-verify employer if still pending
  useEffect(() => {
    if (profile && profile.verificationStatus === 'pending') {
      autoVerifyEmployer(profile.id);
    }
  }, [profile?.id, profile?.verificationStatus]);

  async function autoVerifyEmployer(employerId: string) {
    try {
      await fetch(`${API_BASE}/admin/verify-employer`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ employerId, verificationStatus: 'verified' }),
      });
      await loadProfile();
    } catch {}
  }

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  async function handleRegister() {
    if (!companyName.trim() || !taxId.trim()) {
      Alert.alert('Error', 'Company name and Tax ID are required');
      return;
    }
    setLoading(true);
    try {
      // Step 1: Upgrade KYC tier to 2 (required for employer registration)
      await fetch(`${API_BASE}/admin/update-kyc-tier`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ userId: auth.user!.id, kycTier: 2, kycStatus: 'approved' }),
      });

      // Step 2: Register employer
      const regRes = await fetch(`${API_BASE}/employer/register`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          companyName: companyName.trim(),
          taxId: taxId.trim(),
          businessLicense: 'BL-2026-DEMO',
          employeeCount: parseInt(employeeCount) || 5,
          fundingCurrency: 'XAF',
        }),
      });
      const regData = await regRes.json();
      if (!regRes.ok) throw new Error(regData.error || 'Registration failed');

      // Step 3: Auto-verify so payroll features unlock immediately
      await fetch(`${API_BASE}/admin/verify-employer`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ employerId: regData.employer.id, verificationStatus: 'verified' }),
      });

      await loadAll();
      Alert.alert('Success', `"${companyName}" is now registered and verified!\n\nNext: Add employees, fund your wallet, then run payroll.`);
    } catch (e: any) {
      Alert.alert('Registration Failed', e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFundWallet() {
    if (!profile) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/employer/fund-wallet`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ amount: 1000000, currency: payrollCurrency }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fund failed');
      await loadProfile();
      Alert.alert('Wallet Funded', `Added 1,000,000 ${payrollCurrency} to your funding wallet.\nNew balance: ${data.balance.amount.toLocaleString()} ${payrollCurrency}`);
    } catch (e: any) {
      Alert.alert('Fund Failed', e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddEmployee() {
    if (!employeeEmail.trim()) {
      Alert.alert('Error', 'Employee email is required');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/employer/add-employee`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          workerEmail: employeeEmail.trim().toLowerCase(),
          workerName: employeeName.trim() || employeeEmail.trim(),
          position: employeePosition.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add employee');
      await loadEmployees();
      Alert.alert('Employee Added', `${employeeEmail} has been added to your payroll list.`);
    } catch (e: any) {
      Alert.alert('Add Employee Failed', e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUploadPayroll() {
    const readyCount = employees.filter(e => e.walletId && e.status === 'active').length;
    if (readyCount === 0) {
      Alert.alert('No Employees', 'Add at least one employee with a wallet before uploading payroll.');
      return;
    }
    const preview = employees
      .filter(e => e.status === 'active')
      .map(e => `• ${e.workerEmail}: ${payrollAmount} ${payrollCurrency}`)
      .join('\n');
    Alert.alert(
      'Payroll Loaded ✅',
      `${readyCount} employee(s) ready for payment:\n\n${preview}\n\nPress "Run Payroll" to execute.`,
      [{ text: 'OK' }]
    );
  }

  async function handleRunPayroll() {
    const readyEmployees = employees.filter(e => e.walletId && e.status === 'active');
    if (readyEmployees.length === 0) {
      Alert.alert('No Employees Ready', 'Add employees first. They must be registered EGWallet users with a wallet.');
      return;
    }

    const amount = parseFloat(payrollAmount);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Invalid Amount', 'Enter a positive payroll amount');
      return;
    }

    const total = amount * readyEmployees.length;
    const fundingBalance = getFundingBalance();

    if (fundingBalance < total) {
      Alert.alert(
        'Insufficient Funds',
        `Funding wallet has ${fundingBalance.toLocaleString()} ${payrollCurrency}, but need ${total.toLocaleString()} ${payrollCurrency}.\n\nTap "Fund Wallet (Demo)" to add test funds.`
      );
      return;
    }

    Alert.alert(
      'Confirm Payroll',
      `Pay ${readyEmployees.length} employee(s)?\n\nAmount: ${amount.toLocaleString()} ${payrollCurrency} each\nTotal: ${total.toLocaleString()} ${payrollCurrency}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Run Payroll',
          onPress: async () => {
            setLoading(true);
            try {
              const payrollItems = readyEmployees.map(e => ({
                workerId: e.workerId,
                walletId: e.walletId!,
                workerEmail: e.workerEmail,
                amount,
                currency: payrollCurrency,
                memo: payrollMemo,
              }));

              const res = await fetch(`${API_BASE}/employer/bulk-payment`, {
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify({
                  payrollItems,
                  payPeriod: new Date().toISOString().substring(0, 7),
                  notes: payrollMemo,
                }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Payroll failed');

              setLastBatchResult(data);
              await loadProfile();
              await loadHistory();
              setActiveTab('history');

              Alert.alert(
                data.failureCount === 0 ? 'Payroll Complete ✅' : 'Payroll Partial ⚠️',
                `✅ ${data.successCount} paid successfully\n❌ ${data.failureCount} failed\n\nBatch ID: ${data.batchId}`
              );
            } catch (e: any) {
              Alert.alert('Payroll Failed', e.message);
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  }

  function getFundingBalance(): number {
    if (!profile?.fundingWallet) return 0;
    const b = profile.fundingWallet.balances?.find(b => b.currency === payrollCurrency);
    return b?.amount || 0;
  }

  function formatBalance(amount: number): string {
    return amount.toLocaleString();
  }

  if (initialLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading employer data...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#007AFF" />}
    >
      <View style={styles.content}>

        {/* ── NOT REGISTERED: Registration Form ── */}
        {!profile && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="business" size={24} color="#007AFF" />
              <Text style={styles.sectionTitle}>REGISTER AS EMPLOYER</Text>
            </View>
            <Text style={styles.helpText}>
              Set up your employer account to manage employees and run payroll.
              Pre-filled with demo data — tap Register to get started.
            </Text>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Company Name *</Text>
              <TextInput
                style={styles.input}
                value={companyName}
                onChangeText={setCompanyName}
                placeholder="EGWallet Demo Corp"
                placeholderTextColor="#aaa"
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Tax ID *</Text>
              <TextInput
                style={styles.input}
                value={taxId}
                onChangeText={setTaxId}
                placeholder="GQ-2026-001"
                placeholderTextColor="#aaa"
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Number of Employees</Text>
              <TextInput
                style={styles.input}
                value={employeeCount}
                onChangeText={setEmployeeCount}
                placeholder="5"
                keyboardType="numeric"
                placeholderTextColor="#aaa"
              />
            </View>

            <TouchableOpacity
              style={[styles.primaryButton, loading && styles.buttonDisabled]}
              onPress={handleRegister}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : (
                  <>
                    <Ionicons name="business" size={18} color="#fff" />
                    <Text style={styles.primaryButtonText}>Register Employer</Text>
                  </>
                )
              }
            </TouchableOpacity>
          </View>
        )}

        {/* ── REGISTERED: Profile card + tabs ── */}
        {profile && (
          <>
            {/* Profile Summary Card */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="business" size={24} color="#007AFF" />
                <Text style={styles.sectionTitle}>EMPLOYER PROFILE</Text>
              </View>

              <View style={styles.infoRow}>
                <Ionicons name="briefcase" size={18} color="#657786" />
                <Text style={styles.infoLabel}>Company</Text>
                <Text style={styles.infoValue} numberOfLines={1}>{profile.companyName}</Text>
              </View>

              <View style={styles.infoRow}>
                <Ionicons
                  name={profile.verificationStatus === 'verified' ? 'shield-checkmark' : 'time'}
                  size={18}
                  color={profile.verificationStatus === 'verified' ? '#34C759' : '#FF9500'}
                />
                <Text style={styles.infoLabel}>Status</Text>
                <Text style={[
                  styles.infoValue,
                  { color: profile.verificationStatus === 'verified' ? '#34C759' : '#FF9500' },
                ]}>
                  {profile.verificationStatus === 'verified' ? 'Verified ✅' : 'Pending verification...'}
                </Text>
              </View>

              <View style={styles.infoRow}>
                <Ionicons name="wallet" size={18} color="#657786" />
                <Text style={styles.infoLabel}>Funding Wallet</Text>
                <Text style={styles.infoValue}>
                  {formatBalance(getFundingBalance())} {payrollCurrency}
                </Text>
              </View>

              <View style={styles.infoRow}>
                <Ionicons name="receipt" size={18} color="#657786" />
                <Text style={styles.infoLabel}>Batches Run</Text>
                <Text style={styles.infoValue}>{profile.totalBatches}</Text>
              </View>

              <TouchableOpacity
                style={[styles.secondaryButton, loading && styles.buttonDisabled]}
                onPress={handleFundWallet}
                disabled={loading}
              >
                <Ionicons name="add-circle" size={18} color="#007AFF" />
                <Text style={styles.secondaryButtonText}>Fund Wallet (Demo +1,000,000)</Text>
              </TouchableOpacity>
            </View>

            {/* Tab Bar */}
            <View style={styles.tabBar}>
              {(['employees', 'payroll', 'history'] as ActiveTab[]).map(tab => (
                <TouchableOpacity
                  key={tab}
                  style={[styles.tab, activeTab === tab && styles.tabActive]}
                  onPress={() => setActiveTab(tab)}
                >
                  <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                    {tab === 'employees'
                      ? `Employees (${employees.length})`
                      : tab === 'payroll'
                        ? 'Run Payroll'
                        : `History (${payrollHistory.length})`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* ── EMPLOYEES TAB ── */}
            {activeTab === 'employees' && (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Ionicons name="person-add" size={24} color="#007AFF" />
                  <Text style={styles.sectionTitle}>ADD EMPLOYEE</Text>
                </View>
                <Text style={styles.helpText}>
                  Employee must be a registered EGWallet user. Pre-filled with your own account for testing.
                </Text>

                <View style={styles.formGroup}>
                  <Text style={styles.label}>Email *</Text>
                  <TextInput
                    style={styles.input}
                    value={employeeEmail}
                    onChangeText={setEmployeeEmail}
                    placeholder="employee@example.com"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    placeholderTextColor="#aaa"
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={employeeName}
                    onChangeText={setEmployeeName}
                    placeholder="Full Name"
                    placeholderTextColor="#aaa"
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.label}>Position</Text>
                  <TextInput
                    style={styles.input}
                    value={employeePosition}
                    onChangeText={setEmployeePosition}
                    placeholder="Software Engineer"
                    placeholderTextColor="#aaa"
                  />
                </View>

                <TouchableOpacity
                  style={[styles.primaryButton, loading && styles.buttonDisabled]}
                  onPress={handleAddEmployee}
                  disabled={loading}
                >
                  {loading
                    ? <ActivityIndicator color="#fff" />
                    : (
                      <>
                        <Ionicons name="person-add" size={18} color="#fff" />
                        <Text style={styles.primaryButtonText}>Add Employee</Text>
                      </>
                    )
                  }
                </TouchableOpacity>

                {/* Employee List */}
                {employees.length > 0 && (
                  <View style={styles.employeeList}>
                    <Text style={styles.subSectionTitle}>
                      Added Employees ({employees.length})
                    </Text>
                    {employees.map(emp => (
                      <View key={emp.id} style={styles.employeeRow}>
                        <View style={styles.employeeAvatar}>
                          <Ionicons name="person" size={20} color="#007AFF" />
                        </View>
                        <View style={styles.employeeInfo}>
                          <Text style={styles.employeeName}>{emp.workerName || emp.workerEmail}</Text>
                          <Text style={styles.employeeEmail}>{emp.workerEmail}</Text>
                          {emp.position ? <Text style={styles.employeeRole}>{emp.position}</Text> : null}
                        </View>
                        <View style={[styles.statusBadge, emp.walletId ? styles.statusGreen : styles.statusOrange]}>
                          <Text style={styles.statusBadgeText}>
                            {emp.walletId ? '✅ Ready' : '⚠️ No wallet'}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* ── PAYROLL TAB ── */}
            {activeTab === 'payroll' && (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Ionicons name="cash" size={24} color="#007AFF" />
                  <Text style={styles.sectionTitle}>PAYROLL</Text>
                </View>

                {employees.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Ionicons name="people-outline" size={40} color="#C1C9D2" />
                    <Text style={styles.emptyText}>Add employees first to run payroll.</Text>
                    <TouchableOpacity onPress={() => setActiveTab('employees')}>
                      <Text style={styles.linkText}>→ Go to Employees tab</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <View style={styles.formGroup}>
                      <Text style={styles.label}>Amount per Employee</Text>
                      <TextInput
                        style={styles.input}
                        value={payrollAmount}
                        onChangeText={setPayrollAmount}
                        placeholder="1000"
                        keyboardType="numeric"
                        placeholderTextColor="#aaa"
                      />
                    </View>

                    <View style={styles.formGroup}>
                      <Text style={styles.label}>Currency</Text>
                      <TextInput
                        style={styles.input}
                        value={payrollCurrency}
                        onChangeText={text => setPayrollCurrency(text.toUpperCase())}
                        placeholder="XAF"
                        autoCapitalize="characters"
                        maxLength={5}
                        placeholderTextColor="#aaa"
                      />
                    </View>

                    <View style={styles.formGroup}>
                      <Text style={styles.label}>Memo</Text>
                      <TextInput
                        style={styles.input}
                        value={payrollMemo}
                        onChangeText={setPayrollMemo}
                        placeholder="Monthly Salary"
                        placeholderTextColor="#aaa"
                      />
                    </View>

                    {/* Payroll Preview Table */}
                    <Text style={styles.subSectionTitle}>Payroll Preview</Text>
                    <View style={styles.table}>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.tableCell, styles.tableCellWide, styles.tableHeaderText]}>Employee</Text>
                        <Text style={[styles.tableCell, styles.tableHeaderText]}>Amount</Text>
                        <Text style={[styles.tableCell, styles.tableHeaderText]}>CCY</Text>
                      </View>
                      {employees.filter(e => e.status === 'active').map(emp => (
                        <View key={emp.id} style={styles.tableRow}>
                          <Text style={[styles.tableCell, styles.tableCellWide]} numberOfLines={1}>
                            {emp.workerEmail}
                          </Text>
                          <Text style={styles.tableCell}>{payrollAmount}</Text>
                          <Text style={styles.tableCell}>{payrollCurrency}</Text>
                        </View>
                      ))}
                      <View style={styles.tableTotalRow}>
                        <Text style={[styles.tableCell, styles.tableCellWide, styles.tableTotalText]}>
                          TOTAL ({employees.filter(e => e.status === 'active').length})
                        </Text>
                        <Text style={[styles.tableCell, styles.tableTotalText]}>
                          {((parseFloat(payrollAmount) || 0) * employees.filter(e => e.status === 'active').length).toLocaleString()}
                        </Text>
                        <Text style={[styles.tableCell, styles.tableTotalText]}>{payrollCurrency}</Text>
                      </View>
                    </View>

                    {/* Action Buttons */}
                    <View style={styles.buttonRow}>
                      <TouchableOpacity
                        style={[styles.secondaryButton, { flex: 1, marginRight: 6 }]}
                        onPress={handleUploadPayroll}
                      >
                        <Ionicons name="cloud-upload" size={17} color="#007AFF" />
                        <Text style={styles.secondaryButtonText}>Upload Payroll</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.primaryButton, { flex: 1, marginLeft: 6 }, loading && styles.buttonDisabled]}
                        onPress={handleRunPayroll}
                        disabled={loading}
                      >
                        {loading
                          ? <ActivityIndicator color="#fff" size="small" />
                          : (
                            <>
                              <Ionicons name="play" size={17} color="#fff" />
                              <Text style={styles.primaryButtonText}>Run Payroll</Text>
                            </>
                          )
                        }
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </View>
            )}

            {/* ── HISTORY TAB ── */}
            {activeTab === 'history' && (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Ionicons name="receipt" size={24} color="#007AFF" />
                  <Text style={styles.sectionTitle}>PAYROLL HISTORY</Text>
                </View>

                {payrollHistory.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Ionicons name="receipt-outline" size={40} color="#C1C9D2" />
                    <Text style={styles.emptyText}>No payroll batches yet.</Text>
                    <TouchableOpacity onPress={() => setActiveTab('payroll')}>
                      <Text style={styles.linkText}>→ Go to Payroll tab</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  payrollHistory.map(batch => (
                    <View key={batch.id} style={styles.batchCard}>
                      <View style={styles.batchHeader}>
                        <Text style={styles.batchId} numberOfLines={1}>{batch.id}</Text>
                        <View style={[
                          styles.batchStatusBadge,
                          batch.status === 'completed' ? styles.statusGreen : styles.statusOrange,
                        ]}>
                          <Text style={styles.statusBadgeText}>
                            {batch.status === 'completed' ? '✅ Complete' : '⚠️ Partial'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.batchDate}>
                        {new Date(batch.createdAt).toLocaleDateString()} · Period: {batch.payPeriod}
                      </Text>
                      <Text style={styles.batchSummary}>
                        ✅ {batch.successCount} paid · ❌ {batch.failureCount} failed · {batch.totalItems} total
                      </Text>
                    </View>
                  ))
                )}
              </View>
            )}
          </>
        )}

        {/* ── LATEST TRANSACTION LOG (shows after payroll runs) ── */}
        {lastBatchResult && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="checkmark-circle" size={24} color="#34C759" />
              <Text style={styles.sectionTitle}>TRANSACTION LOG</Text>
            </View>

            <Text style={styles.batchId} numberOfLines={1}>Batch: {lastBatchResult.batchId}</Text>
            <Text style={[styles.batchSummary, { marginTop: 4, marginBottom: 12 }]}>
              ✅ {lastBatchResult.successCount} successful · ❌ {lastBatchResult.failureCount} failed
            </Text>

            {lastBatchResult.results.map((r, i) => (
              <View key={i} style={styles.resultRow}>
                <Ionicons
                  name={r.status === 'success' ? 'checkmark-circle' : 'close-circle'}
                  size={20}
                  color={r.status === 'success' ? '#34C759' : '#FF3B30'}
                />
                <View style={styles.resultInfo}>
                  <Text style={styles.resultEmail}>{r.workerEmail}</Text>
                  {r.status === 'success'
                    ? (
                      <Text style={styles.resultDetail}>
                        {r.amount?.toLocaleString()} {r.currency} · TX: {r.transactionId?.substring(0, 14)}…
                      </Text>
                    )
                    : <Text style={[styles.resultDetail, { color: '#FF3B30' }]}>{r.error}</Text>
                  }
                </View>
              </View>
            ))}

            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 12 }]}
              onPress={() => setLastBatchResult(null)}
            >
              <Ionicons name="close" size={16} color="#007AFF" />
              <Text style={styles.secondaryButtonText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}

      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F7FA',
  },
  loadingText: {
    marginTop: 12,
    color: '#657786',
    fontSize: 14,
  },
  content: {
    padding: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#14171A',
    marginLeft: 8,
    letterSpacing: 0.5,
  },
  helpText: {
    fontSize: 13,
    color: '#657786',
    marginBottom: 12,
    lineHeight: 18,
  },
  formGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E1E8ED',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#14171A',
    backgroundColor: '#F5F7FA',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 20,
    gap: 6,
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 20,
    gap: 6,
    marginTop: 8,
  },
  secondaryButtonText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 6,
  },
  infoLabel: {
    fontSize: 13,
    color: '#657786',
    width: 120,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 10,
    marginBottom: 16,
    padding: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: '#007AFF',
  },
  tabText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#657786',
    textAlign: 'center',
  },
  tabTextActive: {
    color: '#fff',
  },
  subSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#14171A',
    marginTop: 8,
    marginBottom: 8,
  },
  employeeList: {
    marginTop: 16,
  },
  employeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#F0F3F5',
    gap: 10,
  },
  employeeAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E8F1FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  employeeInfo: {
    flex: 1,
  },
  employeeName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  employeeEmail: {
    fontSize: 12,
    color: '#657786',
  },
  employeeRole: {
    fontSize: 12,
    color: '#007AFF',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  batchStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    flexShrink: 0,
  },
  statusGreen: {
    backgroundColor: '#E8F8EE',
  },
  statusOrange: {
    backgroundColor: '#FFF3E0',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#14171A',
  },
  table: {
    borderWidth: 1,
    borderColor: '#E1E8ED',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 4,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#F5F7FA',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopWidth: 1,
    borderTopColor: '#F0F3F5',
  },
  tableTotalRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#F5F7FA',
    borderTopWidth: 1.5,
    borderTopColor: '#E1E8ED',
  },
  tableCell: {
    flex: 1,
    fontSize: 12,
    color: '#14171A',
  },
  tableCellWide: {
    flex: 2,
  },
  tableHeaderText: {
    fontWeight: '700',
    color: '#657786',
    fontSize: 11,
  },
  tableTotalText: {
    fontWeight: '700',
    color: '#14171A',
    fontSize: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#657786',
    textAlign: 'center',
  },
  linkText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '600',
  },
  batchCard: {
    backgroundColor: '#F5F7FA',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  batchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  batchId: {
    fontSize: 11,
    color: '#657786',
    flex: 1,
    fontFamily: 'monospace' as const,
  },
  batchDate: {
    fontSize: 12,
    color: '#657786',
    marginBottom: 4,
  },
  batchSummary: {
    fontSize: 13,
    fontWeight: '600',
    color: '#14171A',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#F0F3F5',
    gap: 10,
  },
  resultInfo: {
    flex: 1,
  },
  resultEmail: {
    fontSize: 13,
    fontWeight: '600',
    color: '#14171A',
  },
  resultDetail: {
    fontSize: 12,
    color: '#657786',
    marginTop: 2,
  },
});
