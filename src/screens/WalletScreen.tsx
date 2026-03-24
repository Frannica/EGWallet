import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, StatusBar, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { fetchRates, Rates, DEMO_RATES } from '../api/client';
import { formatCurrency, convert } from '../utils/currency';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { Ionicons } from '@expo/vector-icons';
import { useToast } from '../utils/toast';
import { getLocalBalances, mergeWithLocalBalances, getLocalTransactions } from '../utils/localBalance';

type Balance = { currency: string; amount: number };

const DEMO_WALLET = {
  id: 'demo',
  balances: [{ currency: 'XAF', amount: 0 }],
  maxLimitUSD: 250000,
};

export default function WalletScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const toast = useToast();
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [preferredCurrency, setPreferredCurrency] = useState<string>(auth.user?.preferredCurrency || 'USD');
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [recentPayroll, setRecentPayroll] = useState<any>(null);
  const [selectedTab, setSelectedTab] = useState<'all' | 'payroll' | 'transfers'>('all');
  const [insights, setInsights] = useState<{ spent: number; received: number; topCategory: string | null; currency: string } | null>(
    { spent: 0, received: 0, topCategory: null, currency: auth.user?.preferredCurrency || 'USD' }
  );
  const navigation = useNavigation();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 550, useNativeDriver: true }).start();
  }, []);

  async function loadRates() {
    try {
      const r = await fetchRates();
      setRates(r);
    } catch (e) {
      if (__DEV__) console.warn('Failed to load rates — using demo rates', e);
      setRates(DEMO_RATES); // Always show balance even offline
    }
  }

  async function loadWallets() {
    if (!auth.token) return;
    setLoading(true);
    setApiError(null);
    try {
      const res = await listWallets(auth.token);
      const localBalances = await getLocalBalances();
      const mergedWallets = mergeWithLocalBalances(res.wallets || [], localBalances);
      setWallets(mergedWallets);
      setApiError(null);

      // Load most recent payroll transaction for banner
      if (res.wallets && res.wallets.length > 0) {
        try {
          const { API_BASE } = await import('../api/client');
          const firstWallet = res.wallets[0];
          const response = await fetch(
            `${API_BASE}/wallets/${firstWallet.id}/transactions`,
            { headers: { Authorization: `Bearer ${auth.token}` } }
          );
          if (response.ok) {
            const txData = await response.json();
            const allTxs: any[] = txData.transactions || [];
            const payrollTx = allTxs.find((tx: any) =>
              (tx.type === 'payroll' || tx.type === 'payroll_request') &&
              tx.status === 'completed'
            );
            setRecentPayroll(payrollTx || null);
            // Smart Insights — last 7 days
            // Merge local transactions so deposits/withdrawals are counted too
            const localTxsForInsights = await getLocalTransactions();
            const backendTxIds = new Set(allTxs.map((t: any) => t.id));
            const uniqueLocalTxs = localTxsForInsights.filter((t: any) => !backendTxIds.has(t.id));
            const allTxsCombined = [...uniqueLocalTxs, ...allTxs];
            const currentRates = rates || DEMO_RATES;
            const insightsCurrency = preferredCurrency;
            const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const weekTxs = allTxsCombined.filter((t: any) => {
              const ts = typeof t.timestamp === 'string' ? new Date(t.timestamp).getTime() : t.timestamp;
              return ts >= weekAgo;
            });
            const spent = weekTxs
              .filter((t: any) => t.direction === 'out')
              .reduce((s: number, t: any) => s + convert(t.amount, t.currency || insightsCurrency, insightsCurrency, currentRates), 0);
            const received = weekTxs
              .filter((t: any) => t.direction === 'in')
              .reduce((s: number, t: any) => s + convert(t.amount, t.currency || insightsCurrency, insightsCurrency, currentRates), 0);
            const cats: Record<string, number> = {};
            allTxsCombined.forEach((t: any) => {
              const cat = (t.type === 'payroll' || t.type === 'payroll_request') ? 'Payroll' : t.direction === 'in' ? 'Received' : 'Transfers';
              cats[cat] = (cats[cat] || 0) + 1;
            });
            const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
            setInsights({ spent, received, topCategory: topCat, currency: insightsCurrency });
          }
        } catch (_) {
          // payroll banner is optional â€” ignore failures
        }
      }
    } catch (e: any) {
      if (__DEV__) console.warn('Load wallets failed:', e?.message);
      setApiError(e?.message || 'Unable to reach the server.');
      // Show demo wallet with local balances so the UI stays functional
      const localBalancesOnError = await getLocalBalances();
      const localCurrencies = Object.entries(localBalancesOnError).filter(([, amt]) => amt > 0);
      const fallbackBalances = localCurrencies.length > 0
        ? localCurrencies.map(([cur, amt]) => ({ currency: cur, amount: amt }))
        : [{ currency: preferredCurrency, amount: 0 }];
      setWallets(prev => prev.length === 0 ? [{ ...DEMO_WALLET, balances: fallbackBalances }] : prev);
      // Demo insights
      setInsights(prev => prev ?? { spent: 15000, received: 50000, topCategory: 'Transfers', currency: preferredCurrency });
    } finally {
      setLoading(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([loadWallets(), loadRates()]);
    setRefreshing(false);
  }

  // Sync preferredCurrency whenever auth.user updates (e.g. after login)
  useEffect(() => {
    if (auth.user?.preferredCurrency) {
      setPreferredCurrency(auth.user.preferredCurrency);
    }
  }, [auth.user?.preferredCurrency]);

  useEffect(() => {
    loadRates();
  }, []);

  useEffect(() => { loadWallets(); }, [auth.token]);

  // Reload balance whenever this screen comes back into focus (e.g. after a deposit)
  useFocusEffect(
    React.useCallback(() => {
      if (auth.token) loadWallets();
    }, [auth.token])
  );

  function totalUsdValue(wallet: any) {
    if (!rates || !wallet) return 0;
    return (wallet.balances || []).reduce((s: number, b: Balance) => s + (b.amount / (rates.values[b.currency] ?? 1)), 0);
  }

  function calculateTotalBalance() {
    if (!rates) return 0;
    return wallets.reduce((total, wallet) => total + totalUsdValue(wallet), 0);
  }

  const POPULAR_CURRENCIES = ['XAF', 'XOF', 'MAD', 'USD', 'EUR', 'GBP', 'NGN', 'GHS', 'ZAR', 'KES', 'INR', 'CNY', 'JPY', 'BRL'];

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="transparent" translucent />

      {/* Sky gradient full-screen background */}
      <LinearGradient
        colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 0.68 }}
      />

      <OfflineErrorBanner visible={!isOnline} onRetry={onRefresh} />

      <Animated.ScrollView
        style={[styles.scrollView, { opacity: fadeAnim }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#1565C0']} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Floating Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greetingText}>Welcome back</Text>
            <Text style={styles.appTitle}>EGWallet</Text>
          </View>
          <TouchableOpacity
            style={styles.profileBtn}
            onPress={() => (navigation as any).navigate('Settings')}
            activeOpacity={0.75}
          >
            <Ionicons name="person-circle-outline" size={38} color="#1565C0" />
          </TouchableOpacity>
        </View>

        {/* Balance Hero Card */}
        <LinearGradient
          colors={['#0A3D7C', '#1565C0', '#1976D2']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.balanceCard}
        >
          <View style={styles.decorBlob1} />
          <View style={styles.decorBlob2} />
          <Text style={styles.balanceLabel}>TOTAL BALANCE</Text>
          {loading && wallets.length === 0 ? (
            <ActivityIndicator size="large" color="#FFFFFF" style={{ marginVertical: 16 }} />
          ) : (
            <Text style={styles.balanceAmount}>
              {formatCurrency(
                rates ? convert(calculateTotalBalance(), 'USD', preferredCurrency, rates) : 0,
                preferredCurrency
              )}
            </Text>
          )}
          {rates && (
            <Text style={styles.balanceEquiv}>≈ {formatCurrency(calculateTotalBalance(), 'USD')}</Text>
          )}
          <TouchableOpacity
            onPress={() => setShowCurrencyPicker(!showCurrencyPicker)}
            style={styles.currencyChip}
            activeOpacity={0.75}
          >
            <Text style={styles.currencyChipText}>{preferredCurrency}</Text>
            <Ionicons name="chevron-down" size={13} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
        </LinearGradient>

        {/* Currency Picker */}
        {showCurrencyPicker && (
          <View style={styles.currencySelector}>
            <Text style={styles.currencyLabel}>Display Currency</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {POPULAR_CURRENCIES.map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={() => { setPreferredCurrency(c); setShowCurrencyPicker(false); }}
                  style={[styles.currencyButton, preferredCurrency === c && styles.currencyButtonActive]}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.currencyButtonText, preferredCurrency === c && styles.currencyButtonTextActive]}>
                    {c}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Quick Actions */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.quickActionsScroll}
          contentContainerStyle={styles.quickActions}
        >
          {([
            { icon: 'send' as const, label: 'Send', bg: '#DBEAFE', color: '#1565C0', onPress: () => { console.log('[Wallet] Quick action: Send'); (navigation as any).navigate('Send'); } },
            { icon: 'download' as const, label: 'Request', bg: '#DCFCE7', color: '#15803D', onPress: () => { console.log('[Wallet] Quick action: Request'); (navigation as any).navigate('Request'); } },
            { icon: 'add-circle' as const, label: 'Add Money', bg: '#FEF9C3', color: '#A16207', onPress: () => { console.log('[Wallet] Quick action: Add Money'); (navigation as any).navigate('Deposit', { walletId: wallets[0]?.id }); } },
            { icon: 'card' as const, label: 'Card', bg: '#F3E8FF', color: '#7E22CE', onPress: () => { console.log('[Wallet] Quick action: Card'); (navigation as any).navigate('Card'); } },
            { icon: 'sparkles' as const, label: 'AI Support', bg: '#EDE9FE', color: '#7C3AED', onPress: () => { console.log('[Wallet] Quick action: AI Support'); (navigation as any).navigate('AIChat'); } },
          ]).map(({ icon, label, bg, color, onPress }) => (
            <TouchableOpacity key={label} style={styles.quickActionBtn} onPress={onPress} activeOpacity={0.75}>
              <View style={[styles.quickActionIcon, { backgroundColor: bg }]}>
                <Ionicons name={icon} size={22} color={color} />
              </View>
              <Text style={styles.quickActionLabel}>{label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Smart Wallet Insights */}
        {insights !== null && (
          <View style={styles.insightsCard}>
            <View style={styles.insightsHeader}>
              <View style={styles.insightsTitleRow}>
                <Ionicons name="flash" size={18} color="#1565C0" />
                <Text style={styles.insightsTitle}>Smart Insights</Text>
              </View>
              <Text style={styles.insightsPeriod}>This week</Text>
            </View>
            <View style={styles.insightsStats}>
              <View style={styles.insightStat}>
                <Text style={styles.insightStatEmoji}>💸</Text>
                <Text style={styles.insightStatValue}>{formatCurrency(insights.spent, insights.currency)}</Text>
                <Text style={styles.insightStatLabel}>Spent</Text>
              </View>
              <View style={styles.insightDivider} />
              <View style={styles.insightStat}>
                <Text style={styles.insightStatEmoji}>📥</Text>
                <Text style={[styles.insightStatValue, { color: '#15803D' }]}>{formatCurrency(insights.received, insights.currency)}</Text>
                <Text style={styles.insightStatLabel}>Received</Text>
              </View>
            </View>
            {insights.topCategory && (insights.spent > 0 || insights.received > 0) && (
              <View style={styles.insightHighlight}>
                <Text style={styles.insightHighlightText}>
                  🏆 Top category: <Text style={{ fontWeight: '700', color: '#1565C0' }}>{insights.topCategory}</Text>
                </Text>
              </View>
            )}
            {/* Money Flow Chart */}
            <View style={styles.flowChart}>
              <Text style={styles.flowChartTitle}>Money Flow</Text>
              <View style={styles.flowBarsContainer}>
                {(() => {
                  const maxVal = Math.max(insights.spent, insights.received, 1);
                  const inH = Math.max(12, (insights.received / maxVal) * 64);
                  const outH = Math.max(12, (insights.spent / maxVal) * 64);
                  return (
                    <>
                      <View style={styles.flowBarGroup}>
                        <View style={[styles.flowBar, { height: inH, backgroundColor: '#22C55E' }]} />
                        <Text style={styles.flowBarLabel}>In</Text>
                      </View>
                      <View style={styles.flowBarGroup}>
                        <View style={[styles.flowBar, { height: outH, backgroundColor: '#F97316' }]} />
                        <Text style={styles.flowBarLabel}>Out</Text>
                      </View>
                    </>
                  );
                })()}
              </View>
            </View>
            {insights.spent === 0 && insights.received === 0 && (
              <Text style={styles.insightNoData}>Send or receive money to see your weekly flow</Text>
            )}
          </View>
        )}

        {/* Payroll Banner */}
        {recentPayroll && wallets.length > 0 && (
          <TouchableOpacity
            style={styles.payrollBanner}
            onPress={() => (navigation as any).navigate('Transactions', { walletId: wallets[0].id, filter: 'payroll' })}
            activeOpacity={0.8}
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

        {/* Section Header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Wallet Overview</Text>
          {wallets.length > 0 && (
            <TouchableOpacity onPress={() => (navigation as any).navigate('Transactions', { walletId: wallets[0].id })} activeOpacity={0.75}>
              <Text style={styles.sectionLink}>View All</Text>
            </TouchableOpacity>
          )}
        </View>

        {loading && wallets.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#1565C0" />
            <Text style={styles.loadingText}>Loading your wallet...</Text>
          </View>
        ) : (
          <>
            {/* Overview Glass Card */}
            <TouchableOpacity
              style={styles.glassCard}
              onPress={() => { if (wallets.length > 0) (navigation as any).navigate('Transactions', { walletId: wallets[0].id }); }}
              activeOpacity={0.8}
            >
              <View style={[styles.cardIconCircle, { backgroundColor: '#DBEAFE' }]}>
                <Ionicons name="briefcase" size={22} color="#1565C0" />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>Wallet Balance</Text>
                <Text style={styles.cardSub}>
                  {wallets[0]?.balances?.length || 0} {wallets[0]?.balances?.length === 1 ? 'currency' : 'currencies'}
                </Text>
              </View>
              <Text style={styles.cardAmount}>
                {formatCurrency(
                  rates && wallets[0] ? convert(totalUsdValue(wallets[0]), 'USD', preferredCurrency, rates) : 0,
                  preferredCurrency
                )}
              </Text>
            </TouchableOpacity>

            {/* Wallet Details */}
            <View style={styles.detailsCard}>
              <Text style={styles.detailsTitle}>Wallet Details</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Wallet ID</Text>
                <Text style={styles.detailValue}>{wallets[0]?.id?.substring(0, 12)}...</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Status</Text>
                <View style={styles.statusBadge}>
                  <View style={styles.statusDot} />
                  <Text style={styles.statusText}>Active</Text>
                </View>
              </View>
              <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.detailLabel}>Capacity</Text>
                <Text style={styles.detailValue}>
                  ${(rates && wallets[0] ? Math.round(totalUsdValue(wallets[0]) / 100) : 0).toLocaleString()} / ${(wallets[0]?.maxLimitUSD || 250000).toLocaleString()}
                </Text>
              </View>
            </View>


          </>
        )}

        <View style={{ height: 36 }} />
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#C5DFF8',
  },
  scrollView: {
    flex: 1,
  },

  // Floating Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 58,
    paddingBottom: 8,
  },
  greetingText: {
    fontSize: 13,
    color: '#5C6E8A',
    fontWeight: '500',
    marginBottom: 2,
  },
  appTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0D1B2E',
    letterSpacing: -0.5,
  },
  profileBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Balance Hero Card
  balanceCard: {
    borderRadius: 24,
    marginHorizontal: 20,
    marginTop: 6,
    padding: 28,
    overflow: 'hidden',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.38,
    shadowRadius: 22,
    elevation: 14,
  },
  decorBlob1: {
    position: 'absolute',
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: 'rgba(255,255,255,0.07)',
    top: -45,
    right: -35,
  },
  decorBlob2: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,255,255,0.05)',
    bottom: -30,
    left: 10,
  },
  balanceLabel: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  balanceAmount: {
    fontSize: 46,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -1.5,
    marginBottom: 6,
  },
  balanceEquiv: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.62)',
    marginBottom: 18,
  },
  currencyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  currencyChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // Currency Selector
  currencySelector: {
    backgroundColor: 'rgba(255,255,255,0.96)',
    marginHorizontal: 20,
    marginTop: 10,
    borderRadius: 18,
    padding: 16,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  currencyLabel: {
    fontSize: 11,
    color: '#5C6E8A',
    fontWeight: '700',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  currencyButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#EEF3FA',
    marginRight: 8,
  },
  currencyButtonActive: {
    backgroundColor: '#1565C0',
  },
  currencyButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0D1B2E',
  },
  currencyButtonTextActive: {
    color: '#FFFFFF',
  },

  // Quick Actions
  quickActionsScroll: {
    marginTop: 26,
    marginBottom: 6,
  },
  quickActions: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 14,
  },
  quickActionBtn: {
    alignItems: 'center',
    width: 68,
  },
  quickActionIcon: {
    width: 58,
    height: 58,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 2,
  },
  quickActionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#3D4F6E',
  },

  // Payroll Banner
  payrollBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 16,
    marginHorizontal: 20,
    marginTop: 22,
    marginBottom: 4,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.08)',
  },
  payrollIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  payrollContent: {
    flex: 1,
  },
  payrollTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0D1B2E',
    marginBottom: 3,
  },
  payrollAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#00AA4F',
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 14,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  sectionLink: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1565C0',
  },

  // Glass Card
  glassCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 16,
    marginHorizontal: 20,
    marginBottom: 12,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.07)',
  },
  cardIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  cardBody: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0D1B2E',
    marginBottom: 3,
  },
  cardSub: {
    fontSize: 12,
    color: '#5C6E8A',
  },
  cardAmount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#00AA4F',
  },

  // Details Card
  detailsCard: {
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 20,
    marginHorizontal: 20,
    marginBottom: 12,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 2,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.07)',
  },
  detailsTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#5C6E8A',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 14,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.06)',
  },
  detailLabel: {
    fontSize: 13,
    color: '#5C6E8A',
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0D1B2E',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 5,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00C853',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#15803D',
  },

  // Currency Breakdown
  currencyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 16,
    marginHorizontal: 20,
    marginBottom: 10,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.06)',
  },
  currencyBadge: {
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 12,
  },
  currencyBadgeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1565C0',
  },
  currencyAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  currencyConverted: {
    fontSize: 12,
    color: '#5C6E8A',
    marginTop: 2,
  },

  // Loading
  loadingContainer: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#5C6E8A',
  },

  // Kept for safety (unused in updated JSX)
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1565C0',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 25,
    marginTop: 20,
    gap: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },

  // Smart Insights
  insightsCard: {
    marginHorizontal: 20,
    marginTop: 20,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.1)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  insightsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  insightsTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  insightsTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0D1B2E',
  },
  insightsPeriod: {
    fontSize: 12,
    color: '#9BAEC8',
    fontWeight: '500',
  },
  insightsStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  insightStat: {
    flex: 1,
    alignItems: 'center',
  },
  insightDivider: {
    width: 1,
    height: 44,
    backgroundColor: '#E1E8ED',
  },
  insightStatEmoji: {
    fontSize: 20,
    marginBottom: 4,
  },
  insightStatValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0D1B2E',
    letterSpacing: -0.5,
  },
  insightStatLabel: {
    fontSize: 11,
    color: '#9BAEC8',
    fontWeight: '600',
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  insightHighlight: {
    backgroundColor: '#EEF3FA',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 14,
  },
  insightHighlightText: {
    fontSize: 13,
    color: '#5C6E8A',
  },
  flowChart: {
    borderTopWidth: 1,
    borderTopColor: '#F0F4F9',
    paddingTop: 14,
  },
  flowChartTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9BAEC8',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  flowBarsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 20,
    height: 84,
  },
  flowBarGroup: {
    alignItems: 'center',
    gap: 6,
  },
  flowBar: {
    width: 52,
    borderRadius: 8,
  },
  flowBarLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#657786',
  },
  insightNoData: {
    fontSize: 13,
    color: '#9BAEC8',
    textAlign: 'center',
    marginTop: 12,
    fontStyle: 'italic',
  },
});
