import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, StatusBar } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { fetchRates, Rates } from '../api/client';
import { formatCurrency, convert } from '../utils/currency';
import { useNavigation } from '@react-navigation/native';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { Ionicons } from '@expo/vector-icons';

type Balance = { currency: string; amount: number };

export default function WalletScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [rates, setRates] = useState<Rates | null>(null);
  const [preferredCurrency, setPreferredCurrency] = useState<string>('XAF');
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [recentPayroll, setRecentPayroll] = useState<any>(null);
  const [selectedTab, setSelectedTab] = useState<'all' | 'payroll' | 'transfers'>('all');
  const navigation = useNavigation();

  async function loadRates() {
    try {
      const r = await fetchRates();
      setRates(r);
    } catch (e) {
      if (__DEV__) console.warn('Failed to load rates', e);
    }
  }

  async function loadWallets() {
    if (!auth.token) {
      console.warn('No auth token available');
      return;
    }
    setLoading(true);
    try {
      console.log('Fetching wallets...');
      const res = await listWallets(auth.token);
      console.log('Wallets response:', res);
      setWallets(res.wallets || []);
      
      // Check for recent payroll transaction
      if (res.wallets && res.wallets.length > 0) {
        const firstWallet = res.wallets[0];
        const { API_BASE } = await import('../api/client');
        const response = await fetch(`${API_BASE}/transactions?walletId=${firstWallet.id}`, {
          headers: { Authorization: `Bearer ${auth.token}` }
        });
        const txData = await response.json();
        const payrollTx = txData.transactions?.find((tx: any) => 
          (tx.type === 'payroll' || tx.type === 'payroll_request') && 
          tx.status === 'completed'
        );
        setRecentPayroll(payrollTx || null);
      }
    } catch (e) {
      console.error('Load wallets failed:', e);
      if (__DEV__) console.warn('Load wallets failed', e);
    } finally {
      setLoading(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([loadWallets(), loadRates()]);
    setRefreshing(false);
  }

  useEffect(() => {
    loadRates();
  }, []);

  useEffect(() => { loadWallets(); }, [auth.token]);

  function totalUsdValue(wallet: any) {
    if (!rates) return 0;
    return (wallet.balances || []).reduce((s: number, b: Balance) => s + (b.amount / (rates.values[b.currency] ?? 1)), 0);
  }

  function calculateTotalBalance() {
    if (!rates) return 0;
    return wallets.reduce((total, wallet) => total + totalUsdValue(wallet), 0);
  }

  const POPULAR_CURRENCIES = ['XAF', 'USD', 'EUR', 'GBP', 'NGN', 'GHS', 'ZAR', 'KES'];

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1565C0" />
      <OfflineErrorBanner visible={!isOnline} onRetry={onRefresh} />
      
      {/* Modern Gradient Header */}
      <LinearGradient
        colors={['#1976D2', '#1565C0']}
        style={styles.gradientHeader}
      >
        <View style={styles.headerTop}>
          <Text style={styles.appTitle}>EGWallet</Text>
          <TouchableOpacity 
            style={styles.notificationButton}
            onPress={() => (navigation as any).navigate('Settings')}
          >
            <Ionicons name="notifications-outline" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
        
        {/* Large Balance Card with Gradient */}
        <LinearGradient
          colors={['#2196F3', '#00BCD4']}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={styles.balanceCard}
        >
          {loading && wallets.length === 0 ? (
            <ActivityIndicator size="large" color="#FFFFFF" />
          ) : (
            <>
              <Text style={styles.balanceLabel}>Total Balance</Text>
              <Text style={styles.balanceAmount}>
                {formatCurrency(
                  rates ? convert(calculateTotalBalance(), 'USD', preferredCurrency, rates) : 0,
                  preferredCurrency
                )}
              </Text>
              {rates && (
                <Text style={styles.balanceUSD}>
                  ≈ ${calculateTotalBalance().toFixed(2)} USD
                </Text>
              )}
              <TouchableOpacity onPress={() => setShowCurrencyPicker(!showCurrencyPicker)}>
                <Text style={styles.changeCurrencyText}>Change Currency ›</Text>
              </TouchableOpacity>
            </>
          )}
        </LinearGradient>

        {/* Tab Navigation */}
        <View style={styles.tabsContainer}>
          <TouchableOpacity 
            style={[styles.tab, selectedTab === 'all' && styles.tabActive]}
            onPress={() => {
              setSelectedTab('all');
              if (wallets.length > 0) {
                (navigation as any).navigate('Transactions', { walletId: wallets[0].id });
              }
            }}
          >
            <Text style={[styles.tabText, selectedTab === 'all' && styles.tabTextActive]}>All</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, selectedTab === 'payroll' && styles.tabActive]}
            onPress={() => {
              setSelectedTab('payroll');
              if (wallets.length > 0) {
                (navigation as any).navigate('Transactions', { walletId: wallets[0].id, filter: 'payroll' });
              }
            }}
          >
            <Text style={[styles.tabText, selectedTab === 'payroll' && styles.tabTextActive]}>Payroll</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, selectedTab === 'transfers' && styles.tabActive]}
            onPress={() => {
              setSelectedTab('transfers');
              (navigation as any).navigate('Send');
            }}
          >
            <Text style={[styles.tabText, selectedTab === 'transfers' && styles.tabTextActive]}>Transfers</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Currency Selector Dropdown */}
      {showCurrencyPicker && (
        <View style={styles.currencySelector}>
          <Text style={styles.currencyLabel}>Display Currency:</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {POPULAR_CURRENCIES.map(c => (
              <TouchableOpacity 
                key={c} 
                onPress={() => {
                  setPreferredCurrency(c);
                  setShowCurrencyPicker(false);
                }} 
                style={[styles.currencyButton, preferredCurrency === c && styles.currencyButtonActive]}
              >
                <Text style={[styles.currencyButtonText, preferredCurrency === c && styles.currencyButtonTextActive]}>
                  {c}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Recent Payroll Banner */}
      {recentPayroll && wallets.length > 0 && (
        <TouchableOpacity 
          style={styles.payrollBanner}
          onPress={() => (navigation as any).navigate('Transactions', { 
            walletId: wallets[0].id,
            filter: 'payroll'
          })}
        >
          <View style={styles.payrollIconContainer}>
            <Ionicons name="briefcase" size={20} color="#1976D2" />
          </View>
          <View style={styles.payrollContent}>
            <Text style={styles.payrollTitle}>
              Salary from {recentPayroll.payrollMetadata?.employerName || 'Employer'}
            </Text>
            <Text style={styles.payrollAmount}>
              +{formatCurrency(recentPayroll.amount, recentPayroll.currency)}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#90CAF9" />
        </TouchableOpacity>
      )}

      {/* Content Area */}
      {loading && wallets.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1976D2" />
          <Text style={styles.loadingText}>Loading your wallet...</Text>
        </View>
      ) : wallets.length === 0 ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.emptyState}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#1976D2']} />
          }
        >
          <View style={styles.emptyIconContainer}>
            <Ionicons name="wallet-outline" size={64} color="#90CAF9" />
          </View>
          <Text style={styles.emptyTitle}>No Wallet Yet</Text>
          <Text style={styles.emptyText}>
            Pull down to refresh or contact support{'\n'}to set up your wallet.
          </Text>
        </ScrollView>
      ) : (
        <ScrollView
          style={styles.scrollView}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#1976D2']} />
          }
        >
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Activity</Text>
          </View>
          
          {/* Transaction Cards - Modern Design */}
          <TouchableOpacity 
            style={styles.transactionCard}
            onPress={() => {
              if (wallets.length > 0) {
                (navigation as any).navigate('Transactions', { walletId: wallets[0].id });
              }
            }}
          >
            <View style={[styles.transactionIconContainer, {backgroundColor: '#E3F2FD'}]}>
              <Ionicons name="briefcase" size={22} color="#1976D2" />
            </View>
            <View style={styles.transactionContent}>
              <Text style={styles.transactionTitle}>Wallet Balance</Text>
              <Text style={styles.transactionSubtitle}>
                {wallets[0]?.balances?.length || 0} {wallets[0]?.balances?.length === 1 ? 'currency' : 'currencies'}
              </Text>
            </View>
            <View style={styles.transactionRight}>
              <Text style={styles.transactionAmountGreen}>
                {formatCurrency(
                  rates && wallets[0] ? convert(totalUsdValue(wallets[0]), 'USD', preferredCurrency, rates) : 0,
                  preferredCurrency
                )}
              </Text>
            </View>
          </TouchableOpacity>

          {/* Wallet Details Card */}
          <View style={styles.detailsCard}>
            <Text style={styles.detailsTitle}>Wallet Details</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Wallet ID</Text>
              <Text style={styles.detailValue}>{wallets[0]?.id.substring(0, 12)}...</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Status</Text>
              <View style={styles.statusBadge}>
                <Text style={styles.statusText}>Active</Text>
              </View>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Capacity</Text>
              <Text style={styles.detailValue}>
                ${(rates ? totalUsdValue(wallets[0]) : 0).toFixed(0)} / ${(wallets[0]?.maxLimitUSD || 250000).toLocaleString()}
              </Text>
            </View>
          </View>

          {/* Balances Breakdown */}
          {wallets[0]?.balances?.map((b: Balance, index: number) => {
            const displayConverted = rates ? convert(b.amount, b.currency, preferredCurrency, rates) : b.amount;
            return (
              <View key={index} style={styles.currencyCard}>
                <View style={styles.currencyCardHeader}>
                  <View style={styles.currencyBadge}>
                    <Text style={styles.currencyBadgeText}>{b.currency}</Text>
                  </View>
                  <Text style={styles.currencyAmount}>{formatCurrency(b.amount, b.currency)}</Text>
                </View>
                {preferredCurrency !== b.currency && (
                  <Text style={styles.currencyConverted}>
                    ≈ {formatCurrency(displayConverted, preferredCurrency)}
                  </Text>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  
  // Modern Gradient Header
  gradientHeader: {
    paddingTop: 48,
    paddingBottom: 20,
    paddingHorizontal: 20,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  appTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  notificationButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Large Balance Card
  balanceCard: {
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  balanceLabel: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.9)',
    marginBottom: 8,
    fontWeight: '500',
  },
  balanceAmount: {
    fontSize: 40,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  balanceUSD: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.8)',
    marginBottom: 8,
  },
  changeCurrencyText: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.9)',
    fontWeight: '500',
  },
  
  // Tab Navigation
  tabsContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 25,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: '#FFFFFF',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.7)',
  },
  tabTextActive: {
    color: '#1976D2',
  },
  
  // Currency Selector
  currencySelector: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  currencyLabel: {
    fontSize: 13,
    color: '#657786',
    marginBottom: 8,
    fontWeight: '600',
  },
  currencyButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F5F8FA',
    marginRight: 8,
  },
  currencyButtonActive: {
    backgroundColor: '#1976D2',
  },
  currencyButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  currencyButtonTextActive: {
    color: '#FFFFFF',
  },
  
  // Payroll Banner
  payrollBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  payrollIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  payrollContent: {
    flex: 1,
  },
  payrollTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 4,
  },
  payrollAmount: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#4CAF50',
  },
  
  // Content States
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 15,
    color: '#657786',
    fontWeight: '500',
  },
  emptyState: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 48,
  },
  emptyIconContainer: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 15,
    color: '#657786',
    textAlign: 'center',
    lineHeight: 22,
  },
  
  // ScrollView
  scrollView: {
    flex: 1,
  },
  
  // Section Header
  sectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#14171A',
  },
  
  // Transaction Cards
  transactionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  transactionIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  transactionContent: {
    flex: 1,
  },
  transactionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 4,
  },
  transactionSubtitle: {
    fontSize: 13,
    color: '#657786',
  },
  transactionRight: {
    alignItems: 'flex-end',
  },
  transactionAmountGreen: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#4CAF50',
  },
  transactionAmountRed: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#F44336',
  },
  
  // Details Card
  detailsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    marginHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  detailsTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F8FA',
  },
  detailLabel: {
    fontSize: 14,
    color: '#657786',
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  statusBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2E7D32',
  },
  
  // Currency Card
  currencyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  currencyCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  currencyBadge: {
    backgroundColor: '#E3F2FD',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  currencyBadgeText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1976D2',
  },
  currencyAmount: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#14171A',
  },
  currencyConverted: {
    fontSize: 13,
    color: '#657786',
    marginTop: 4,
  },
});

