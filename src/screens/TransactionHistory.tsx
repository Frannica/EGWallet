import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, Alert } from 'react-native';
import { formatCurrency } from '../utils/currency';
import { useRoute, RouteProp } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { fetchTransactions } from '../api/transactions';
import { useTheme } from '../contexts/ThemeContext';
import { generateAndShareReceipt } from '../utils/ReceiptGenerator';

type Params = { params: { walletId: string } };

export default function TransactionHistory() {
  const route = useRoute() as RouteProp<Record<string, Params>, string>;
  const walletId = (route.params as any)?.walletId;
  const auth = useAuth();
  const { colors } = useTheme();
  const [txs, setTxs] = useState<any[]>([]);
  const [filteredTxs, setFilteredTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!walletId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchTransactions(auth.token || '', walletId);
        setTxs(res.transactions || []);
        setFilteredTxs(res.transactions || []);
      } catch (e) {
        if (__DEV__) console.warn('Fetch tx failed', e);
      } finally {
        setLoading(false);
      } flex: 1, backgroundColor: colors.background }}>
      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 12, color: colors.text }}>Transactions</Text>

        {/* Search Bar */}
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search transactions..."
          placeholderTextColor={colors.textSecondary}
          style={{
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            color: colors.text,
          }}
        />

        {/* Filter Buttons */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <TouchableOpacity
            onPress={() => setStatusFilter(null)}
            style={{
              backgroundColor: statusFilter === null ? colors.primary : colors.card,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: statusFilter === null ? '#fff' : colors.text, fontSize: 13, fontWeight: '600' }}>
              All
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setStatusFilter('completed')}
            style={{
              backgroundColor: statusFilter === 'completed' ? colors.primary : colors.card,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: statusFilter === 'completed' ? '#fff' : colors.text, fontSize: 13, fontWeight: '600' }}>
              Completed
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setStatusFilter('pending')}
            style={{
              backgroundColor: statusFilter === 'pending' ? colors.primary : colors.card,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: statusFilter === 'pending' ? '#fff' : colors.text, fontSize: 13, fontWeight: '600' }}>
              Pending
            </Text>
          </TouchableOpacity>
          {(searchQuery || statusFilter) && (
            <TouchableOpacity
              onPress={clearFilters}
              style={{
                backgroundColor: colors.card,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Clear Filters</Text>
            </TouchableOpacity>
          )}
        </View>

        {loading && <Text style={{ color: colors.textSecondary }}>Loading...</Text>}
        {!loading && filteredTxs.length === 0 && (
          <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 32 }}>
            {searchQuery || statusFilter ? 'No transactions match your filters' : 'No transactions yet'}
          </Text>
        )}
      </View>

      <FlatList
        data={filteredTxs}
        keyExtractor={t => t.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
        renderItem={({ item }) => (
          <View
            style={{
              backgroundColor: colors.card,
              padding: 16,
              borderRadius: 8,
              marginBottom: 12,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ fontWeight: '600', color: colors.text, fontSize: 16 }}>{item.status}</Text>
              <TouchableOpacity
                onPress={() => handleGenerateReceipt(item)}
                style={{ backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>📄 Receipt</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ color: colors.text, marginBottom: 4 }}>
              Sent: {item.currency} {formatCurrency(item.amount, item.currency)}
            </Text>
            {item.wasConverted && item.receivedCurrency !== item.currency && (
              <Text style={{ color: colors.primary, fontSize: 13, marginBottom: 4 }}>
                → Received: {item.receivedCurrency} {formatCurrency(item.receivedAmount, item.receivedCurrency)} (auto-converted)
              </Text>
            )}
            {!item.wasConverted && item.receivedCurrency && item.receivedCurrency !== item.currency && (
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 4 }}>
                Received: {item.receivedCurrency} {formatCurrency(item.receivedAmount, item.receivedCurrency)} (original currency)
              </Text>
            )}
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>
              {new Date(item.timestamp).toLocaleString()}
            </Text>
            {item.memo ? (
              <Text style={{ fontSize: 12, color: colors.text, fontStyle: 'italic', marginTop: 4 }}>"{item.memo}"</Text>
            ) : null}
          </View>
        )}
     

    // Status filter
    if (statusFilter) {
      filtered = filtered.filter(tx => tx.status === statusFilter);
    }

    setFilteredTxs(filtered);
  };

  const handleGenerateReceipt = async (transaction: any) => {
    try {
      await generateAndShareReceipt(transaction, auth.user?.email || 'user@egwallet.com');
    } catch (e) {
      Alert.alert('Error', 'Failed to generate receipt');
    }
  };

  const clearFilters = () => {
    setSearchQuery('');
    setStatusFilter(null);
  };

  return (
    <View style={{flex:1,padding:16}}>
      <Text style={{fontSize:18,fontWeight:'600',marginBottom:8}}>Transactions</Text>
      {loading && <Text>Loading...</Text>}
      <FlatList data={txs} keyExtractor={t=>t.id} renderItem={({item})=> (
        <View style={{padding:10,borderBottomWidth:1,borderColor:'#eee'}}>
          <Text style={{fontWeight:'600'}}>{item.status}</Text>
          <Text>
            Sent: {item.currency} {formatCurrency(item.amount, item.currency)}
          </Text>
          {item.wasConverted && item.receivedCurrency !== item.currency && (
            <Text style={{color:'#007AFF',fontSize:13}}>
              → Received: {item.receivedCurrency} {formatCurrency(item.receivedAmount, item.receivedCurrency)} (auto-converted)
            </Text>
          )}
          {!item.wasConverted && item.receivedCurrency && item.receivedCurrency !== item.currency && (
            <Text style={{color:'#666',fontSize:13}}>
              Received: {item.receivedCurrency} {formatCurrency(item.receivedAmount, item.receivedCurrency)} (original currency)
            </Text>
          )}
          <Text style={{color:'#666',fontSize:12}}>{new Date(item.timestamp).toLocaleString()}</Text>
          {item.memo ? <Text style={{fontSize:12}}>{item.memo}</Text> : null}
        </View>
      )} />
    </View>
  );
}
