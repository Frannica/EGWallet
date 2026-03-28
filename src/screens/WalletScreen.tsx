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
import { getLocalBalances, mergeWithLocalBalances } from '../utils/localBalance';

type Balance = { currency: string; amount: number };

const DEMO_WALLET = {
  id: 'demo',
  balances: [{ currency: 'XAF', amount: 0 }],
  maxLimitUSD: 250000,
};

export default function WalletScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [preferredCurrency, setPreferredCurrency] = useState<string>(auth.user?.preferredCurrency || 'USD');
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
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
      if (__DEV__) console.warn('Failed to load rates � using demo rates', e);
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
    } catch (e: any) {
      if (__DEV__) console.warn('Load wallets failed:', e?.message);
      setApiError(e?.message || 'Unable to reach the server.');
      // Show demo wallet with local balances so the UI stays functional
      const localBalancesOnError = await getLocalBalances();
      const localCurrencies = Object.entries(localBalancesOnError).filter(([, amt]) => amt > 0);
      const fallbackBalances = localCurrencies.length > 0
        ? localCurrencies.map(([cur, amt]) => ({ currency: cur, amount: amt }))
        : [{ currency: preferredCurrency, amount: 0 }];
      setWallets(prev => {
        if (localCurrencies.length > 0) {
          // User has locally-stored balance — always reflect it, even on repeat refreshes
          return [{ ...(prev[0] || DEMO_WALLET), balances: fallbackBalances }];
        }
        return prev.length === 0 ? [{ ...DEMO_WALLET, balances: [{ currency: preferredCurrency, amount: 0 }] }] : prev;
      });
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

  // Poll unread notification count whenever screen is focused
  useFocusEffect(
    React.useCallback(() => {
      if (auth.token) {
        import('../api/client').then(({ API_BASE }) => {
          fetch(`${API_BASE}/notifications`, { headers: { Authorization: `Bearer ${auth.token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) setUnreadNotifCount(d.unreadCount ?? 0); })
            .catch(() => {});
        });
      }
    }, [auth.token])
  );

  // Reload balance whenever this screen comes back into focus (e.g. after a deposit)
  useFocusEffect(
    React.useCallback(() => {
      if (auth.token) loadWallets();
    }, [auth.token])
  );

  function totalUsdValue(wallet: any) {
    if (!rates || !wallet) return 0;
    return (wallet.balances || []).reduce((s: number, b: Balance) => s + convert(b.amount, b.currency, 'USD', rates!), 0);
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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              style={styles.profileBtn}
              onPress={() => (navigation as any).navigate('Notifications')}
              activeOpacity={0.75}
            >
              <Ionicons name="notifications-outline" size={28} color="#1565C0" />
              {unreadNotifCount > 0 && (
                <View style={styles.notifBadge}>
                  <Text style={styles.notifBadgeText}>
                    {unreadNotifCount > 9 ? '9+' : String(unreadNotifCount)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.profileBtn}
              onPress={() => (navigation as any).navigate('Settings')}
              activeOpacity={0.75}
            >
              <Ionicons name="person-circle-outline" size={38} color="#1565C0" />
            </TouchableOpacity>
          </View>
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
            <Text style={styles.balanceEquiv}>� {formatCurrency(calculateTotalBalance(), 'USD')}</Text>
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
                  onPress={() => {
                    setPreferredCurrency(c);
                    setShowCurrencyPicker(false);
                    auth.updatePreferredCurrency(c);
                  }}
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

        {/* Wallet Overview */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Wallet Overview</Text>
          <TouchableOpacity onPress={() => (navigation as any).navigate('Transactions', { walletId: wallets[0]?.id })}>
            <Text style={styles.sectionLink}>View All</Text>
          </TouchableOpacity>
        </View>

        {wallets.flatMap(wallet =>
          (wallet.balances || [])
            .filter((b: Balance) => b.amount > 0)
            .map((b: Balance) => (
              <View key={`${wallet.id}-${b.currency}`} style={styles.currencyCard}>
                <View style={styles.currencyBadge}>
                  <Text style={styles.currencyBadgeText}>{b.currency}</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <Text style={styles.currencyAmount}>{formatCurrency(b.amount, b.currency)}</Text>
                  {rates && b.currency !== 'USD' && (
                    <Text style={styles.currencyConverted}>
                      ≈ {formatCurrency(convert(b.amount, b.currency, 'USD', rates), 'USD')}
                    </Text>
                  )}
                </View>
              </View>
            ))
        )}
        {(wallets.length === 0 || wallets.every(w => (w.balances || []).every((b: Balance) => b.amount === 0))) && (
          <View style={[styles.currencyCard, { justifyContent: 'center' }]}>
            <Text style={{ color: '#5C6E8A', fontSize: 14 }}>No balance yet. Add money to get started.</Text>
          </View>
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
  notifBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#DC2626',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  notifBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
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

});
