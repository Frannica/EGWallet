import React, { useState, useEffect } from 'react';
import { View, Text, Button, ScrollView, Alert, TouchableOpacity, Modal, FlatList, Switch } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { useNavigation } from '@react-navigation/native';
import { KYCDisclosure } from '../components/KYCDisclosure';
import { getCurrencySymbol } from '../utils/currency';
import { useTheme } from '../contexts/ThemeContext';
import { setBiometricEnabled, isBiometricAvailable } from '../utils/BiometricAuth';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CURRENCIES = [
  'XAF', 'NGN', 'GHS', 'ZAR', 'KES', 'TZS', 'UGX', 'RWF', 'ETB', 'EGP',
  'TND', 'MAD', 'LYD', 'DZD', 'AOA', 'ERN', 'SOS', 'SDG', 'GMD', 'MUR',
  'SCR', 'BWP', 'ZWL', 'MZN', 'NAD', 'LSL', 'XOF', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'BRL', 'CNY'
];

export default function SettingsScreen() {
  const auth = useAuth();
  const navigation = useNavigation();
  const { colors, theme, toggleTheme } = useTheme();
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const biometricEnabledValue = await AsyncStorage.getItem('biometric_enabled');
    const notificationsEnabledValue = await AsyncStorage.getItem('notifications_enabled');
    
    setBiometricEnabledState(biometricEnabledValue === 'true');
    setNotificationsEnabled(notificationsEnabledValue !== 'false');
    
    const available = await isBiometricAvailable();
    setBiometricAvailable(available);
  };

  const handleToggleBiometric = async (enabled: boolean) => {
    if (enabled && !biometricAvailable) {
      Alert.alert('Not Available', 'Biometric authentication is not available on this device or not set up.');
      return;
    }
    await setBiometricEnabled(enabled);
    setBiometricEnabledState(enabled);
    Alert.alert('Success', `Biometric authentication ${enabled ? 'enabled' : 'disabled'} for transactions`);
  };

  const handleToggleNotifications = async (enabled: boolean) => {
    await AsyncStorage.setItem('notifications_enabled', enabled ? 'true' : 'false');
    setNotificationsEnabled(enabled);
    Alert.alert('Success', `Notifications ${enabled ? 'enabled' : 'disabled'}`);
  };

  const handleSignOut = async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await auth.signOut();
        },
      },
    ]);
  };

  const handleDeleteAccount = async () => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? This action cannot be undone. All your data will be permanently deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Account Deletion',
              'Please contact support at support@egwallet.com to request account deletion. We will verify your identity and process your request within 30 days.'
            );
          },colors.background }}>
      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 16, color: colors.text }}>Settings</Text>

        {/* KYC & Limits Disclosure */}
        <View style={{ marginBottom: 16 }}>
          <KYCDisclosure region="GQ" />
        </View>

        {/* Appearance Section */}
        <View style={{ backgroundColor: colors.card, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, marginBottom: 12 }}>
              APPEARANCE
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                  Dark Mode
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                  {theme === 'dark' ? 'Using dark theme' : 'Using light theme'}
                </Text>
              </View>
              <Switchcolors.primary + '20', 
                  borderRadius: 6,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: colors.primary }}>
                  {auth.user?.preferredCurrency || 'XAF'} {getCurrencySymbol(auth.user?.preferredCurrency || 'XAF')}
                </Text>
                <Text style={{ color: colors.primary }}>Change →</Text>
              </TouchableOpacity>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
                All incoming payments will be automatically converted to this currency
              </Text>
            </View>
            
            {/* Auto-Convert Toggle */}
            <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 4 }}>
                    Auto-Convert Incoming Payments
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 16 }}>
                    {auth.user?.autoConvertIncoming !== false 
                      ? `Automatically convert all incoming payments to ${auth.user?.preferredCurrency || 'XAF'}`
                      : 'Receive payments in original currency (multi-currency wallet)'}
                  </Text>
                </View>
                <Switch
                  value={auth.user?.autoConvertIncoming !== false}
                  onValueChange={handleToggleAutoConvert}
                  trackColor={{ false: '#ccc', true: colors.primary }}
                  thumbColor="#fff"
                />
              </View>
            </View>
          </View>

          <View style={{ padding: 12 }}>
            <Button title="Sign Out" onPress={handleSignOut} color={colors.primary} />
          </View>
        </View>

        {/* Privacy & Security Section */}
        <View style={{ backgroundColor: colors.card, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, marginBottom: 8 }}>
              PRIVACY & SECURITY
            </Text>
          </View>
          <View style={{ padding: 12 }}>
            <Button title="Delete Account" onPress={handleDeleteAccount} color="#d32f2f" />
          </View>
        </View>

        {/* App Info Section */}
        <View style={{ backgroundColor: colors.card, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <View style={{ padding: 16 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, marginBottom: 12 }}>
              APP INFORMATION
            </Text>
          </View>
          <View style={{ padding: 12 }}>
            <Button title="About EGWallet" onPress={handleAbout} color={colors.primary} />
          </View>
        </View>

        {/* Support Info */}
        <View style={{ backgroundColor: colors.card, borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary, marginBottom: 12 }}>
            SUPPORT
          </Text>
          <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>
            For technical support, email us at:{' '}
            <Text style={{ fontWeight: '600', color: colors.primary }}>support@egwallet.com</Text>
          </Text>
        </View>
      </View>

      {/* Currency Picker Modal */}
      <Modal visible={showCurrencyPicker} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%' }}>
            <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text }}>Select Preferred Currency</Text>
              <TouchableOpacity onPress={() => setShowCurrencyPicker(false)}>
                <Text style={{ fontSize: 18, color: colors.primary }}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ padding: 16, paddingBottom: 8, color: colors.textSecondary, fontSize: 13 }}>
              All incoming payments will be automatically converted to your selected currency
            </Text>
            <FlatList
              data={CURRENCIES}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => handleChangeCurrency(item)}
                  style={{ 
                    padding: 16, 
                    borderBottomWidth: 1, 
                    borderBottomColor: colors.border,
                    backgroundColor: auth.user?.preferredCurrency === item ? colors.primary + '20' : colors.card
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 16, fontWeight: auth.user?.preferredCurrency === item ? '600' : '400', color: colors.text }}>
                      {item} {getCurrencySymbol(item)}
                    </Text>
                    {auth.user?.preferredCurrency === item && (
                      <Text style={{ color: colors.primary
          <KYCDisclosure region="GQ" />
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#666', marginBottom: 12 }}>
              ACCOUNT
            </Text>
            <Text style={{ color: '#333', marginBottom: 12 }}>
              Logged in as: {auth.user?.email}
            </Text>
            <View style={{ marginTop: 8 }}>
              <Text style={{ color: '#666', fontSize: 14, marginBottom: 6 }}>
                Preferred Receiving Currency:
              </Text>
              <TouchableOpacity 
                onPress={() => setShowCurrencyPicker(true)}
                style={{ 
                  padding: 12, 
                  backgroundColor: '#f0f7ff', 
                  borderRadius: 6,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#007AFF' }}>
                  {auth.user?.preferredCurrency || 'XAF'} {getCurrencySymbol(auth.user?.preferredCurrency || 'XAF')}
                </Text>
                <Text style={{ color: '#007AFF' }}>Change →</Text>
              </TouchableOpacity>
              <Text style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
                All incoming payments will be automatically converted to this currency
              </Text>
            </View>
            
            {/* Auto-Convert Toggle */}
            <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#eee' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ color: '#666', fontSize: 14, fontWeight: '600', marginBottom: 4 }}>
                    Auto-Convert Incoming Payments
                  </Text>
                  <Text style={{ color: '#999', fontSize: 12, lineHeight: 16 }}>
                    {auth.user?.autoConvertIncoming !== false 
                      ? `Automatically convert all incoming payments to ${auth.user?.preferredCurrency || 'XAF'}`
                      : 'Receive payments in original currency (multi-currency wallet)'}
                  </Text>
                </View>
                <Switch
                  value={auth.user?.autoConvertIncoming !== false}
                  onValueChange={handleToggleAutoConvert}
                  trackColor={{ false: '#ccc', true: '#007AFF' }}
                  thumbColor="#fff"
                />
              </View>
            </View>
          </View>

          <View style={{ padding: 12 }}>
            <Button title="Sign Out" onPress={handleSignOut} color="#007AFF" />
          </View>
        </View>

        {/* Privacy & Security Section */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#666', marginBottom: 8 }}>
              PRIVACY & SECURITY
            </Text>
          </View>
          <View style={{ padding: 12 }}>
            <Button title="Delete Account" onPress={handleDeleteAccount} color="#d32f2f" />
          </View>
        </View>

        {/* App Info Section */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <View style={{ padding: 16 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#666', marginBottom: 12 }}>
              APP INFORMATION
            </Text>
          </View>
          <View style={{ padding: 12 }}>
            <Button title="About EGWallet" onPress={handleAbout} color="#007AFF" />
          </View>
        </View>

        {/* Support Info */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#666', marginBottom: 12 }}>
            SUPPORT
          </Text>
          <Text style={{ color: '#666', fontSize: 14, lineHeight: 20 }}>
            For technical support, email us at:{' '}
            <Text style={{ fontWeight: '600', color: '#007AFF' }}>support@egwallet.com</Text>
          </Text>
        </View>
      </View>

      {/* Currency Picker Modal */}
      <Modal visible={showCurrencyPicker} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%' }}>
            <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 18, fontWeight: '600' }}>Select Preferred Currency</Text>
              <TouchableOpacity onPress={() => setShowCurrencyPicker(false)}>
                <Text style={{ fontSize: 18, color: '#007AFF' }}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ padding: 16, paddingBottom: 8, color: '#666', fontSize: 13 }}>
              All incoming payments will be automatically converted to your selected currency
            </Text>
            <FlatList
              data={CURRENCIES}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => handleChangeCurrency(item)}
                  style={{ 
                    padding: 16, 
                    borderBottomWidth: 1, 
                    borderBottomColor: '#f0f0f0',
                    backgroundColor: auth.user?.preferredCurrency === item ? '#f0f7ff' : '#fff'
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 16, fontWeight: auth.user?.preferredCurrency === item ? '600' : '400' }}>
                      {item} {getCurrencySymbol(item)}
                    </Text>
                    {auth.user?.preferredCurrency === item && (
                      <Text style={{ color: '#007AFF', fontSize: 18 }}>✓</Text>
                    )}
                  </View>
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
