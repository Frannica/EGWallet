import React, { useEffect, useState } from 'react';
import { View, Text, Button, TextInput, Alert, ScrollView } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { sendTransaction } from '../api/transactions';
import { useNavigation } from '@react-navigation/native';
import { majorToMinor, decimalsFor } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';

const FEE_PERCENTAGE = 0.01; // 1% fee

export default function SendScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [fromWalletId, setFromWalletId] = useState<string | null>(null);
  const [toWalletId, setToWalletId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [currency, setCurrency] = useState<string>('XAF');
  const [showConfirmation, setShowConfirmation] = useState(false);
  const navigation = useNavigation();

  useEffect(() => { loadWallets(); }, [auth.token]);

  async function loadWallets() {
    if (!auth.token) return;
    setLoading(true);
    try {
      const res = await listWallets(auth.token);
      setWallets(res.wallets || []);
      if ((res.wallets || []).length > 0) setFromWalletId((res.wallets || [])[0].id);
    } catch (e) {
      if (__DEV__) console.warn(e);
    } finally { setLoading(false); }
  }

  async function onSend() {
    if (!auth.token) return Alert.alert('Not authenticated');
    if (!fromWalletId) return Alert.alert('Select source wallet');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return Alert.alert('Enter valid amount');
    // convert to minor units
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert('Enter destination wallet id');
    
    // Show confirmation screen instead of sending directly
    setShowConfirmation(true);
  }

  function calculatePreview() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return null;

    const fee = amt * FEE_PERCENTAGE;
    const total = amt + fee;

    return {
      amount: amt,
      fee,
      total,
      recipientGets: amt, // In real app, apply exchange rate here
    };
  }

  async function onSendConfirmed() {
    if (!auth.token) return Alert.alert('Not authenticated');
    if (!fromWalletId) return Alert.alert('Select source wallet');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return Alert.alert('Enter valid amount');
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert('Enter destination wallet id');

    setLoading(true);
    try {
      const res = await sendTransaction(auth.token, fromWalletId, toWalletId, amountMinor, currency);
      Alert.alert('Success', 'Transaction created');
      loadWallets();
      setAmount('');
      setShowConfirmation(false);
      // @ts-ignore
      navigation.navigate('Transactions' as any, { walletId: fromWalletId } as any);
    } catch (e: any) {
      Alert.alert('Send failed', e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const preview = calculatePreview();

  // Confirmation screen
  if (showConfirmation && preview) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
        <View style={{ padding: 16 }}>
          <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 24, color: '#333' }}>
            Confirm Transaction
          </Text>

          {/* Transaction Summary */}
          <View style={{ backgroundColor: '#fff', padding: 16, borderRadius: 8, marginBottom: 16 }}>
            <Text style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>From: {fromWalletId}</Text>
            <Text style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>To: {toWalletId}</Text>
            <Text style={{ fontSize: 14, color: '#666', marginBottom: 16 }}>Currency: {currency}</Text>

            <View style={{ borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ color: '#666' }}>Amount:</Text>
                <Text style={{ fontWeight: '600' }}>{preview.amount.toFixed(2)} {currency}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ color: '#666' }}>Fee (1%):</Text>
                <Text style={{ color: '#d32f2f' }}>-{preview.fee.toFixed(2)} {currency}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 8, marginBottom: 8 }}>
                <Text style={{ fontWeight: 'bold', color: '#333' }}>Total Charge:</Text>
                <Text style={{ fontWeight: 'bold', fontSize: 16 }}>{preview.total.toFixed(2)} {currency}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: '#666' }}>Recipient Gets:</Text>
                <Text style={{ fontWeight: '600', color: '#2e7d32' }}>{preview.recipientGets.toFixed(2)} {currency}</Text>
              </View>
            </View>
          </View>

          {/* Buttons */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                onPress={() => setShowConfirmation(false)}
                color="#999"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title={loading ? 'Sending...' : 'Confirm Send'}
                onPress={onSendConfirmed}
                disabled={loading}
                color="#007AFF"
              />
            </View>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => loadWallets()} />
      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 16 }}>Send Money</Text>

        {loading && <Text>Loading wallets...</Text>}

        <Text style={{ marginTop: 12, fontWeight: '600' }}>From wallet</Text>
        {wallets.map(w => (
          <Button
            key={w.id}
            title={w.id}
            onPress={() => setFromWalletId(w.id)}
            color={fromWalletId === w.id ? '#007AFF' : undefined}
          />
        ))}

        <Text style={{ marginTop: 12, fontWeight: '600' }}>To wallet ID</Text>
        <TextInput
          value={toWalletId}
          onChangeText={setToWalletId}
          placeholder="Destination wallet id"
          editable={!loading}
          style={{ borderWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 12, borderRadius: 4 }}
        />

        <Text style={{ fontWeight: '600' }}>Amount</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="numeric"
          editable={!loading}
          style={{ borderWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 12, borderRadius: 4 }}
        />

        <Text style={{ fontWeight: '600' }}>Currency</Text>
        <TextInput
          value={currency}
          onChangeText={setCurrency}
          editable={!loading}
          style={{ borderWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 12, borderRadius: 4 }}
        />

        <View style={{ backgroundColor: '#f0f7ff', padding: 12, borderRadius: 8, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: '#007AFF' }}>
          <Text style={{ fontSize: 13, color: '#00539b' }}>
            ℹ️ The receiver will receive this payment in their preferred currency if they have auto-convert enabled, or in the original currency ({currency}) if they prefer multi-currency wallets.
          </Text>
        </View>

        <Button
          title="Review & Send"
          onPress={onSend}
          disabled={!amount || !toWalletId || loading || !isOnline}
          color="#007AFF"
        />
      </View>
    </ScrollView>
  );
}

