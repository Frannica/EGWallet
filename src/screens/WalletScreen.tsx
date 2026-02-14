import React, { useEffect, useState } from 'react';
import { View, Text, Button, FlatList, TouchableOpacity } from 'react-native';
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
  const [rates, setRates] = useState<Rates | null>(null);
  const [preferredCurrency, setPreferredCurrency] = useState<string>('XAF');
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

  useEffect(() => {
    loadRates();
  }, []);

  useEffect(() => { loadWallets(); }, [auth.token]);

  function totalUsdValue(wallet: any) {
    if (!rates) return 0;
    return (wallet.balances || []).reduce((s: number, b: Balance) => s + (b.amount / (rates.values[b.currency] ?? 1)), 0);
  }

  return (
    <View style={{flex:1}}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => { loadWallets(); loadRates(); }} />
      <View style={{flex:1,padding:16}}>
        <Text style={{fontSize:20,fontWeight:'600'}}>Wallet</Text>
        <Button title="Refresh" onPress={() => { loadWallets(); loadRates(); }} />
        {loading && <Text>Loading...</Text>}

      <View style={{flexDirection:'row',marginTop:12,marginBottom:8,alignItems:'center'}}>
        <Text style={{marginRight:8}}>Display currency:</Text>
        {/* Simple currency selector - picks preferredCurrency */}
        {['XAF','USD','EUR','GBP','JPY','CAD','BRL','NGN','GHS','ZAR','CNY','KES','TZS','ETB','EGP','MAD','BWP','NAD','LSL','ZWL','MZN','TND','LYD','DZD','AOA','ERN','SCR','SOS','SDG','GMD','MUR'].map(c => (
          <TouchableOpacity key={c} onPress={()=>setPreferredCurrency(c)} style={{padding:6,marginRight:6,backgroundColor: preferredCurrency===c ? '#007AFF' : '#eee',borderRadius:6}}>
            <Text style={{color: preferredCurrency===c ? '#fff' : '#000'}}>{c}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList data={wallets} keyExtractor={item=>item.id} renderItem={({item})=> (
        <View style={{padding:12,borderBottomWidth:1,borderColor:'#eee'}}>
          <Text style={{fontWeight:'600'}}>Wallet ID: {item.id}</Text>
          {(item.balances||[]).map((b:Balance)=> {
            const displayMinor = rates ? convert(b.amount, b.currency, preferredCurrency, rates) : b.amount;
            return (
              <Text key={b.currency}>{b.currency}: {formatCurrency(b.amount, b.currency)} — {preferredCurrency}: {formatCurrency(displayMinor, preferredCurrency)}</Text>
            );
          })}
          {/* Wallet capacity warning */}
          { rates && (()=>{
            const totalUSD = totalUsdValue(item);
            if (totalUSD > (item.maxLimitUSD || 250000)) {
              return <Text style={{color:'red',marginTop:8}}>Warning: wallet exceeds max allowed (${item.maxLimitUSD || 250000})</Text>;
            }
            if (totalUSD > ((item.maxLimitUSD || 250000) * 0.9)) {
              return <Text style={{color:'#b55700',marginTop:8}}>Warning: wallet approaching capacity</Text>;
            }
            return null;
          })() }
          <View style={{marginTop:8}}>
            <Button title="View Transactions" onPress={()=> // @ts-ignore
            navigation.navigate('Transactions', { walletId: item.id })} />
          </View>
        </View>
      )} />
      </View>
    </View>
  );
}

