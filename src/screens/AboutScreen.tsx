import React from 'react';
import { View, Text, ScrollView, Linking, Alert, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <Ionicons name="wallet" size={48} color="#007AFF" />
          </View>
          <Text style={styles.appName}>EGWallet</Text>
          <Text style={styles.tagline}>Multi-currency wallet for Africa</Text>
        </View>

        {/* Version Info */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="information-circle" size={24} color="#007AFF" />
            <Text style={styles.cardTitle}>Release Information</Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons name="code" size={20} color="#657786" />
            <Text style={styles.infoLabel}>Version:</Text>
            <Text style={styles.infoValue}>{appVersion}</Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons name="hammer" size={20} color="#657786" />
            <Text style={styles.infoLabel}>Build:</Text>
            <Text style={styles.infoValue}>{buildNumber}</Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons name="server" size={20} color="#657786" />
            <Text style={styles.infoLabel}>Environment:</Text>
            <Text style={styles.infoValue}>{environment}</Text>
          </View>
          <View style={[styles.infoItem, { borderBottomWidth: 0 }]}>
            <Ionicons name="link" size={20} color="#657786" />
            <Text style={styles.infoLabel}>API:</Text>
            <Text style={[styles.infoValue, { fontSize: 11 }]} numberOfLines={1}>{apiUrl}</Text>
          </View>
        </View>

        {/* Supported Features */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="list" size={24} color="#007AFF" />
            <Text style={styles.cardTitle}>Supported Features</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Multi-currency wallets (32+ currencies)</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Send money between wallets</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Real-time exchange rates</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Transaction history</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Payment requests</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Virtual cards</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Budget tracking</Text>
          </View>
          <View style={[styles.featureItem, { borderBottomWidth: 0 }]}>
            <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            <Text style={styles.featureText}>Payroll system</Text>
          </View>
        </View>

        {/* Limits & Fees */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={24} color="#007AFF" />
            <Text style={styles.cardTitle}>Limits & Fees</Text>
          </View>
          <View style={styles.limitItem}>
            <Ionicons name="time" size={20} color="#657786" />
            <Text style={styles.limitText}>Daily sending limit: $5,000 USD per 24 hours</Text>
          </View>
          <View style={styles.limitItem}>
            <Ionicons name="wallet" size={20} color="#657786" />
            <Text style={styles.limitText}>Wallet capacity: $250,000 USD</Text>
          </View>
          <View style={[styles.limitItem, { borderBottomWidth: 0 }]}>
            <Ionicons name="pricetag" size={20} color="#657786" />
            <Text style={styles.limitText}>Fees: Standard rate applies (check with your bank)</Text>
          </View>
        </View>

        {/* Links */}
        <TouchableOpacity style={styles.linkButton} onPress={handlePrivacyPolicy}>
          <Ionicons name="shield" size={20} color="#007AFF" />
          <Text style={styles.linkText}>Privacy Policy</Text>
          <Ionicons name="open" size={16} color="#007AFF" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkButton} onPress={handleTerms}>
          <Ionicons name="document-text" size={20} color="#007AFF" />
          <Text style={styles.linkText}>Terms of Service</Text>
          <Ionicons name="open" size={16} color="#007AFF" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkButton} onPress={handleSupport}>
          <Ionicons name="mail" size={20} color="#007AFF" />
          <Text style={styles.linkText}>Contact Support</Text>
          <Ionicons name="send" size={16} color="#007AFF" />
        </TouchableOpacity>

        {/* Copyright */}
        <View style={styles.footer}>
          <Text style={styles.copyright}>© 2026 EGWallet. All rights reserved.</Text>
          <Text style={styles.taglineFooter}>Built for Africa, by Africans.</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  content: {
    padding: 16,
  },
  header: {
    alignItems: 'center',
    padding: 24,
    marginBottom: 8,
  },
  logoContainer: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#E8F5FE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  appName: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#007AFF',
    marginBottom: 6,
  },
  tagline: {
    fontSize: 15,
    color: '#657786',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: 16,
    paddingBottom: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
    gap: 10,
  },
  infoLabel: {
    fontSize: 14,
    color: '#657786',
    width: 100,
  },
  infoValue: {
    flex: 1,
    fontSize: 14,
    color: '#14171A',
    fontWeight: '500',
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
    gap: 10,
  },
  featureText: {
    flex: 1,
    fontSize: 14,
    color: '#14171A',
  },
  limitItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
    gap: 10,
  },
  limitText: {
    flex: 1,
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  linkText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#007AFF',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 24,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#EEEEEE',
  },
  copyright: {
    fontSize: 12,
    color: '#999999',
  },
  taglineFooter: {
    fontSize: 12,
    color: '#999999',
    marginTop: 4,
  },
});
