import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { createBudget, getBudgets, getBudgetAnalytics, deleteBudget } from '../api/transactions';
import { getCurrencySymbol } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { BudgetCardSkeleton } from '../components/SkeletonLoader';

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
  const [loading, setLoading] = useState(false);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudget, setSelectedBudget] = useState<Budget | null>(null);
  const [analytics, setAnalytics] = useState<BudgetAnalytics | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  
  // Form state
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');

  useEffect(() => {
    loadBudgets();
  }, []);

  useEffect(() => {
    if (selectedBudget) {
      loadAnalytics(selectedBudget.id);
    }
  }, [selectedBudget]);

  const loadBudgets = async () => {
    if (!isOnline) return;
    
    try {
      setLoading(true);
      const data = await getBudgets(auth.token!);
      setBudgets(data.budgets || []);
    } catch (error: any) {
      if (__DEV__) console.log('Load budgets error:', error);
      Alert.alert('Error', 'Failed to load budgets. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async (budgetId: string) => {
    if (!isOnline) return;
    
    try {
      setLoading(true);
      const data = await getBudgetAnalytics(auth.token!, budgetId);
      setAnalytics(data.analytics);
    } catch (error: any) {
      if (__DEV__) console.log('Load analytics error:', error);
      Alert.alert('Error', 'Failed to load budget analytics.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    if (!isOnline) {
      Alert.alert('Offline', 'You need an internet connection to create budgets');
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
              const wallets = auth.wallets || [];
              if (wallets.length === 0) {
                Alert.alert('Error', 'No wallet found');
                return;
              }

              await createBudget(auth.token!, wallets[0].id, currency, amountMinor);
              Alert.alert('Success', 'Budget created!');
              setAmount('');
              setShowCreateForm(false);
              loadBudgets();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to create budget');
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
            Alert.alert('Error', error.message || 'Failed to delete budget');
          } finally {
            setLoading(false);
          }
        }
      }
    ]);
  };

  if (showCreateForm) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backButton} onPress={() => setShowCreateForm(false)}>
          <Ionicons name="arrow-back" size={24} color="#007AFF" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Create Monthly Budget</Text>

        <View style={styles.form}>
          <Text style={styles.label}>Monthly Limit</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor="#999"
          />

          <Text style={styles.label}>Currency</Text>
          <View style={styles.currencyPicker}>
            <Text style={styles.currencyText}>{currency} {getCurrencySymbol(currency)}</Text>
          </View>

          <TouchableOpacity
            style={styles.createButton}
            onPress={handleCreate}
            disabled={loading}
          >
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
      </ScrollView>
    );
  }

  if (selectedBudget && analytics) {
    const percentColor = analytics.percentUsed >= 90 ? '#d32f2f' : analytics.percentUsed >= 70 ? '#F57C00' : '#2E7D32';
    
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backButton} onPress={() => setSelectedBudget(null)}>
          <Ionicons name="arrow-back" size={24} color="#007AFF" />
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
            <Ionicons name="swap-horizontal" size={24} color="#007AFF" />
            <Text style={styles.statLabel}>Transactions</Text>
            <Text style={styles.statValue}>{analytics.transactionCount}</Text>
          </View>
          <View style={styles.statRow}>
            <Ionicons name="calendar" size={24} color="#007AFF" />
            <Text style={styles.statLabel}>Budget Period</Text>
            <Text style={styles.statValue}>Monthly</Text>
          </View>
          <View style={styles.statRow}>
            <Ionicons name="cash" size={24} color="#007AFF" />
            <Text style={styles.statLabel}>Currency</Text>
            <Text style={styles.statValue}>{selectedBudget.currency}</Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.deleteButton}
          onPress={() => handleDelete(selectedBudget.id)}
          disabled={loading}
        >
          <Ionicons name="trash" size={20} color="#d32f2f" />
          <Text style={styles.deleteButtonText}>Delete Budget</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <OfflineErrorBanner />
      <View style={styles.header}>
        <Text style={styles.title}>Budgets</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => setShowCreateForm(true)}>
          <Ionicons name="add" size={24} color="#007AFF" />
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
          <Ionicons name="pie-chart-outline" size={64} color="#CCCCCC" />
          <Text style={styles.emptyTitle}>No Budgets</Text>
          <Text style={styles.emptyText}>Create a budget to track your monthly spending</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {budgets.map((budget) => (
            <TouchableOpacity
              key={budget.id}
              style={styles.budgetCard}
              onPress={() => setSelectedBudget(budget)}
            >
              <View style={styles.budgetIcon}>
                <Ionicons name="pie-chart" size={32} color="#007AFF" />
              </View>
              <View style={styles.budgetInfo}>
                <Text style={styles.budgetCurrency}>{budget.currency}</Text>
                <Text style={styles.budgetLimit}>
                  {getCurrencySymbol(budget.currency)}{(budget.monthlyLimit / 100).toFixed(2)}/month
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={24} color="#CCCCCC" />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  content: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#14171A',
  },
  month: {
    fontSize: 14,
    color: '#657786',
    marginTop: -16,
    marginBottom: 24,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E8F5FE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContainer: {
    paddingVertical: 64,
    alignItems: 'center',
  },
  emptyContainer: {
    paddingVertical: 64,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#14171A',
    marginTop: 16,
  },
  emptyText: {
    fontSize: 14,
    color: '#657786',
    marginTop: 8,
    textAlign: 'center',
  },
  list: {
    gap: 12,
  },
  budgetCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  budgetIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#E8F5FE',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  budgetInfo: {
    flex: 1,
  },
  budgetCurrency: {
    fontSize: 18,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 4,
  },
  budgetLimit: {
    fontSize: 14,
    color: '#657786',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    gap: 8,
  },
  backText: {
    fontSize: 16,
    color: '#007AFF',
  },
  form: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#F5F7FA',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: '#14171A',
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  currencyPicker: {
    backgroundColor: '#F5F7FA',
    borderRadius: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  currencyText: {
    fontSize: 16,
    color: '#14171A',
    fontWeight: '600',
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 16,
    marginTop: 24,
    gap: 8,
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  progressCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  progressLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
  },
  progressPercent: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  progressBarContainer: {
    height: 12,
    backgroundColor: '#F5F5F5',
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
    color: '#657786',
    marginBottom: 4,
  },
  amountValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
  },
  statsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
    gap: 12,
  },
  statLabel: {
    flex: 1,
    fontSize: 14,
    color: '#657786',
  },
  statValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFEBEE',
    padding: 16,
    borderRadius: 8,
    gap: 8,
  },
  deleteButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#d32f2f',
  },
});
