import React, { useEffect, useState } from 'react';
import { View, Text, FlatList } from 'react-native';
import { formatCurrency } from '../utils/currency';
import { useRoute, RouteProp } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { fetchTransactions } from '../api/transactions';

type Params = { params: { walletId: string } };

export default function TransactionHistory() {
  const route = useRoute() as RouteProp<Record<string, Params>, string>;
  const walletId = (route.params as any)?.walletId;
  const auth = useAuth();
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!walletId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchTransactions(auth.token || '', walletId);
        setTxs(res.transactions || []);
      } catch (e) {
        if (__DEV__) console.warn('Fetch tx failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [walletId]);

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
