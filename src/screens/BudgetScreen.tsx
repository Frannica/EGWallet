import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, Alert, Switch } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface Budget {
  id: string;
  category: string;
  limit: number;
  spent: number;
  currency: string;
  alertsEnabled: boolean;
}

const BUDGET_CATEGORIES = [
  '🍔 Food & Dining',
  '🚗 Transportation',
  '🛍️ Shopping',
  '🏥 Healthcare',
  '🎬 Entertainment',
  '💡 Utilities',
  '🏠 Rent & Housing',
  '📚 Education',
  '💼 Other',
];

export default function BudgetScreen() {
  const { colors } = useTheme();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [newCurrency, setNewCurrency] = useState('XAF');

  useEffect(() => {
    loadBudgets();
  }, []);

  const loadBudgets = async () => {
    try {
      const stored = await AsyncStorage.getItem('budgets');
      if (stored) {
        setBudgets(JSON.parse(stored));
      }
    } catch (e) {
      if (__DEV__) console.warn('Failed to load budgets', e);
    }
  };

  const saveBudgets = async (newBudgets: Budget[]) => {
    try {
      await AsyncStorage.setItem('budgets', JSON.stringify(newBudgets));
      setBudgets(newBudgets);
    } catch (e) {
      Alert.alert('Error', 'Failed to save budget');
    }
  };

  const addBudget = () => {
    if (!newCategory || !newLimit || isNaN(Number(newLimit))) {
      Alert.alert('Invalid Input', 'Please select a category and enter a valid limit');
      return;
    }

    const budget: Budget = {
      id: Date.now().toString(),
      category: newCategory,
      limit: Number(newLimit),
      spent: 0,
      currency: newCurrency,
      alertsEnabled: true,
    };

    saveBudgets([...budgets, budget]);
    setNewCategory('');
    setNewLimit('');
    setShowAddForm(false);
  };

  const toggleAlerts = (budgetId: string) => {
    const updated = budgets.map(b =>
      b.id === budgetId ? { ...b, alertsEnabled: !b.alertsEnabled } : b
    );
    saveBudgets(updated);
  };

  const deleteBudget = (budgetId: string) => {
    Alert.alert('Delete Budget', 'Are you sure you want to delete this budget?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => saveBudgets(budgets.filter(b => b.id !== budgetId)),
      },
    ]);
  };

  const getPercentage = (spent: number, limit: number) => {
    return limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
  };

  const getProgressColor = (percentage: number) => {
    if (percentage >= 100) return '#d32f2f';
    if (percentage >= 90) return '#f57c00';
    if (percentage >= 75) return '#fbc02d';
    return colors.primary;
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: colors.text }}>Budgets</Text>
          <TouchableOpacity
            onPress={() => setShowAddForm(!showAddForm)}
            style={{ backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>{showAddForm ? 'Cancel' : '+ Add Budget'}</Text>
          </TouchableOpacity>
        </View>

        {/* Add Budget Form */}
        {showAddForm && (
          <View
            style={{
              backgroundColor: colors.card,
              padding: 16,
              borderRadius: 8,
              marginBottom: 16,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ fontWeight: '600', color: colors.text, marginBottom: 8 }}>New Budget</Text>

            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>Category</Text>
            <View style={{ marginBottom: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {BUDGET_CATEGORIES.map(cat => (
                <TouchableOpacity
                  key={cat}
                  onPress={() => setNewCategory(cat)}
                  style={{
                    backgroundColor: newCategory === cat ? colors.primary : colors.background,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  <Text
                    style={{
                      color: newCategory === cat ? '#fff' : colors.text,
                      fontSize: 13,
                      fontWeight: newCategory === cat ? '600' : '400',
                    }}
                  >
                    {cat}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>Monthly Limit</Text>
            <TextInput
              value={newLimit}
              onChangeText={setNewLimit}
              placeholder="Amount"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric"
              style={{
                backgroundColor: colors.background,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 8,
                padding: 12,
                marginBottom: 12,
                color: colors.text,
              }}
            />

            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>Currency</Text>
            <TextInput
              value={newCurrency}
              onChangeText={setNewCurrency}
              placeholder="XAF"
              placeholderTextColor={colors.textSecondary}
              style={{
                backgroundColor: colors.background,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 8,
                padding: 12,
                marginBottom: 12,
                color: colors.text,
              }}
            />

            <TouchableOpacity
              onPress={addBudget}
              style={{ backgroundColor: colors.primary, padding: 12, borderRadius: 8, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>Create Budget</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Budget List */}
        {budgets.length === 0 && !showAddForm && (
          <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 48 }}>
            <Text style={{ fontSize: 48, marginBottom: 16 }}>💰</Text>
            <Text style={{ color: colors.textSecondary, textAlign: 'center', fontSize: 16 }}>
              No budgets yet
            </Text>
            <Text style={{ color: colors.textSecondary, textAlign: 'center', fontSize: 14, marginTop: 8 }}>
              Tap "+ Add Budget" to create your first budget
            </Text>
          </View>
        )}

        {budgets.map(budget => {
          const percentage = getPercentage(budget.spent, budget.limit);
          const progressColor = getProgressColor(percentage);

          return (
            <View
              key={budget.id}
              style={{
                backgroundColor: colors.card,
                padding: 16,
                borderRadius: 8,
                marginBottom: 12,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text }}>{budget.category}</Text>
                <TouchableOpacity onPress={() => deleteBudget(budget.id)}>
                  <Text style={{ color: '#d32f2f', fontSize: 18 }}>🗑️</Text>
                </TouchableOpacity>
              </View>

              <View style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                    {budget.spent} / {budget.limit} {budget.currency}
                  </Text>
                  <Text style={{ color: progressColor, fontSize: 13, fontWeight: '600' }}>
                    {percentage.toFixed(0)}%
                  </Text>
                </View>

                {/* Progress Bar */}
                <View
                  style={{
                    height: 8,
                    backgroundColor: colors.border,
                    borderRadius: 4,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${percentage}%`,
                      backgroundColor: progressColor,
                    }}
                  />
                </View>
              </View>

              {/* Alert Toggle */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Spending Alerts</Text>
                <Switch
                  value={budget.alertsEnabled}
                  onValueChange={() => toggleAlerts(budget.id)}
                  trackColor={{ false: '#ccc', true: colors.primary }}
                  thumbColor="#fff"
                />
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
