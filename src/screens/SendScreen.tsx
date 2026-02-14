import React, { useEffect, useState } from 'react';
import { View, Text, Button, TextInput, Alert, ScrollView, TouchableOpacity } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { sendTransaction } from '../api/transactions';
import { useNavigation } from '@react-navigation/native';
import { majorToMinor } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { useTheme } from '../contexts/ThemeContext';
import { requireBiometric } from '../utils/BiometricAuth';
import { getRecentContacts, markContactAsUsed } from '../utils/ContactsManager';
import { notifyTransactionSent } from '../utils/NotificationService';

const FEE_PERCENTAGE = 0.01; // 1% fee

export default function SendScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const { colors } = useTheme();
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [fromWalletId, setFromWalletId] = useState<string | null>(null);
  const [toWalletId, setToWalletId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [currency, setCurrency] = useState<string>('XAF');
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [recentContacts, setRecentContacts] = useState<any[]>([]);
  const navigation = useNavigation();

  useEffect(() => {
    loadWallets();
    loadRecentContacts();
  }, [auth.token]);

  async function loadWallets() {
    if (!auth.token) return;
    setLoading(true);
    try {
      const res = await listWallets(auth.token);
      setWallets(res.wallets || []);
      if ((res.wallets || []).length > 0) setFromWalletId((res.wallets || [])[0].id);
    } catch (e) {
      if (__DEV__) console.warn(e);
    } finally {
      setLoading(false);
    }
  }

  async function loadRecentContacts() {
    const contacts = await getRecentContacts(3);
    setRecentContacts(contacts);
  }

  function handleQRScan() {
    // @ts-ignore
    navigation.navigate('QRScanner', {
      title: 'Scan Recipient Wallet',
      onScan: (data: string) => {
        setToWalletId(data);
      },
    });
  }

  async function handleContactSelect(walletId: string) {
    setToWalletId(walletId);
    await markContactAsUsed(walletId);
  }

  async function onSend() {
    if (!auth.token) return Alert.alert('Not authenticated');
    if (!fromWalletId) return Alert.alert('Select source wallet');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return Alert.alert('Enter valid amount');
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert('Enter destination wallet id');

    setShowConfirmation(true);
  }

  async function onSendConfirmed() {
    if (!auth.token) return Alert.alert('Not authenticated');
    if (!fromWalletId) return Alert.alert('Select source wallet');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return Alert.alert('Enter valid amount');
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert('Enter destination wallet id');

    // Require biometric authentication
    const authenticated = await requireBiometric('send money');
    if (!authenticated) {
      Alert.alert('Authentication Required', 'Biometric authentication is required to send money');
      return;
    }

    setLoading(true);
    try {
      const res = await sendTransaction(auth.token, fromWalletId, toWalletId, amountMinor, currency);

      // Send success notification
      await notifyTransactionSent(amt, currency, toWalletId);

      Alert.alert('Success', 'Transaction created');
      loadWallets();
      setAmount('');
      setToWalletId('');
      setShowConfirmation(false);
      // @ts-ignore
      navigation.navigate('Transactions' as any, { walletId: fromWalletId } as any);
    } catch (e: any) {
      Alert.alert('Send failed', e.message || String(e));
    } finally {
      setLoading(false);
    }
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
    };
  }

  const preview = calculatePreview();

  // Confirmation screen
  if (showConfirmation && preview) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: 16 }}>
          <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 24, color: colors.text }}>
            Confirm Transaction
          </Text>

          {/* Transaction Summary */}
          <View style={{ backgroundColor: colors.card, padding: 16, borderRadius: 8, marginBottom: 16, borderWidth: 1, borderColor: colors.border }}>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>From</Text>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{fromWalletId}</Text>
            </View>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>To</Text>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{toWalletId}</Text>
            </View>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>Amount</Text>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>
                {preview.amount.toFixed(2)} {currency}
              </Text>
            </View>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>Fee (1%)</Text>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>
                {preview.fee.toFixed(2)} {currency}
              </Text>
            </View>
            <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>Total</Text>
              <Text style={{ fontSize: 20, fontWeight: 'bold', color: colors.text }}>
                {preview.total.toFixed(2)} {currency}
              </Text>
            </View>
          </View>

          {/* Buttons */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                onPress={() => setShowConfirmation(false)}
                color={colors.textSecondary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Confirm & Send"
                onPress={onSendConfirmed}
                disabled={loading || !isOnline}
                color={colors.primary}
              />
            </View>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => loadWallets()} />
      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 16, color: colors.text }}>Send Money</Text>

        {loading && <Text style={{ color: colors.textSecondary }}>Loading wallets...</Text>}

        <Text style={{ marginTop: 12, fontWeight: '600', color: colors.text }}>From wallet</Text>
        {wallets.map(w => (
          <Button
            key={w.id}
            title={w.id}
            onPress={() => setFromWalletId(w.id)}
            color={fromWalletId === w.id ? colors.primary : colors.textSecondary}
          />
        ))}

        <Text style={{ marginTop: 12, fontWeight: '600', color: colors.text }}>To wallet ID</Text>

        {/* Recent Contacts Quick Access */}
        {recentContacts.length > 0 && (
          <View style={{ marginBottom: 12 }}>
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>Recent:</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {recentContacts.map(contact => (
                <TouchableOpacity
                  key={contact.id}
                  style={{
                    backgroundColor: colors.card,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                  onPress={() => handleContactSelect(contact.walletId)}
                >
                  <Text style={{ fontSize: 12, color: colors.text }}>{contact.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Wallet ID Input with QR and Contacts */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <TextInput
            value={toWalletId}
            onChangeText={setToWalletId}
            placeholder="Destination wallet id"
            placeholderTextColor={colors.textSecondary}
            editable={!loading}
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: colors.border,
              padding: 8,
              borderRadius: 4,
              color: colors.text,
              backgroundColor: colors.card,
            }}
          />
          <TouchableOpacity
            style={{
              backgroundColor: colors.primary,
              padding: 10,
              borderRadius: 4,
              minWidth: 44,
              alignItems: 'center',
            }}
            onPress={handleQRScan}
          >
            <Text style={{ fontSize: 18 }}>📸</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{
              backgroundColor: colors.primary,
              padding: 10,
              borderRadius: 4,
              minWidth: 44,
              alignItems: 'center',
            }}
            // @ts-ignore
            onPress={() => navigation.navigate('Contacts')}
          >
            <Text style={{ fontSize: 18 }}>👥</Text>
          </TouchableOpacity>
        </View>

        <Text style={{ fontWeight: '600', color: colors.text }}>Amount</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor={colors.textSecondary}
          keyboardType="numeric"
          editable={!loading}
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            padding: 8,
            marginBottom: 12,
            borderRadius: 4,
            color: colors.text,
            backgroundColor: colors.card,
          }}
        />

        <Text style={{ fontWeight: '600', color: colors.text }}>Currency</Text>
        <TextInput
          value={currency}
          onChangeText={setCurrency}
          placeholderTextColor={colors.textSecondary}
          editable={!loading}
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            padding: 8,
            marginBottom: 12,
            borderRadius: 4,
            color: colors.text,
            backgroundColor: colors.card,
          }}
        />

        <View
          style={{
            backgroundColor: colors.primary + '20',
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
            borderLeftWidth: 4,
            borderLeftColor: colors.primary,
          }}
        >
          <Text style={{ fontSize: 13, color: colors.text }}>
            ℹ️ The receiver will receive this payment in their preferred currency if they have auto-convert enabled,
            or in the original currency ({currency}) if they prefer multi-currency wallets.
          </Text>
        </View>

        <Button
          title="Review & Send"
          onPress={onSend}
          disabled={!amount || !toWalletId || loading || !isOnline}
          color={colors.primary}
        />
      </View>
    </ScrollView>
  );
}

