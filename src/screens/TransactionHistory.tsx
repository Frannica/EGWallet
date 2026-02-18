import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { formatCurrency } from '../utils/currency';
import { useRoute, RouteProp } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { fetchTransactions } from '../api/transactions';
import { Ionicons } from '@expo/vector-icons';

type Params = { params: { walletId: string } };

export default function TransactionHistory() {
  const route = useRoute() as RouteProp<Record<string, Params>, string>;
  const walletId = (route.params as any)?.walletId;
  const auth = useAuth();
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function loadTransactions() {
    if (!walletId) return;
    setLoading(true);
    try {
      const res = await fetchTransactions(auth.token || '', walletId);
      setTxs(res.transactions || []);
    } catch (e) {
      if (__DEV__) console.warn('Fetch tx failed', e);
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
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading transactions...</Text>
      </View>
    );
  }

  if (!loading && txs.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="receipt-outline" size={64} color="#AAB8C2" />
        <Text style={styles.emptyTitle}>No Transactions Yet</Text>
        <Text style={styles.emptyText}>
          When you send or receive money,{'\n'}your transactions will appear here.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList 
        data={txs}
        keyExtractor={t => t.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#007AFF']} />
        }
        contentContainerStyle={styles.listContent}
        renderItem={({item}) => {
          const statusColor = getStatusColor(item.status);
          const statusIcon = getStatusIcon(item.status);
          
          return (
            <View style={styles.transactionCard}>
              <View style={styles.transactionHeader}>
                <View style={[styles.iconContainer, { backgroundColor: `${statusColor}15` }]}>
                  <Ionicons name={statusIcon as any} size={24} color={statusColor} />
                </View>
                <View style={styles.transactionContent}>
                  <View style={styles.transactionTop}>
                    <Text style={styles.transactionTitle}>
                      {item.type === 'received' ? 'Money Received' : 'Money Sent'}
                    </Text>
                    <Text style={[styles.transactionAmount, item.type === 'received' && styles.transactionAmountPositive]}>
                      {item.type === 'received' ? '+' : '-'}{formatCurrency(item.amount, item.currency)}
                    </Text>
                  </View>
                  
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
});
