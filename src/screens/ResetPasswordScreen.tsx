import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { API_BASE, getApiLanguage } from '../api/client';
import { useLanguage } from '../i18n/LanguageContext';

export default function ResetPasswordScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  // Token can arrive via deep-link params OR user can paste it manually
  const [token, setToken] = useState<string>(route.params?.token ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [secureNew, setSecureNew] = useState(true);
  const [secureConfirm, setSecureConfirm] = useState(true);
  const [loading, setLoading] = useState(false);
  const { t } = useLanguage();

  async function onSubmit() {
    if (!token.trim()) {
      Alert.alert(t('common.error'), t('auth.enterResetCode'));
      return;
    }
    if (!newPassword.trim() || newPassword.length < 8) {
      Alert.alert(t('common.error'), t('auth.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert(t('common.error'), t('auth.passwordsDoNotMatch'));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': getApiLanguage(),
        },
        body: JSON.stringify({ token: token.trim(), newPassword }),
      });
      const data = await res.json();

      if (!res.ok) {
        const msg = data.error === 'invalid_or_expired_token'
          ? t('auth.resetTokenInvalid')
          : data.error === 'password_too_short'
          ? t('auth.passwordTooShort')
          : t('common.error');
        Alert.alert(t('common.error'), msg);
        return;
      }

      Alert.alert(t('auth.resetSuccess'), t('auth.resetSuccessMsg'), [
        { text: 'OK', onPress: () => navigation.navigate('Auth') },
      ]);
    } catch (_err) {
      Alert.alert(t('common.error'), t('auth.checkCredentials'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.icon}>🔒</Text>
          <Text style={styles.title}>{t('auth.resetPasswordTitle')}</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('auth.enterResetCode')}</Text>
            <TextInput
              value={token}
              onChangeText={setToken}
              placeholder={t('auth.enterResetCodePlaceholder')}
              placeholderTextColor="#AAB8C2"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
              style={styles.input}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('auth.newPassword')}</Text>
            <View style={styles.passwordContainer}>
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder={t('auth.passwordPlaceholder')}
                placeholderTextColor="#AAB8C2"
                secureTextEntry={secureNew}
                autoCapitalize="none"
                editable={!loading}
                style={[styles.input, styles.passwordInput]}
              />
              <TouchableOpacity style={styles.eyeButton} onPress={() => setSecureNew(v => !v)}>
                <Text style={styles.eyeIcon}>{secureNew ? '👁️' : '🙈'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>{t('auth.passwordHint')}</Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('auth.confirmPassword')}</Text>
            <View style={styles.passwordContainer}>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder={t('auth.passwordPlaceholder')}
                placeholderTextColor="#AAB8C2"
                secureTextEntry={secureConfirm}
                autoCapitalize="none"
                editable={!loading}
                style={[styles.input, styles.passwordInput]}
              />
              <TouchableOpacity style={styles.eyeButton} onPress={() => setSecureConfirm(v => !v)}>
                <Text style={styles.eyeIcon}>{secureConfirm ? '👁️' : '🙈'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.submitButton, loading && styles.submitButtonDisabled]}
            onPress={onSubmit}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.submitButtonText}>{t('auth.resetPasswordBtn')}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backLink}
            onPress={() => navigation.navigate('Auth')}
            disabled={loading}
          >
            <Text style={styles.backLinkText}>{t('auth.backToSignIn')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  icon: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#14171A',
    textAlign: 'center',
  },
  form: {
    width: '100%',
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E1E8ED',
    fontSize: 16,
    color: '#14171A',
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  passwordInput: {
    flex: 1,
    borderWidth: 0,
    borderRadius: 12,
  },
  eyeButton: {
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  eyeIcon: {
    fontSize: 20,
  },
  hint: {
    fontSize: 12,
    color: '#657786',
    marginTop: 4,
  },
  submitButton: {
    backgroundColor: '#007AFF',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  backLink: {
    alignItems: 'center',
    marginTop: 20,
    padding: 8,
  },
  backLinkText: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '500',
  },
});

