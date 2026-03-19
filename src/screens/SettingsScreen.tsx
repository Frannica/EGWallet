import React, { useState, useEffect } from 'react';
import { View, Text, Button, ScrollView, Alert, TouchableOpacity, Modal, FlatList, Switch, StyleSheet, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { useBiometric } from '../auth/BiometricContext';
import { useNavigation } from '@react-navigation/native';
import { KYCDisclosure } from '../components/KYCDisclosure';
import { getCurrencySymbol } from '../utils/currency';

const CURRENCIES = [
  'XAF', 'NGN', 'GHS', 'ZAR', 'KES', 'TZS', 'UGX', 'RWF', 'ETB', 'EGP',
  'TND', 'MAD', 'LYD', 'DZD', 'AOA', 'ERN', 'SOS', 'SDG', 'GMD', 'MUR',
  'SCR', 'BWP', 'ZWL', 'MZN', 'NAD', 'LSL', 'XOF', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'BRL', 'CAD'
];

export default function SettingsScreen() {
  const auth = useAuth();
  const biometric = useBiometric();
  const navigation = useNavigation();
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [username, setUsername] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [appLock, setAppLock] = useState(false);
  const [faceId, setFaceId] = useState(false);
  const [trustedDevice, setTrustedDevice] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('@egwallet:username').then(v => { if (v) setUsername(v); });
  }, []);

  const saveUsername = async () => {
    const clean = usernameInput.trim();
    console.log('[Settings] Save Username pressed:', clean);
    if (!clean) return;
    await AsyncStorage.setItem('@egwallet:username', clean);
    setUsername(clean);
    setShowUsernameModal(false);
    Alert.alert('Username Set', `Your handle is now @${clean}. Others can send you money using @${clean}.`);
  };

  const handleSignOut = async () => {
    console.log('[Settings] Sign Out pressed');
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
    console.log('[Settings] Delete Account pressed');
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
          },
        },
      ]
    );
  };

  const handleAbout = () => {
    // @ts-ignore
    navigation.navigate('About');
  };

  const handleChangeCurrency = async (currency: string) => {
    console.log('[Settings] Preferred currency changed to:', currency);
    try {
      await auth.updatePreferredCurrency(currency);
      setShowCurrencyPicker(false);
      Alert.alert('Success', `Your preferred receiving currency is now ${currency}. All incoming payments will be automatically converted to ${currency}.`);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to update currency');
    }
  };

  const handleToggleAutoConvert = async (enabled: boolean) => {
    console.log('[Settings] Auto-convert toggled:', enabled);
    try {
      await auth.updateAutoConvert(enabled);
      if (enabled) {
        Alert.alert('Auto-Convert Enabled', `All incoming payments will now be automatically converted to ${auth.user?.preferredCurrency || 'XAF'}.`);
      } else {
        Alert.alert('Auto-Convert Disabled', 'You will now receive payments in the original currency sent. Your wallet can hold multiple currencies.');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to update setting');
    }
  };

  const handleToggleBiometric = async (enabled: boolean) => {
    console.log('[Settings] Biometric lock toggled:', enabled);
    try {
      if (enabled) {
        await biometric.enableBiometric();
        Alert.alert('Biometric Lock Enabled', 'Your wallet will now be locked when you leave the app.');
      } else {
        await biometric.disableBiometric();
        Alert.alert('Biometric Lock Disabled', 'Your wallet will no longer require biometric authentication.');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to update biometric settings');
    }
  };

  return (
    <LinearGradient colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']} style={{ flex: 1 }}>
    <ScrollView style={styles.container}>
      <View style={styles.content}>

        {/* KYC & Limits Disclosure */}
        <View style={styles.section}>
          <KYCDisclosure region="GQ" />
        </View>
        
        {/* Account Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="person-circle" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>ACCOUNT</Text>
          </View>
          <View style={styles.cardContent}>
            <View style={styles.infoRow}>
              <Ionicons name="mail" size={20} color="#657786" />
              <Text style={styles.emailText}>{auth.user?.email}</Text>
            </View>
            <TouchableOpacity
              style={styles.usernameRow}
              onPress={() => { setUsernameInput(username); setShowUsernameModal(true); }}
              activeOpacity={0.7}
            >
              <Ionicons name="at-circle-outline" size={20} color="#1565C0" />
              <View style={{ flex: 1 }}>
                <Text style={styles.usernameLabel}>Username</Text>
                <Text style={styles.usernameValue}>{username ? `@${username}` : 'Tap to set your @handle'}</Text>
              </View>
              <Ionicons name="create-outline" size={16} color="#9BAEC8" />
            </TouchableOpacity>
            <View style={styles.currencySection}>
              <Text style={styles.label}>Preferred Receiving Currency:</Text>
              <TouchableOpacity 
                onPress={() => setShowCurrencyPicker(true)}
                style={styles.currencyButton}
              >
                <View style={styles.currencyDisplay}>
                  <Ionicons name="cash" size={20} color="#007AFF" />
                  <Text style={styles.currencyText}>
                    {auth.user?.preferredCurrency || 'XAF'} {getCurrencySymbol(auth.user?.preferredCurrency || 'XAF')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#007AFF" />
              </TouchableOpacity>
              <Text style={styles.helpText}>
                All incoming payments will be automatically converted to this currency
              </Text>
            </View>
            
            {/* Auto-Convert Toggle */}
            <View style={styles.toggleSection}>
              <View style={styles.toggleRow}>
                <View style={styles.toggleContent}>
                  <View style={styles.toggleHeader}>
                    <Ionicons name="swap-horizontal" size={20} color="#007AFF" />
                    <Text style={styles.toggleTitle}>Auto-Convert Incoming Payments</Text>
                  </View>
                  <Text style={styles.toggleDescription}>
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

          <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
            <Ionicons name="log-out" size={20} color="#007AFF" />
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        {/* Identity Verification Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={24} color="#34C759" />
            <Text style={styles.sectionTitle}>IDENTITY VERIFICATION</Text>
          </View>
          
          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('KYCVerification')}
          >
            <Ionicons name="document-text" size={20} color="#007AFF" />
            <View style={styles.settingTextContainer}>
              <Text style={styles.supportButtonText}>Verify Your Identity</Text>
              <Text style={styles.settingSubtitle}>Unlock higher limits and premium features</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* Privacy & Security Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={24} color="#d32f2f" />
            <Text style={[styles.sectionTitle, { color: '#d32f2f' }]}>PRIVACY & SECURITY</Text>
          </View>
          
          {biometric.biometricAvailable && (
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <Ionicons 
                  name={biometric.biometricType === 'face' ? 'scan' : 'finger-print'} 
                  size={20} 
                  color="#007AFF" 
                />
                <View style={styles.settingTextContainer}>
                  <Text style={styles.settingTitle}>
                    {biometric.biometricType === 'face' ? 'Face' : 'Fingerprint'} Lock
                  </Text>
                  <Text style={styles.settingSubtitle}>
                    Require {biometric.biometricType === 'face' ? 'face recognition' : 'fingerprint'} to unlock app
                  </Text>
                </View>
              </View>
              <Switch
                value={biometric.biometricEnabled}
                onValueChange={handleToggleBiometric}
                trackColor={{ false: '#E1E8ED', true: '#007AFF' }}
                thumbColor="#FFFFFF"
              />
            </View>
          )}
          
          <View style={styles.divider} />
          
          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('TrustedDevices')}
          >
            <Ionicons name="shield" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>Trusted Devices</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />
          
          <TouchableOpacity style={styles.deleteButton} onPress={handleDeleteAccount}>
            <Ionicons name="trash" size={20} color="#d32f2f" />
            <Text style={styles.deleteText}>Delete Account</Text>
          </TouchableOpacity>
        </View>

        {/* Security Mode */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="lock-closed" size={24} color="#1565C0" />
            <Text style={styles.sectionTitle}>SECURITY MODE</Text>
          </View>
          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons name="lock-closed" size={20} color="#1565C0" />
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>App Lock</Text>
                <Text style={styles.settingSubtitle}>Require authentication to open app</Text>
              </View>
            </View>
            <Switch value={appLock} onValueChange={setAppLock} trackColor={{ false: '#E1E8ED', true: '#007AFF' }} thumbColor="#FFFFFF" />
          </View>
          <View style={styles.divider} />
          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons name="scan" size={20} color="#1565C0" />
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>Face ID / Biometric</Text>
                <Text style={styles.settingSubtitle}>Unlock with face or fingerprint</Text>
              </View>
            </View>
            <Switch
              value={faceId}
              onValueChange={(v) => { setFaceId(v); if (v) setAppLock(true); }}
              trackColor={{ false: '#E1E8ED', true: '#007AFF' }}
              thumbColor="#FFFFFF"
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons name="shield-checkmark" size={20} color="#1565C0" />
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>Remember This Device</Text>
                <Text style={styles.settingSubtitle}>Skip auth on trusted devices</Text>
              </View>
            </View>
            <Switch value={trustedDevice} onValueChange={setTrustedDevice} trackColor={{ false: '#E1E8ED', true: '#007AFF' }} thumbColor="#FFFFFF" />
          </View>
        </View>

        {/* Business Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="business" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>BUSINESS</Text>
          </View>
          <TouchableOpacity
            style={styles.supportButton}
            onPress={() => (navigation as any).navigate('EmployerDashboard')}
          >
            <Ionicons name="people" size={20} color="#007AFF" />
            <View style={styles.settingTextContainer}>
              <Text style={styles.supportButtonText}>Employer Dashboard</Text>
              <Text style={styles.settingSubtitle}>Payroll, employees &amp; bulk payments</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* App Info Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="information-circle" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>APP INFORMATION</Text>
          </View>
          <TouchableOpacity style={styles.aboutButton} onPress={handleAbout}>
            <Ionicons name="help-circle" size={20} color="#007AFF" />
            <Text style={styles.aboutText}>About EGWallet</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* Support Info */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="headset" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>SUPPORT</Text>
          </View>
          
          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('AIChat')}
          >
            <Ionicons name="sparkles" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>AI Assistant (Chat)</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('HelpCenter')}
          >
            <Ionicons name="help-circle" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>Help Center & FAQs</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('ReportProblem')}
          >
            <Ionicons name="bug" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>Report a Problem</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <View style={styles.supportContent}>
            <Ionicons name="mail" size={20} color="#657786" />
            <Text style={styles.supportText}>
              Email: <Text style={styles.supportEmail}>support@egwallet.com</Text>
            </Text>
          </View>
        </View>
      </View>

      {/* Username Modal */}
      <Modal visible={showUsernameModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.usernameModal}>
            <Text style={styles.usernameModalTitle}>Set Username</Text>
            <Text style={styles.usernameModalSub}>Others can send you money using @{usernameInput || 'yourhandle'}</Text>
            <View style={styles.usernameInputRow}>
              <Text style={styles.atSign}>@</Text>
              <TextInput
                style={styles.usernameInput}
                value={usernameInput}
                onChangeText={t => setUsernameInput(t.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                placeholder="yourhandle"
                autoCapitalize="none"
                maxLength={20}
                placeholderTextColor="#9BAEC8"
                autoFocus
              />
            </View>
            <View style={styles.usernameModalBtns}>
              <TouchableOpacity style={styles.umCancelBtn} onPress={() => setShowUsernameModal(false)}>
                <Text style={styles.umCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.umSaveBtn} onPress={saveUsername}>
                <Text style={styles.umSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Currency Picker Modal */}
      <Modal visible={showCurrencyPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Preferred Currency</Text>
              <TouchableOpacity onPress={() => setShowCurrencyPicker(false)}>
                <Ionicons name="close" size={28} color="#007AFF" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalDescription}>
              All incoming payments will be automatically converted to your selected currency
            </Text>
            <FlatList
              data={CURRENCIES}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => handleChangeCurrency(item)}
                  style={[
                    styles.currencyOption,
                    auth.user?.preferredCurrency === item && styles.currencyOptionSelected
                  ]}
                >
                  <View style={styles.currencyOptionContent}>
                    <Ionicons name="cash" size={20} color={auth.user?.preferredCurrency === item ? '#007AFF' : '#657786'} />
                    <Text style={[
                      styles.currencyOptionText,
                      auth.user?.preferredCurrency === item && styles.currencyOptionTextSelected
                    ]}>
                      {item} {getCurrencySymbol(item)}
                    </Text>
                  </View>
                  {auth.user?.preferredCurrency === item && (
                    <Ionicons name="checkmark" size={24} color="#007AFF" />
                  )}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: 16,
  },
  section: {
    marginBottom: 16,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.84)',
    borderRadius: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 5,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.1)',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0A3D7C',
    letterSpacing: 1.2,
  },
  cardContent: {
    padding: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 10,
  },
  emailText: {
    fontSize: 15,
    color: '#14171A',
  },
  currencySection: {
    marginTop: 8,
  },
  label: {
    fontSize: 14,
    color: '#657786',
    marginBottom: 8,
  },
  currencyButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: 'rgba(21,101,192,0.07)',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(21,101,192,0.3)',
  },
  currencyDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  currencyText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1565C0',
  },
  helpText: {
    fontSize: 12,
    color: '#999999',
    marginTop: 6,
    lineHeight: 16,
  },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(21,101,192,0.1)',
    marginTop: 4,
  },
  usernameLabel: {
    fontSize: 11,
    color: '#9BAEC8',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  usernameValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1565C0',
    marginTop: 1,
  },
  usernameModal: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '88%',
    alignSelf: 'center',
  },
  usernameModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0D1B2E',
    marginBottom: 6,
  },
  usernameModalSub: {
    fontSize: 13,
    color: '#657786',
    marginBottom: 20,
  },
  usernameInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#1565C0',
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 20,
  },
  atSign: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1565C0',
    marginRight: 6,
  },
  usernameInput: {
    flex: 1,
    fontSize: 16,
    color: '#0D1B2E',
    paddingVertical: 12,
  },
  usernameModalBtns: {
    flexDirection: 'row',
    gap: 12,
  },
  umCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#F0F4F9',
    alignItems: 'center',
  },
  umCancelText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#657786',
  },
  umSaveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#1565C0',
    alignItems: 'center',
  },
  umSaveText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  toggleSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#EEEEEE',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggleContent: {
    flex: 1,
    marginRight: 12,
  },
  toggleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#14171A',
  },
  toggleDescription: {
    fontSize: 13,
    color: '#657786',
    lineHeight: 18,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    margin: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(21,101,192,0.08)',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.2)',
  },
  signOutText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1565C0',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    margin: 12,
    borderRadius: 8,
    backgroundColor: '#FFEBEE',
    gap: 8,
  },
  deleteText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#d32f2f',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: '#F0F7FF',
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  settingTextContainer: {
    flex: 1,
  },
  settingTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
    marginBottom: 4,
  },
  settingSubtitle: {
    fontSize: 13,
    color: '#657786',
  },
  aboutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    margin: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(21,101,192,0.06)',
    gap: 8,
  },
  aboutText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1565C0',
  },
  supportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginHorizontal: 12,
    gap: 10,
  },
  supportButtonText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
  },
  supportContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    gap: 10,
  },
  supportText: {
    flex: 1,
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
  },
  supportEmail: {
    fontWeight: '700',
    color: '#1565C0',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#14171A',
  },
  modalDescription: {
    padding: 16,
    paddingBottom: 8,
    fontSize: 13,
    color: '#657786',
    lineHeight: 18,
  },
  currencyOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
    backgroundColor: '#FFFFFF',
  },
  currencyOptionSelected: {
    backgroundColor: 'rgba(21,101,192,0.08)',
  },
  currencyOptionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  currencyOptionText: {
    fontSize: 16,
    color: '#14171A',
  },
  currencyOptionTextSelected: {
    fontWeight: '700',
    color: '#1565C0',
  },
  divider: {
    height: 1,
    backgroundColor: '#E1E8ED',
    marginHorizontal: 16,
  },
});
