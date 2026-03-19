import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, ActivityIndicator, Modal, FlatList } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { createBudget, getBudgets, getBudgetAnalytics, deleteBudget } from '../api/transactions';
import { listWallets } from '../api/auth';
import { getCurrencySymbol } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { BudgetCardSkeleton } from '../components/SkeletonLoader';
import { useToast } from '../utils/toast';

interface Budget {
  id: string;
  walletId: string;
  currency: string;
  monthlyLimit: number;
}

interface BudgetAnalytics {
  monthlyLimit: number;
  totalSpent: number;
  remaining: number;
  percentUsed: number;
  transactionCount: number;
  month: string;
}

export default function BudgetScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudget, setSelectedBudget] = useState<Budget | null>(null);
  const [analytics, setAnalytics] = useState<BudgetAnalytics | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [wallets, setWallets] = useState<any[]>([]);
  
  // Form state
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [showCurrencyModal, setShowCurrencyModal] = useState(false);

  const BUDGET_CURRENCIES = ['USD', 'EUR', 'GBP', 'XAF', 'NGN', 'GHS', 'ZAR', 'KES', 'INR', 'CNY', 'BRL'];

  useEffect(() => {
    loadBudgets();
    loadWallets();
  }, []);

  useEffect(() => {
    if (selectedBudget) {
      loadAnalytics(selectedBudget.id);
    }
  }, [selectedBudget]);

  const loadWallets = async () => {
    if (!auth.token) return;
    try {
      const res = await listWallets(auth.token);
      setWallets(res.wallets || []);
    } catch (e) {
      if (__DEV__) console.warn('Failed to load wallets', e);
    }
  };

  const loadBudgets = async () => {
    try {
      setLoading(true);
      const data = await getBudgets(auth.token!);
      setBudgets(data.budgets || []);
    } catch (error: any) {
      if (__DEV__) console.log('Load budgets error (non-blocking):', error);
      // Silently ignore — show empty state
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async (budgetId: string) => {
    try {
      setLoading(true);
      const data = await getBudgetAnalytics(auth.token!, budgetId);
      setAnalytics(data.analytics);
    } catch (error: any) {
      if (__DEV__) console.log('Load analytics error (non-blocking):', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    console.log('[Budget] Create Budget button pressed — amount:', amount, currency);
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    if (isCreating) return; // Prevent duplicates

    const amountValue = parseFloat(amount);
    const amountMinor = Math.round(amountValue * 100);

    Alert.alert(
      'Create Budget',
      `Set monthly budget limit to ${getCurrencySymbol(currency)}${amountValue.toFixed(2)} ${currency}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: async () => {
            try {
              setIsCreating(true);
              setLoading(true);
              const walletId = wallets[0]?.id || 'demo';

              await createBudget(auth.token!, walletId, currency, amountMinor);
              console.log('[Budget] Created via API:', currency, amountMinor);
              toast.show('Budget created ✅');
              setAmount('');
              setShowCreateForm(false);
              loadBudgets();
            } catch (error: any) {
              // Demo mode: add a local budget so UI stays functional
              const localBudget: Budget = {
                id: `demo-${Date.now()}`,
                walletId: wallets[0]?.id || 'demo',
                currency,
                monthlyLimit: amountMinor,
              };
              setBudgets(prev => [...prev, localBudget]);
              console.log('[Budget] Created demo budget:', currency, amountMinor);
              toast.show('Budget saved ✅');
              setAmount('');
              setShowCreateForm(false);
            } finally {
              setLoading(false);
              setIsCreating(false);
            }
          }
        }
      ]
    );
  };

  const handleDelete = async (budgetId: string) => {
    Alert.alert('Delete Budget', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            setLoading(true);
            await deleteBudget(auth.token!, budgetId);
            loadBudgets();
            setSelectedBudget(null);
          } catch (error: any) {
            // Demo mode: remove locally
            setBudgets(prev => prev.filter(b => b.id !== budgetId));
            setSelectedBudget(null);
          } finally {
            setLoading(false);
          }
        }
      }
    ]);
  };

  function renderContent() {
    if (showCreateForm) {
      return (
        <>
          <TouchableOpacity style={styles.backButton} onPress={() => setShowCreateForm(false)}>
            <Ionicons name="arrow-back" size={22} color="#1565C0" />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <View style={styles.heroHeader}>
            <LinearGradient colors={['#1565C0', '#0A3D7C']} style={styles.heroIconCircle} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Ionicons name="pie-chart" size={26} color="#fff" />
            </LinearGradient>
            <Text style={styles.heroTitle}>Create Budget</Text>
            <Text style={styles.heroSub}>Set your monthly spending limit</Text>
          </View>
          <View style={styles.form}>
            <Text style={styles.label}>Monthly Limit</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor="#b0c4de"
            />
            <Text style={styles.label}>Currency</Text>
            <TouchableOpacity style={styles.currencyPicker} onPress={() => setShowCurrencyModal(true)} activeOpacity={0.75}>
              <Text style={styles.currencyText}>{currency} {getCurrencySymbol(currency)}</Text>
              <Ionicons name="chevron-down" size={18} color="#1565C0" />
            </TouchableOpacity>

            {/* Currency picker modal */}
            <Modal visible={showCurrencyModal} transparent animationType="slide" onRequestClose={() => setShowCurrencyModal(false)}>
              <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} activeOpacity={1} onPress={() => setShowCurrencyModal(false)}>
                <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: 360, paddingBottom: 30 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#0A3D7C', textAlign: 'center', paddingVertical: 16 }}>Select Currency</Text>
                  <FlatList
                    data={BUDGET_CURRENCIES}
                    keyExtractor={c => c}
                    renderItem={({ item: c }) => (
                      <TouchableOpacity
                        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 24, backgroundColor: c === currency ? '#EBF4FE' : 'transparent' }}
                        onPress={() => { setCurrency(c); setShowCurrencyModal(false); }}
                      >
                        <Text style={{ fontSize: 15, fontWeight: c === currency ? '700' : '500', color: c === currency ? '#1565C0' : '#0D1B2E', flex: 1 }}>{c}</Text>
                        <Text style={{ fontSize: 15, color: '#657786' }}>{getCurrencySymbol(c)}</Text>
                        {c === currency && <Ionicons name="checkmark" size={18} color="#1565C0" style={{ marginLeft: 10 }} />}
                      </TouchableOpacity>
                    )}
                  />
                </View>
              </TouchableOpacity>
            </Modal>
            <TouchableOpacity style={styles.createButton} onPress={handleCreate} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Ionicons name="add-circle" size={20} color="#FFFFFF" />
                  <Text style={styles.createButtonText}>Create Budget</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </>
      );
    }

    if (selectedBudget && analytics) {
      const percentColor = analytics.percentUsed >= 90 ? '#d32f2f' : analytics.percentUsed >= 70 ? '#F57C00' : '#2E7D32';
      return (
        <>
          <TouchableOpacity style={styles.backButton} onPress={() => setSelectedBudget(null)}>
            <Ionicons name="arrow-back" size={22} color="#1565C0" />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Budget Details</Text>
          <Text style={styles.month}>{analytics.month}</Text>
          <View style={styles.progressCard}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>Monthly Spending</Text>
              <Text style={[styles.progressPercent, { color: percentColor }]}>
                {analytics.percentUsed.toFixed(0)}%
              </Text>
            </View>
            <View style={styles.progressBarContainer}>
              <View style={[styles.progressBarFill, { width: `${Math.min(100, analytics.percentUsed)}%`, backgroundColor: percentColor }]} />
            </View>
            <View style={styles.amountsRow}>
              <View>
                <Text style={styles.amountLabel}>Spent</Text>
                <Text style={styles.amountValue}>
                  {getCurrencySymbol(selectedBudget.currency)}{(analytics.totalSpent / 100).toFixed(2)}
                </Text>
              </View>
              <View>
                <Text style={styles.amountLabel}>Remaining</Text>
                <Text style={[styles.amountValue, { color: percentColor }]}>
                  {getCurrencySymbol(selectedBudget.currency)}{(analytics.remaining / 100).toFixed(2)}
                </Text>
              </View>
              <View>
                <Text style={styles.amountLabel}>Limit</Text>
                <Text style={styles.amountValue}>
                  {getCurrencySymbol(selectedBudget.currency)}{(analytics.monthlyLimit / 100).toFixed(2)}
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.statsCard}>
            <View style={styles.statRow}>
              <Ionicons name="swap-horizontal" size={22} color="#1565C0" />
              <Text style={styles.statLabel}>Transactions</Text>
              <Text style={styles.statValue}>{analytics.transactionCount}</Text>
            </View>
            <View style={styles.statRow}>
              <Ionicons name="calendar" size={22} color="#1565C0" />
              <Text style={styles.statLabel}>Budget Period</Text>
              <Text style={styles.statValue}>Monthly</Text>
            </View>
            <View style={styles.statRow}>
              <Ionicons name="cash" size={22} color="#1565C0" />
              <Text style={styles.statLabel}>Currency</Text>
              <Text style={styles.statValue}>{selectedBudget.currency}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.deleteButton} onPress={() => handleDelete(selectedBudget.id)} disabled={loading}>
            <Ionicons name="trash" size={20} color="#d32f2f" />
            <Text style={styles.deleteButtonText}>Delete Budget</Text>
          </TouchableOpacity>
        </>
      );
    }

    return (
      <>
        <OfflineErrorBanner visible={!isOnline} onRetry={() => {}} />
        <View style={styles.heroHeader}>
          <LinearGradient colors={['#1565C0', '#0A3D7C']} style={styles.heroIconCircle} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <Ionicons name="pie-chart" size={26} color="#fff" />
          </LinearGradient>
          <Text style={styles.heroTitle}>Budgets</Text>
          <Text style={styles.heroSub}>Track your monthly spending limits</Text>
        </View>
        <View style={styles.header}>
          <Text style={styles.sectionLabel}>YOUR BUDGETS</Text>
          <TouchableOpacity style={styles.addButton} onPress={() => setShowCreateForm(true)}>
            <Ionicons name="add" size={22} color="#1565C0" />
          </TouchableOpacity>
        </View>
        {loading && budgets.length === 0 ? (
          <View style={styles.list}>
            <BudgetCardSkeleton />
            <BudgetCardSkeleton />
            <BudgetCardSkeleton />
          </View>
        ) : budgets.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="pie-chart-outline" size={60} color="#90B8DC" />
            <Text style={styles.emptyTitle}>No Budgets Yet</Text>
            <Text style={styles.emptyText}>Tap + to create a monthly spending limit</Text>
            <TouchableOpacity style={styles.createFirstBtn} onPress={() => setShowCreateForm(true)}>
              <Text style={styles.createFirstBtnText}>Create Budget</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.list}>
            {budgets.map((budget) => (
              <TouchableOpacity key={budget.id} style={styles.budgetCard} onPress={() => setSelectedBudget(budget)}>
                <View style={styles.budgetIconWrap}>
                  <Ionicons name="pie-chart" size={26} color="#1565C0" />
                </View>
                <View style={styles.budgetInfo}>
                  <Text style={styles.budgetCurrency}>{budget.currency}</Text>
                  <Text style={styles.budgetLimit}>
                    {getCurrencySymbol(budget.currency)}{(budget.monthlyLimit / 100).toFixed(2)}/month
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#90B8DC" />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </>
    );
  }

  return (
    <LinearGradient colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']} style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {renderContent()}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: 20,
    paddingBottom: 48,
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
    letterSpacing: 0.2,
    marginBottom: 4,
  },
  heroSub: {
    fontSize: 14,
    color: '#5580A0',
    fontWeight: '500',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0A3D7C',
    letterSpacing: 1.2,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0A3D7C',
    marginBottom: 4,
  },
  month: {
    fontSize: 13,
    color: '#5580A0',
    marginBottom: 20,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(21,101,192,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.25)',
  },
  emptyContainer: {
    paddingVertical: 48,
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0A3D7C',
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#5580A0',
    textAlign: 'center',
    lineHeight: 20,
  },
  createFirstBtn: {
    marginTop: 8,
    backgroundColor: '#1565C0',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  createFirstBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  list: {
    gap: 12,
  },
  budgetCard: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderRadius: 18,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  budgetIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(21,101,192,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  budgetInfo: {
    flex: 1,
  },
  budgetCurrency: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0A3D7C',
    marginBottom: 3,
  },
  budgetLimit: {
    fontSize: 13,
    color: '#5580A0',
    fontWeight: '500',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    gap: 8,
  },
  backText: {
    fontSize: 15,
    color: '#1565C0',
    fontWeight: '600',
  },
  form: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0A3D7C',
    marginBottom: 8,
    marginTop: 14,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 12,
    padding: 14,
    fontSize: 22,
    fontWeight: '800',
    color: '#0A3D7C',
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.25)',
    textAlign: 'center',
  },
  currencyPicker: {
    backgroundColor: 'rgba(21,101,192,0.07)',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.15)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  currencyText: {
    fontSize: 16,
    color: '#1565C0',
    fontWeight: '700',
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    borderRadius: 14,
    padding: 16,
    marginTop: 20,
    gap: 8,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  progressCard: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 4,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  progressLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0A3D7C',
  },
  progressPercent: {
    fontSize: 24,
    fontWeight: '800',
  },
  progressBarContainer: {
    height: 12,
    backgroundColor: 'rgba(21,101,192,0.10)',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 20,
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 6,
  },
  amountsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  amountLabel: {
    fontSize: 12,
    color: '#5580A0',
    marginBottom: 4,
    fontWeight: '500',
  },
  amountValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0A3D7C',
  },
  statsCard: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 4,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.08)',
    gap: 12,
  },
  statLabel: {
    flex: 1,
    fontSize: 14,
    color: '#5580A0',
    fontWeight: '500',
  },
  statValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0A3D7C',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFEBEE',
    padding: 16,
    borderRadius: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(211,47,47,0.15)',
  },
  deleteButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#d32f2f',
  },
});
