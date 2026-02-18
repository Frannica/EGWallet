import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { fetchRates, Rates } from '../api/client';
import { formatCurrency, convert } from '../utils/currency';
import { useNavigation } from '@react-navigation/native';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';

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
    if (!auth.token) return;
    setLoading(true);
    try {
      const res = await listWallets(auth.token);
      setWallets(res.wallets || []);
    } catch (e) {
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
      <OfflineErrorBanner visible={!isOnline} onRetry={onRefresh} />
      
      {/* Total Balance Header */}
      <View style={styles.header}>
        <Text style={styles.headerLabel}>Total Balance</Text>
        {loading && wallets.length === 0 ? (
          <ActivityIndicator size="small" color="#007AFF" style={{marginTop: 8}} />
        ) : (
          <Text style={styles.headerBalance}>
            {formatCurrency(
              rates ? convert(calculateTotalBalance(), 'USD', preferredCurrency, rates) : 0,
              preferredCurrency
            )}
          </Text>
        )}
        {rates && (
          <Text style={styles.headerSubtext}>
            ≈ ${calculateTotalBalance().toFixed(2)} USD
          </Text>
        )}
      </View>

      {/* Currency Selector */}
      <View style={styles.currencySelector}>
        <Text style={styles.currencyLabel}>Display Currency:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{flexGrow: 0}}>
          {POPULAR_CURRENCIES.map(c => (
            <TouchableOpacity 
              key={c} 
              onPress={() => setPreferredCurrency(c)} 
              style={[styles.currencyButton, preferredCurrency === c && styles.currencyButtonActive]}
            >
              <Text style={[styles.currencyButtonText, preferredCurrency === c && styles.currencyButtonTextActive]}>
                {c}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Wallets List */}
      {loading && wallets.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading your wallets...</Text>
        </View>
      ) : wallets.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>💳</Text>
          <Text style={styles.emptyTitle}>No Wallets Yet</Text>
          <Text style={styles.emptyText}>
            You haven't created any wallets yet.{'\n'}
            Contact support to set up your first wallet.
          </Text>
        </View>
      ) : (
        <FlatList 
          data={wallets}
          keyExtractor={item => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#007AFF']} />
          }
          contentContainerStyle={styles.listContent}
          renderItem={({item}) => (
            <View style={styles.walletCard}>
              <View style={styles.walletHeader}>
                <View>
                  <Text style={styles.walletTitle}>Wallet</Text>
                  <Text style={styles.walletId}>ID: {item.id.substring(0, 12)}...</Text>
                </View>
                <View style={styles.walletBadge}>
                  <Text style={styles.walletBadgeText}>Active</Text>
                </View>
              </View>

              {/* Balances */}
              <View style={styles.balancesContainer}>
                {(item.balances || []).length === 0 ? (
                  <Text style={styles.noBalanceText}>No balance</Text>
                ) : (
                  (item.balances || []).map((b: Balance) => {
                    const displayMinor = rates ? convert(b.amount, b.currency, preferredCurrency, rates) : b.amount;
                    return (
                      <View key={b.currency} style={styles.balanceRow}>
                        <View style={styles.balanceLeft}>
                          <View style={styles.currencyIcon}>
                            <Text style={styles.currencyIconText}>{b.currency}</Text>
                          </View>
                          <View>
                            <Text style={styles.balanceAmount}>{formatCurrency(b.amount, b.currency)}</Text>
                            {preferredCurrency !== b.currency && (
                              <Text style={styles.balanceConverted}>
                                ≈ {formatCurrency(displayMinor, preferredCurrency)}
                              </Text>
                            )}
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>

              {/* Capacity Warning */}
              {rates && (() => {
                const totalUSD = totalUsdValue(item);
                const maxLimit = item.maxLimitUSD || 250000;
                if (totalUSD > maxLimit) {
                  return (
                    <View style={[styles.warningBanner, {backgroundColor: '#FFEBEE'}]}>
                      <Text style={styles.warningText}>⚠️ Wallet exceeds capacity (${maxLimit.toLocaleString()})</Text>
                    </View>
                  );
                }
                if (totalUSD > maxLimit * 0.9) {
                  return (
                    <View style={[styles.warningBanner, {backgroundColor: '#FFF3E0'}]}>
                      <Text style={styles.warningText}>⚠️ Approaching capacity limit</Text>
                    </View>
                  );
                }
                return null;
              })()}

              {/* Actions */}
              <TouchableOpacity 
                style={styles.viewTransactionsButton}
                onPress={() => navigation.navigate('Transactions' as any, { walletId: item.id } as any)}
              >
                <Text style={styles.viewTransactionsText}>View Transactions →</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  header: {
    backgroundColor: '#007AFF',
    padding: 24,
    paddingTop: 16,
    paddingBottom: 24,
  },
  headerLabel: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    marginBottom: 4,
  },
  headerBalance: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  headerSubtext: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
  },
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
    backgroundColor: '#007AFF',
  },
  currencyButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  currencyButtonTextActive: {
    color: '#FFFFFF',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#657786',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#657786',
    textAlign: 'center',
    lineHeight: 20,
  },
  listContent: {
    padding: 16,
  },
  walletCard: {
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
  walletHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  walletTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 4,
  },
  walletId: {
    fontSize: 12,
    color: '#657786',
  },
  walletBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  walletBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#2E7D32',
  },
  balancesContainer: {
    marginBottom: 12,
  },
  noBalanceText: {
    fontSize: 14,
    color: '#AAB8C2',
    fontStyle: 'italic',
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F8FA',
  },
  balanceLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  currencyIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E8F5FE',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  currencyIconText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1976D2',
  },
  balanceAmount: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
  },
  balanceConverted: {
    fontSize: 12,
    color: '#657786',
  },
  warningBanner: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  warningText: {
    fontSize: 13,
    color: '#D32F2F',
    fontWeight: '500',
  },
  viewTransactionsButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  viewTransactionsText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
});

