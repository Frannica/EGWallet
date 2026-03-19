import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator, TouchableOpacity } from 'react-native';
import { formatCurrency } from '../utils/currency';
import { useRoute, RouteProp, useNavigation } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { fetchTransactions } from '../api/transactions';
import { Ionicons } from '@expo/vector-icons';
import { generateAndShareReceipt } from '../utils/receiptGenerator';
import { TransactionCardSkeleton } from '../components/SkeletonLoader';

type Params = { params: { walletId: string } };

function groupTransactions(txs: any[]): any[] {
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;
  const buckets: [string, any[]][] = [
    ['Today', []],
    ['Yesterday', []],
    ['This Week', []],
    ['Earlier', []],
  ];
  for (const tx of txs) {
    const ts =
      typeof tx.timestamp === 'string'
        ? new Date(tx.timestamp).getTime()
        : (tx.timestamp as number);
    if (ts >= todayStart)        buckets[0][1].push(tx);
    else if (ts >= yesterdayStart) buckets[1][1].push(tx);
    else if (ts >= weekStart)      buckets[2][1].push(tx);
    else                           buckets[3][1].push(tx);
  }
  const result: any[] = [];
  for (const [label, items] of buckets) {
    if (items.length === 0) continue;
    result.push({ kind: 'header', id: `hdr_${label}`, label });
    for (const tx of items) result.push({ kind: 'tx', ...tx });
  }
  return result;
}

export default function TransactionHistory() {
  const route = useRoute() as RouteProp<Record<string, Params>, string>;
  const navigation = useNavigation();
  const walletId = (route.params as any)?.walletId;
  const routeFilter = (route.params as any)?.filter;
  const auth = useAuth();
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'payroll' | 'sent' | 'received'>(routeFilter || 'all');

  const DEMO_TXS = [
    { id: 'dtx-1', type: 'receive', direction: 'in', amount: 50000, currency: 'XAF', status: 'completed', timestamp: Date.now() - 1 * 3600000, memo: 'Salary payment' },
    { id: 'dtx-2', type: 'send', direction: 'out', amount: 12500, currency: 'XAF', status: 'completed', timestamp: Date.now() - 26 * 3600000 },
    { id: 'dtx-3', type: 'payroll', direction: 'in', amount: 150000, currency: 'XAF', status: 'completed', timestamp: Date.now() - 3 * 86400000, payrollMetadata: { employerName: 'Acme Corp', payPeriod: 'March 2026' } },
    { id: 'dtx-4', type: 'send', direction: 'out', amount: 25000, currency: 'XAF', status: 'completed', timestamp: Date.now() - 5 * 86400000 },
    { id: 'dtx-5', type: 'withdrawal', direction: 'out', amount: 30000, currency: 'XAF', status: 'completed', timestamp: Date.now() - 10 * 86400000 },
    { id: 'dtx-6', type: 'receive', direction: 'in', amount: 8000, currency: 'USD', status: 'completed', timestamp: Date.now() - 14 * 86400000 },
  ];

  async function loadTransactions() {
    setLoading(true);
    try {
      if (!walletId) throw new Error('no_wallet');
      const res = await fetchTransactions(auth.token || '', walletId);
      const loaded = res.transactions || [];
      setTxs(loaded.length > 0 ? loaded : DEMO_TXS);
    } catch (e) {
      if (__DEV__) console.warn('Fetch tx failed — using demo data', e);
      setTxs(DEMO_TXS);
    } finally {
      setLoading(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await loadTransactions();
    setRefreshing(false);
  }

  useEffect(() => {
    loadTransactions();
  }, [walletId]);

  // Filter transactions based on selected filter
  const filteredTxs = txs.filter(tx => {
    if (filter === 'all') return true;
    if (filter === 'payroll') return tx.type === 'payroll' || tx.type === 'payroll_request';
    if (filter === 'sent') return tx.direction === 'out';
    if (filter === 'received') return tx.direction === 'in';
    return true;
  });

  // Group filtered transactions by date period
  const groupedData = useMemo(() => groupTransactions(filteredTxs), [filteredTxs]);

  // Show filter bar whenever there are transactions
  const showFilterBar = txs.length > 0;

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'completed': 
      case 'success': 
        return '#2E7D32';
      case 'pending': 
        return '#F57C00';
      case 'failed': 
        return '#D32F2F';
      default: 
        return '#657786';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'completed': 
      case 'success': 
        return 'checkmark-circle';
      case 'pending': 
        return 'time';
      case 'failed': 
        return 'close-circle';
      default: 
        return 'help-circle';
    }
  };

  const formatDate = (timestamp: string | number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading && txs.length === 0) {
    return ( <View style={styles.container}>
        <View style={styles.listContent}>
          <TransactionCardSkeleton />
          <TransactionCardSkeleton />
          <TransactionCardSkeleton />
          <TransactionCardSkeleton />
          <TransactionCardSkeleton />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Filter Tabs */}
      {showFilterBar && (
        <View style={styles.filterBar}>
          <TouchableOpacity
            style={[styles.filterTab, filter === 'all' && styles.filterTabActive]}
            onPress={() => setFilter('all')}
          >
            <Text style={[styles.filterTabText, filter === 'all' && styles.filterTabTextActive]}>
              All
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterTab, filter === 'payroll' && styles.filterTabActive]}
            onPress={() => setFilter('payroll')}
          >
            <Ionicons name="briefcase" size={16} color={filter === 'payroll' ? '#007AFF' : '#657786'} />
            <Text style={[styles.filterTabText, filter === 'payroll' && styles.filterTabTextActive]}>
              Payroll
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterTab, filter === 'sent' && styles.filterTabActive]}
            onPress={() => setFilter('sent')}
          >
            <Text style={[styles.filterTabText, filter === 'sent' && styles.filterTabTextActive]}>
              Sent
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterTab, filter === 'received' && styles.filterTabActive]}
            onPress={() => setFilter('received')}
          >
            <Text style={[styles.filterTabText, filter === 'received' && styles.filterTabTextActive]}>
              Received
            </Text>
          </TouchableOpacity>
        </View>
      )}
      
      <FlatList 
        data={groupedData}
        keyExtractor={item => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#007AFF']} />
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Text style={{ fontSize: 15, color: '#9BAEC8', textAlign: 'center' }}>
              No {filter === 'all' ? '' : filter} transactions found.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return (
              <View style={styles.timelineGroupHeader}>
                <View style={styles.timelineGroupLine} />
                <Text style={styles.timelineGroupLabel}>{item.label}</Text>
                <View style={styles.timelineGroupLine} />
              </View>
            );
          }
          const statusColor = getStatusColor(item.status);
          const statusIcon = getStatusIcon(item.status);
          const isPayroll = item.type === 'payroll' || item.type === 'payroll_request';
          const isQrPayment = item.type === 'qr_payment';
          const isWithdrawal = item.type === 'withdrawal';
          const isIn = item.direction === 'in';
          const employerName = item.payrollMetadata?.employerName || 'Employer';

          const txTitle = isPayroll
            ? `Salary from ${employerName}`
            : isQrPayment
            ? (isIn ? 'QR Payment Received' : 'QR Payment Sent')
            : isWithdrawal
            ? 'Withdrawal'
            : isIn
            ? 'Money Received'
            : 'Money Sent';

          const txIcon = isPayroll
            ? 'briefcase'
            : isQrPayment
            ? 'qr-code'
            : isWithdrawal
            ? 'log-out'
            : isIn
            ? 'arrow-down-circle'
            : 'arrow-up-circle';

          const txIconColor = isPayroll
            ? '#1976D2'
            : isQrPayment
            ? '#7C3AED'
            : isWithdrawal
            ? '#F57C00'
            : isIn
            ? '#2E7D32'
            : '#D32F2F';

          const txIconBg = isPayroll
            ? '#E3F2FD'
            : isQrPayment
            ? '#F3E8FF'
            : isWithdrawal
            ? '#FFF3E0'
            : isIn
            ? '#E8F5E9'
            : '#FFEBEE';

          const showPlus = isIn || isPayroll;
          const accentColor = isPayroll ? '#1976D2' : isWithdrawal ? '#F57C00' : isIn ? '#22C55E' : '#1565C0';
          
          return (
            <View style={[styles.transactionCard, { borderLeftWidth: 3, borderLeftColor: accentColor }]}>
              <View style={styles.transactionHeader}>
                <View style={[styles.iconContainer, { backgroundColor: txIconBg }]}>
                  <Ionicons
                    name={txIcon as any}
                    size={24}
                    color={txIconColor}
                  />
                </View>
                <View style={styles.transactionContent}>
                  <View style={styles.transactionTop}>
                    <Text style={styles.transactionTitle}>{txTitle}</Text>
                    <Text style={[styles.transactionAmount, showPlus && styles.transactionAmountPositive]}>
                      {showPlus ? '+' : '-'}{formatCurrency(item.amount, item.currency)}
                    </Text>
                  </View>
                  
                  {isPayroll && item.payrollMetadata?.payPeriod && (
                    <Text style={styles.payrollPeriod}>
                      {item.payrollMetadata.payPeriod}
                    </Text>
                  )}
                  
                  <View style={styles.transactionDetails}>
                    <View style={styles.statusBadge}>
                      <Text style={[styles.statusText, { color: statusColor }]}>
                        {item.status}
                      </Text>
                    </View>
                    <Text style={styles.transactionTime}>{formatDate(item.timestamp)}</Text>
                  </View>

                  {item.wasConverted && item.receivedCurrency !== item.currency && (
                    <View style={styles.conversionInfo}>
                      <Ionicons name="swap-horizontal" size={14} color="#007AFF" />
                      <Text style={styles.conversionText}>
                        Converted to {formatCurrency(item.receivedAmount, item.receivedCurrency)}
                      </Text>
                    </View>
                  )}

                  {item.memo && (
                    <Text style={styles.memoText} numberOfLines={1}>
                      {item.memo}
                    </Text>
                  )}
                  
                  {/* Action Buttons */}
                  {item.status === 'completed' && (
                    <View style={styles.actionButtons}>
                      <TouchableOpacity
                        style={styles.receiptButton}
                        onPress={() => generateAndShareReceipt(item, auth.user?.email || 'user@egwallet.com')}
                      >
                        <Ionicons name="document-text" size={16} color="#007AFF" />
                        <Text style={styles.receiptButtonText}>Receipt</Text>
                      </TouchableOpacity>
                      
                      {isPayroll && (
                        <TouchableOpacity
                          style={styles.fraudButton}
                          onPress={() => (navigation as any).navigate('ReportProblem', { transactionId: item.id })}
                        >
                          <Ionicons name="shield-checkmark" size={16} color="#FF3B30" />
                          <Text style={styles.fraudButtonText}>Report</Text>
                        </TouchableOpacity>
                      )}
                      
                      {!isPayroll && (
                        <TouchableOpacity
                          style={styles.disputeButton}
                          onPress={() => (navigation as any).navigate('DisputeTransaction')}
                        >
                          <Ionicons name="alert-circle" size={16} color="#FF9500" />
                          <Text style={styles.disputeButtonText}>Dispute</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F7FA',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#657786',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#F5F7FA',
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#14171A',
    marginTop: 16,
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
  transactionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  transactionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  transactionContent: {
    flex: 1,
  },
  transactionTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  transactionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
    flex: 1,
  },
  transactionAmount: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#14171A',
  },
  transactionAmountPositive: {
    color: '#2E7D32',
  },
  transactionDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  transactionTime: {
    fontSize: 13,
    color: '#657786',
  },
  conversionInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F5F8FA',
  },
  conversionText: {
    fontSize: 13,
    color: '#007AFF',
    marginLeft: 4,
  },
  memoText: {
    fontSize: 13,
    color: '#657786',
    marginTop: 4,
    fontStyle: 'italic',
  },
  actionButtons: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  receiptButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#F0F7FF',
    borderRadius: 8,
    gap: 6,
  },
  receiptButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  disputeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#FFF8E6',
    borderRadius: 8,
    gap: 6,
  },
  disputeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FF9500',
  },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
    gap: 8,
  },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: '#F5F8FA',
    gap: 4,
  },
  filterTabActive: {
    backgroundColor: '#E3F2FD',
  },
  filterTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#657786',
  },
  filterTabTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  payrollPeriod: {
    fontSize: 13,
    color: '#1976D2',
    marginBottom: 4,
    fontWeight: '500',
  },
  fraudButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    gap: 6,
  },
  fraudButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FF3B30',
  },
  timelineGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  timelineGroupLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E1E8ED',
  },
  timelineGroupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9BAEC8',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
