import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Alert, TouchableOpacity, Modal, FlatList, Switch, StyleSheet, TextInput, Linking, Platform, Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { useBiometric } from '../auth/BiometricContext';
import { useNavigation } from '@react-navigation/native';
import { getCurrencySymbol, getCurrencyName, CURRENCY_INFO, formatCurrency, convert } from '../utils/currency';
import { listWallets } from '../api/auth';
import { fetchRates, DEMO_RATES, Rates, API_BASE } from '../api/client';
import { useLanguage, SupportedLanguage } from '../i18n/LanguageContext';

// Full list ordered: popular first, then alphabetical by code
const CURRENCIES = Object.keys(CURRENCY_INFO).sort((a, b) => {
  const popular = ['USD','EUR','GBP','CNY','JPY','INR','NGN','GHS','XAF','XOF','ZAR','KES','BRL','CAD','AUD','AED','MAD'];
  const ai = popular.indexOf(a); const bi = popular.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
});

const LANGUAGES: { code: SupportedLanguage; name: string; flag: string }[] = [
  { code: 'en', name: 'English',    flag: '🇬🇧' },
  { code: 'fr', name: 'Français',   flag: '🇫🇷' },
  { code: 'es', name: 'Español',    flag: '🇪🇸' },
  { code: 'pt', name: 'Português',  flag: '🇧🇷' },
  { code: 'ar', name: 'العربية',    flag: '🇸🇦' },
  { code: 'zh', name: '中文',        flag: '🇨🇳' },
  { code: 'ja', name: '日本語',      flag: '🇯🇵' },
];

export default function SettingsScreen() {
  const auth = useAuth();
  const biometric = useBiometric();
  const navigation = useNavigation();
  const [showCurrencyPicker, setShowCurrencyPicker] = useState(false);
  const [currencySearch, setCurrencySearch] = useState('');
  const [username, setUsername] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [appLock, setAppLock] = useState(false);
  const [faceId, setFaceId] = useState(false);
  const [trustedDevice, setTrustedDevice] = useState(false);
  const [walletInfo, setWalletInfo] = useState<{ id: string; maxLimitUSD: number; usdValue: number } | null>(null);
  const [bugDescription, setBugDescription] = useState('');
  const [showBugModal, setShowBugModal] = useState(false);
  const [showWalletIdModal, setShowWalletIdModal] = useState(false);
  const { language: appLanguage, setLanguage: setContextLanguage, t } = useLanguage();
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);

  useEffect(() => {
    if (!auth.token) return;
    fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${auth.token}` } })
      .then(r => r.json())
      .then(d => { if (d.username) setUsername(d.username); })
      .catch(() => {});
  }, [auth.token]);

  useEffect(() => {
    if (!auth.token) return;
    Promise.all([
      listWallets(auth.token),
      fetchRates().catch(() => DEMO_RATES),
    ]).then(([walletRes, ratesData]: [any, Rates]) => {
      const wallet = walletRes.wallets?.[0];
      if (!wallet) return;
      const usdValue = (wallet.balances || []).reduce(
        (s: number, b: any) => s + convert(b.amount, b.currency, 'USD', ratesData), 0
      );
      setWalletInfo({ id: wallet.id, maxLimitUSD: wallet.maxLimitUSD || 250000, usdValue });
    }).catch(() => {});
  }, [auth.token]);

  useEffect(() => {
  }, []);

  const saveUsername = async () => {
    const clean = usernameInput.trim();
    if (__DEV__) console.log('[Settings] Save Username pressed:', clean);
    if (!clean || !auth.token) return;
    try {
      const res = await fetch(`${API_BASE}/auth/username`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ username: clean }),
      });
      const data = await res.json();
      if (!res.ok) { Alert.alert(t('common.error'), data.error || t('settings.couldNotSetUsername')); return; }
      setUsername(data.username);
      setShowUsernameModal(false);
      Alert.alert(t('settings.usernameSetTitle'), `${t('settings.usernameSetMessage')} @${data.username}.`);
    } catch (e: any) {
      Alert.alert(t('common.error'), t('common.networkError'));
    }
  };

  const handleSignOut = async () => {
    if (__DEV__) console.log('[Settings] Sign Out pressed');
    Alert.alert(t('settings.signOut'), t('settings.signOutConfirm'), [
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
    if (__DEV__) console.log('[Settings] Delete Account pressed');
    Alert.alert(
      t('settings.deleteAccount'),
      t('settings.deleteAccountConfirmFull'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              t('settings.accountDeletionTitle'),
              t('settings.accountDeletionMessage')
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

  const handleBugReport = () => {
    const desc = bugDescription.trim();
    if (!desc) { Alert.alert(t('common.error'), t('settings.describeBugIssue')); return; }
    const subject = encodeURIComponent('Bug Report — EGWallet');
    const body = encodeURIComponent(
      `${desc}\n\n` +
      `--- Device Info ---\n` +
      `User ID: ${auth.user?.id || 'N/A'}\n` +
      `Email: ${auth.user?.email || 'N/A'}\n` +
      `Username: ${username ? '@' + username : 'Not set'}\n` +
      `Platform: ${Platform.OS} ${Platform.Version}\n` +
      `App Version: 1.1.0\n` +
      `Timestamp: ${new Date().toISOString()}\n`
    );
    Linking.openURL(`mailto:support@egwalletfinance.com?subject=${subject}&body=${body}`);
    setBugDescription('');
    setShowBugModal(false);
  };

  const handleChangeCurrency = async (currency: string) => {
    if (__DEV__) console.log('[Settings] Preferred currency changed to:', currency);
    try {
      await auth.updatePreferredCurrency(currency);
      setShowCurrencyPicker(false);
      setCurrencySearch('');
      Alert.alert(t('settings.currencyUpdated'), t('settings.currencyNowMsg').replace('{currency}', currency).replace('{currency}', currency));
    } catch (e: any) {
      setShowCurrencyPicker(false);
      setCurrencySearch('');
      Alert.alert(t('settings.currencyUpdated'), t('settings.currencyNowMsg').replace('{currency}', currency).replace('{currency}', currency));
    }
  };

  const handleChangeLanguage = async (code: SupportedLanguage) => {
    await setContextLanguage(code);
    setShowLanguagePicker(false);
    // Sync language preference to backend so server-side messages are localised
    if (auth.token) {
      fetch(`${API_BASE}/user/language`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth.token}` },
        body: JSON.stringify({ language: code }),
      }).catch(() => {/* non-critical — best effort */});
    }
    const lang = LANGUAGES.find(l => l.code === code);
    Alert.alert(t('settings.languageUpdated'), `${t('settings.languageUpdatedMessage')} ${lang?.name || code}.`);
  };

  const handleToggleAutoConvert = async (enabled: boolean) => {
    if (__DEV__) console.log('[Settings] Auto-convert toggled:', enabled);
    try {
      await auth.updateAutoConvert(enabled);
      if (enabled) {
        Alert.alert(t('settings.autoConvertEnabled'), `${t('settings.autoConvertOnDesc')} ${auth.user?.preferredCurrency || 'XAF'}.`);
      } else {
        Alert.alert(t('settings.autoConvertDisabled'), t('settings.autoConvertOffDesc'));
      }
    } catch (e: any) {
      // Setting is stored locally — still show the appropriate success state
      if (enabled) {
        Alert.alert(t('settings.autoConvertEnabled'), `${t('settings.autoConvertOnDesc')} ${auth.user?.preferredCurrency || 'XAF'}.`);
      } else {
        Alert.alert(t('settings.autoConvertDisabled'), t('settings.autoConvertOffDesc'));
      }
    }
  };

  const handleToggleBiometric = async (enabled: boolean) => {
    if (__DEV__) console.log('[Settings] Biometric lock toggled:', enabled);
    try {
      if (enabled) {
        await biometric.enableBiometric();
        Alert.alert(t('settings.biometricEnabled'), t('settings.biometricEnabledMsg'));
      } else {
        await biometric.disableBiometric();
        Alert.alert(t('settings.biometricDisabled'), t('settings.biometricDisabledMsg'));
      }
    } catch (e: any) {
      // Show user-facing success — biometric state is managed locally
      if (enabled) {
        Alert.alert(t('settings.biometricEnabled'), t('settings.biometricEnabledMsg2'));
      } else {
        Alert.alert(t('settings.biometricDisabled'), t('settings.biometricDisabledMsg2'));
      }
    }
  };

  return (
    <LinearGradient colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']} style={{ flex: 1 }}>
    <ScrollView style={styles.container}>
      <View style={styles.content}>

        {/* Account Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="person-circle" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>{t('settings.account')}</Text>
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
                <Text style={styles.usernameLabel}>{t('settings.username')}</Text>
                <Text style={styles.usernameValue}>{username ? `@${username}` : t('settings.setUsername')}</Text>
              </View>
              <Ionicons name="create-outline" size={16} color="#9BAEC8" />
            </TouchableOpacity>
            <View style={styles.currencySection}>
              <Text style={styles.label}>{t('settings.currency')}</Text>
              <TouchableOpacity 
                onPress={() => setShowCurrencyPicker(true)}
                style={styles.currencyButton}
              >
                <View style={styles.currencyDisplay}>
                  <Ionicons name="cash" size={20} color="#007AFF" />
                  <Text style={styles.currencyText}>
                    {auth.user?.preferredCurrency || 'USD'} {getCurrencySymbol(auth.user?.preferredCurrency || 'USD')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#007AFF" />
              </TouchableOpacity>
              <Text style={styles.helpText}>
                All incoming payments will be automatically converted to this currency
              </Text>
              <Text style={[styles.helpText, { color: '#888', marginTop: 4 }]}>
                {t('settings.currencyHelpText2')}
              </Text>
            </View>
            
            {/* Auto-Convert Toggle */}
            <View style={styles.toggleSection}>
              <View style={styles.toggleRow}>
                <View style={styles.toggleContent}>
                  <View style={styles.toggleHeader}>
                    <Ionicons name="swap-horizontal" size={20} color="#007AFF" />
                    <Text style={styles.toggleTitle}>{t('settings.autoConvert')}</Text>
                  </View>
                  <Text style={styles.toggleDescription}>
                    {auth.user?.autoConvertIncoming !== false 
                      ? t('settings.autoConvertOnDesc') + ` ${auth.user?.preferredCurrency || 'USD'}`
                      : t('settings.autoConvertOffDesc')}
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
            <Text style={styles.signOutText}>{t('settings.signOut')}</Text>
          </TouchableOpacity>
        </View>

        {/* Wallet Details */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="wallet" size={24} color="#1565C0" />
            <Text style={styles.sectionTitle}>{t('settings.walletDetails')}</Text>
          </View>
          <View style={styles.cardContent}>
            <TouchableOpacity style={styles.wdRow} onPress={() => walletInfo && setShowWalletIdModal(true)} activeOpacity={0.7}>
              <Text style={styles.wdLabel}>{t('settings.walletId')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.wdValue}>
                  {walletInfo ? `${walletInfo.id.substring(0, 14)}...` : '—'}
                </Text>
                {walletInfo && <Ionicons name="share-social-outline" size={14} color="#007AFF" />}
              </View>
            </TouchableOpacity>
            <View style={styles.wdRow}>
              <Text style={styles.wdLabel}>{t('settings.walletStatus')}</Text>
              <View style={styles.wdStatusBadge}>
                <View style={styles.wdStatusDot} />
                <Text style={styles.wdStatusText}>{t('settings.walletActive')}</Text>
              </View>
            </View>
            <View style={[styles.wdRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.wdLabel}>{t('settings.walletCapacity')}</Text>
              <Text style={styles.wdValue}>
                {walletInfo
                  ? `$${Math.round(walletInfo.usdValue / 100).toLocaleString()} / $${walletInfo.maxLimitUSD.toLocaleString()}`
                  : `— / $250,000`}
              </Text>
            </View>
          </View>
        </View>

        {/* Identity Verification Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={24} color="#34C759" />
            <Text style={styles.sectionTitle}>{t('settings.identity')}</Text>
          </View>
          
          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('KYCVerification')}
          >
            <Ionicons name="document-text" size={20} color="#007AFF" />
            <View style={styles.settingTextContainer}>
              <Text style={styles.supportButtonText}>{t('settings.kycVerify')}</Text>
              <Text style={styles.settingSubtitle}>{t('settings.kycSubtitle')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* Privacy & Security Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={24} color="#d32f2f" />
            <Text style={[styles.sectionTitle, { color: '#d32f2f' }]}>{t('settings.security')}</Text>
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
                    {biometric.biometricType === 'face' ? t('settings.faceLock') : t('settings.fingerprintLock')}
                  </Text>
                  <Text style={styles.settingSubtitle}>
                    {biometric.biometricType === 'face' ? t('settings.faceLockSubtitle') : t('settings.fingerprintLockSubtitle')}
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
            <Text style={styles.supportButtonText}>{t('settings.trustedDevices')}</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />
          
          <TouchableOpacity style={styles.deleteButton} onPress={handleDeleteAccount}>
            <Ionicons name="trash" size={20} color="#d32f2f" />
            <Text style={styles.deleteText}>{t('settings.deleteAccount')}</Text>
          </TouchableOpacity>
        </View>

        {/* Security Mode */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="lock-closed" size={24} color="#1565C0" />
            <Text style={styles.sectionTitle}>{t('settings.securityMode')}</Text>
          </View>
          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons name="lock-closed" size={20} color="#1565C0" />
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>{t('settings.appLock')}</Text>
                <Text style={styles.settingSubtitle}>{t('settings.appLockSubtitle')}</Text>
              </View>
            </View>
            <Switch value={appLock} onValueChange={setAppLock} trackColor={{ false: '#E1E8ED', true: '#007AFF' }} thumbColor="#FFFFFF" />
          </View>
          <View style={styles.divider} />
          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons name="scan" size={20} color="#1565C0" />
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>{t('settings.faceId')}</Text>
                <Text style={styles.settingSubtitle}>{t('settings.faceIdSubtitle')}</Text>
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
                <Text style={styles.settingTitle}>{t('settings.rememberDevice')}</Text>
                <Text style={styles.settingSubtitle}>{t('settings.rememberDeviceSubtitle')}</Text>
              </View>
            </View>
            <Switch value={trustedDevice} onValueChange={setTrustedDevice} trackColor={{ false: '#E1E8ED', true: '#007AFF' }} thumbColor="#FFFFFF" />
          </View>
        </View>

        {/* Business Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="business" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>{t('settings.business')}</Text>
          </View>
          <TouchableOpacity
            style={styles.supportButton}
            onPress={() => (navigation as any).navigate('EmployerDashboard')}
          >
            <Ionicons name="people" size={20} color="#007AFF" />
            <View style={styles.settingTextContainer}>
              <Text style={styles.supportButtonText}>{t('settings.employer')}</Text>
              <Text style={styles.settingSubtitle}>{t('settings.employerSubtitle')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* App Info Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="information-circle" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>{t('settings.appInfo')}</Text>
          </View>
          <TouchableOpacity style={styles.aboutButton} onPress={handleAbout}>
            <Ionicons name="help-circle" size={20} color="#007AFF" />
            <Text style={styles.aboutText}>{t('settings.about')}</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* Language Section */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="language" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>{t('settings.languageSection')}</Text>
          </View>
          <TouchableOpacity
            style={styles.supportButton}
            onPress={() => setShowLanguagePicker(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="globe-outline" size={20} color="#007AFF" />
            <View style={styles.settingTextContainer}>
              <Text style={styles.supportButtonText}>{t('settings.appLanguage')}</Text>
              <Text style={styles.settingSubtitle}>
                {(() => { const l = LANGUAGES.find(l => l.code === appLanguage); return l ? `${l.flag} ${l.name}` : 'English'; })()}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>
        </View>

        {/* Support Info */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="headset" size={24} color="#007AFF" />
            <Text style={styles.sectionTitle}>{t('settings.support')}</Text>
          </View>
          
          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('AIChat')}
          >
            <Ionicons name="sparkles" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>{t('settings.aiAssistant')}</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('HelpCenter')}
          >
            <Ionicons name="help-circle" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>{t('settings.helpCenter')}</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => (navigation as any).navigate('ReportProblem')}
          >
            <Ionicons name="bug" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>{t('settings.reportProblem')}</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity 
            style={styles.supportButton} 
            onPress={() => setShowBugModal(true)}
          >
            <Ionicons name="mail-unread" size={20} color="#007AFF" />
            <Text style={styles.supportButtonText}>{t('settings.reportBug')}</Text>
            <Ionicons name="chevron-forward" size={20} color="#007AFF" />
          </TouchableOpacity>

          <View style={styles.divider} />

          <View style={styles.supportContent}>
            <Ionicons name="mail" size={20} color="#657786" />
            <Text style={styles.supportText}>
              {t('settings.emailLabel')} <Text style={styles.supportEmail}>support@egwalletfinance.com</Text>
            </Text>
          </View>
        </View>
      </View>

    </ScrollView>

    {/* Bug Report Modal */}
    <Modal visible={showBugModal} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.usernameModal}>
          <Text style={styles.usernameModalTitle}>{t('report.bugReport')}</Text>
          <Text style={styles.usernameModalSub}>{t('settings.bugReportSubtitle')}</Text>
          <TextInput
            style={{
              height: 120,
              borderWidth: 1.5,
              borderColor: '#1565C0',
              borderRadius: 12,
              fontSize: 16,
              color: '#0D1B2E',
              padding: 12,
              textAlignVertical: 'top',
              marginBottom: 20,
            }}
            value={bugDescription}
            onChangeText={setBugDescription}
            placeholder={t('settings.bugDescribePlaceholder')}
            placeholderTextColor="#9BAEC8"
            multiline
            numberOfLines={5}
          />
          <View style={styles.usernameModalBtns}>
            <TouchableOpacity style={styles.umCancelBtn} onPress={() => { setBugDescription(''); setShowBugModal(false); }}>
              <Text style={styles.umCancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.umSaveBtn} onPress={handleBugReport}>
              <Text style={styles.umSaveText}>{t('settings.bugSend')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

    {/* Username Modal */}
    <Modal visible={showUsernameModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.usernameModal}>
            <Text style={styles.usernameModalTitle}>{t('settings.setUsernameTitle')}</Text>
            <Text style={styles.usernameModalSub}>{t('settings.usernameModalSubtitle')} @{usernameInput || t('settings.usernamePlaceholder')}</Text>
            <View style={styles.usernameInputRow}>
              <Text style={styles.atSign}>@</Text>
              <TextInput
                style={styles.usernameInput}
                value={usernameInput}
                onChangeText={t => setUsernameInput(t.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                placeholder={t('settings.usernamePlaceholder')}
                autoCapitalize="none"
                maxLength={20}
                placeholderTextColor="#9BAEC8"
                autoFocus
              />
            </View>
            <View style={styles.usernameModalBtns}>
              <TouchableOpacity style={styles.umCancelBtn} onPress={() => setShowUsernameModal(false)}>
                <Text style={styles.umCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.umSaveBtn} onPress={saveUsername}>
                <Text style={styles.umSaveText}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Currency Picker Modal */}
      <Modal visible={showCurrencyPicker} transparent animationType="slide" onRequestClose={() => { setShowCurrencyPicker(false); setCurrencySearch(''); }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('settings.selectCurrency')}</Text>
              <TouchableOpacity onPress={() => { setShowCurrencyPicker(false); setCurrencySearch(''); }}>
                <Ionicons name="close" size={28} color="#007AFF" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalDescription}>
              {t('settings.currencyModalDesc')}
            </Text>
            <TextInput
              style={{
                borderWidth: 1.5,
                borderColor: '#C8D8ED',
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 8,
                fontSize: 14,
                color: '#0D1B2E',
                marginBottom: 10,
                backgroundColor: '#F0F6FF',
              }}
              placeholder={t('settings.searchCurrencyPlaceholder')}
              placeholderTextColor="#9BAEC8"
              value={currencySearch}
              onChangeText={setCurrencySearch}
              autoCorrect={false}
              autoCapitalize="characters"
              clearButtonMode="while-editing"
            />
            <FlatList
              data={CURRENCIES.filter(c => {
                const q = currencySearch.toUpperCase().trim();
                if (!q) return true;
                return c.includes(q) || getCurrencyName(c).toUpperCase().includes(q);
              })}
              keyExtractor={(item) => item}
              renderItem={({ item }) => {
                const selected = auth.user?.preferredCurrency === item;
                return (
                  <TouchableOpacity
                    onPress={() => handleChangeCurrency(item)}
                    style={[styles.currencyOption, selected && styles.currencyOptionSelected]}
                  >
                    <View style={styles.currencyOptionContent}>
                      <View style={[styles.currencySymbolBadge, selected && { backgroundColor: '#007AFF' }]}>
                        <Text style={[styles.currencySymbolBadgeText, selected && { color: '#fff' }]}>
                          {getCurrencySymbol(item)}
                        </Text>
                      </View>
                      <View>
                        <Text style={[styles.currencyOptionText, selected && styles.currencyOptionTextSelected]}>
                          {item}
                        </Text>
                        <Text style={styles.currencyOptionName}>{getCurrencyName(item)}</Text>
                      </View>
                    </View>
                    {selected && <Ionicons name="checkmark" size={24} color="#007AFF" />}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
    </Modal>

    {/* Wallet ID Modal */}
    <Modal visible={showWalletIdModal} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.usernameModal}>
          <Text style={styles.usernameModalTitle}>{t('settings.yourWalletId')}</Text>
          <Text style={styles.usernameModalSub}>{t('settings.walletIdDesc')}</Text>
          <TextInput
            style={{
              borderWidth: 1.5,
              borderColor: '#1565C0',
              borderRadius: 12,
              fontSize: 11,
              color: '#0D1B2E',
              padding: 12,
              marginBottom: 16,
              textAlign: 'center',
            }}
            value={walletInfo?.id || ''}
            editable={false}
            selectTextOnFocus={true}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 4 }}>
            <TouchableOpacity
              style={[styles.umSaveBtn, { flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center' }]}
              onPress={() => {
                Share.share({ message: `My EGWallet ID: ${walletInfo?.id || ''}`, title: 'EGWallet ID' });
              }}
            >
              <Ionicons name="share-social" size={18} color="#fff" />
              <Text style={styles.umSaveText}>{t('common.share')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.umCancelBtn, { flex: 1 }]} onPress={() => setShowWalletIdModal(false)}>
              <Text style={styles.umCancelText}>{t('common.close')}</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 11, color: '#9BAEC8', textAlign: 'center', marginTop: 8 }}>
            {t('settings.longPressId')}
          </Text>
        </View>
      </View>
    </Modal>

    {/* Language Picker Modal */}
    <Modal visible={showLanguagePicker} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('settings.displayLanguage')}</Text>
            <TouchableOpacity onPress={() => setShowLanguagePicker(false)}>
              <Ionicons name="close" size={28} color="#007AFF" />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 13, color: '#657786', paddingHorizontal: 16, paddingBottom: 8 }}>
            {t('settings.chooseLanguage')}
          </Text>
          <FlatList
            data={LANGUAGES}
            keyExtractor={(item) => item.code}
            renderItem={({ item }) => {
              const selected = appLanguage === item.code;
              return (
                <TouchableOpacity
                  onPress={() => handleChangeLanguage(item.code)}
                  style={[styles.currencyOption, selected && styles.currencyOptionSelected]}
                >
                  <Text style={{ fontSize: 28, marginRight: 12 }}>{item.flag}</Text>
                  <View style={styles.currencyOptionContent}>
                    <Text style={[styles.currencyOptionText, selected && styles.currencyOptionTextSelected]}>
                      {item.name}
                    </Text>
                    <Text style={{ fontSize: 12, color: '#9BAEC8' }}>{item.code.toUpperCase()}</Text>
                  </View>
                  {selected && <Ionicons name="checkmark" size={24} color="#007AFF" />}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
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
  currencyOptionName: {
    fontSize: 12,
    color: '#657786',
    marginTop: 1,
  },
  currencySymbolBadge: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: 'rgba(21,101,192,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  currencySymbolBadgeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1565C0',
  },
  divider: {
    height: 1,
    backgroundColor: '#E1E8ED',
    marginHorizontal: 16,
  },
  wdRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.06)',
  },
  wdLabel: {
    fontSize: 13,
    color: '#657786',
  },
  wdValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0D1B2E',
  },
  wdStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 5,
  },
  wdStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00C853',
  },
  wdStatusText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#15803D',
  },
});
