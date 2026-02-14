import React from 'react';
import { View, Text, ScrollView, Button, Linking, Alert } from 'react-native';
import config from '../config/env';

export default function AboutScreen() {
  const appVersion = '1.0.0';
  const buildNumber = '2';
  const environment = __DEV__ ? 'Development' : 'Production';
  const apiUrl = config.API_BASE_URL;

  const handlePrivacyPolicy = async () => {
    const url = 'https://egwallet.com/privacy';
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
    } else {
      Alert.alert('Cannot open link', `Please visit ${url}`);
    }
  };

  const handleTerms = async () => {
    const url = 'https://egwallet.com/terms';
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
    } else {
      Alert.alert('Cannot open link', `Please visit ${url}`);
    }
  };

  const handleSupport = () => {
    const email = 'support@egwallet.com';
    Linking.openURL(`mailto:${email}`);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      <View style={{ padding: 16 }}>
        {/* Header */}
        <Text style={{ fontSize: 28, fontWeight: 'bold', marginBottom: 8, color: '#007AFF' }}>
          EGWallet
        </Text>
        <Text style={{ fontSize: 14, color: '#666', marginBottom: 24 }}>
          Multi-currency wallet for Africa
        </Text>

        {/* Version Info */}
        <View style={{ backgroundColor: '#fff', padding: 16, borderRadius: 8, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#333' }}>
            Release Information
          </Text>
          <View style={{ marginBottom: 8 }}>
            <Text style={{ color: '#666', fontSize: 14 }}>Version: {appVersion}</Text>
          </View>
          <View style={{ marginBottom: 8 }}>
            <Text style={{ color: '#666', fontSize: 14 }}>Build: {buildNumber}</Text>
          </View>
          <View style={{ marginBottom: 8 }}>
            <Text style={{ color: '#666', fontSize: 14 }}>
              Environment: {environment}
            </Text>
          </View>
          <View>
            <Text style={{ color: '#666', fontSize: 12, marginTop: 8 }}>
              API URL: {apiUrl}
            </Text>
          </View>
        </View>

        {/* Supported Features */}
        <View style={{ backgroundColor: '#fff', padding: 16, borderRadius: 8, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#333' }}>
            Supported Features
          </Text>
          <Text style={{ color: '#666', fontSize: 14, marginBottom: 6 }}>
            ✅ Multi-currency wallets (32+ currencies)
          </Text>
          <Text style={{ color: '#666', fontSize: 14, marginBottom: 6 }}>
            ✅ Send money between wallets
          </Text>
          <Text style={{ color: '#666', fontSize: 14, marginBottom: 6 }}>
            ✅ Real-time exchange rates
          </Text>
          <Text style={{ color: '#666', fontSize: 14, marginBottom: 6 }}>
            ✅ Transaction history
          </Text>
          <Text style={{ color: '#b55700', fontSize: 14, marginBottom: 6 }}>
            🔄 Request money (Beta)
          </Text>
          <Text style={{ color: '#b55700', fontSize: 14, marginBottom: 6 }}>
            🔄 Virtual card (Coming Soon)
          </Text>
          <Text style={{ color: '#b55700', fontSize: 14 }}>
            🔄 Budget tracking (Coming Soon)
          </Text>
        </View>

        {/* Limits & Fees */}
        <View style={{ backgroundColor: '#fff', padding: 16, borderRadius: 8, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#333' }}>
            Limits & Fees
          </Text>
          <Text style={{ color: '#666', fontSize: 14, marginBottom: 8 }}>
            • Daily sending limit: $5,000 USD per 24 hours
          </Text>
          <Text style={{ color: '#666', fontSize: 14, marginBottom: 8 }}>
            • Wallet capacity: $250,000 USD
          </Text>
          <Text style={{ color: '#666', fontSize: 14 }}>
            • Fees: Standard rate applies (check with your bank)
          </Text>
        </View>

        {/* Links */}
        <View style={{ marginBottom: 16 }}>
          <Button title="Privacy Policy" onPress={handlePrivacyPolicy} color="#007AFF" />
        </View>

        <View style={{ marginBottom: 16 }}>
          <Button title="Terms of Service" onPress={handleTerms} color="#007AFF" />
        </View>

        <View style={{ marginBottom: 16 }}>
          <Button title="Contact Support" onPress={handleSupport} color="#007AFF" />
        </View>

        {/* Copyright */}
        <View style={{ alignItems: 'center', paddingTop: 16, borderTopWidth: 1, borderTopColor: '#eee' }}>
          <Text style={{ color: '#999', fontSize: 12 }}>
            © 2026 EGWallet. All rights reserved.
          </Text>
          <Text style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
            Built for Africa, by Africans.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
