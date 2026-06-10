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
import { useNavigation } from '@react-navigation/native';
import { API_BASE, getApiLanguage } from '../api/client';
import { useLanguage } from '../i18n/LanguageContext';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const navigation = useNavigation<any>();
  const { t } = useLanguage();

  async function onSubmit() {
    if (!email.trim()) {
      Alert.alert(t('common.error'), t('auth.enterEmail'));
      return;
    }

    setLoading(true);
    try {
      await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': getApiLanguage(),
        },
        body: JSON.stringify({ email: email.trim() }),
      });
      // Always show success — backend never leaks whether email exists
      setSent(true);
    } catch (_err) {
      // Network error — still show success to avoid leaking info
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <View style={styles.container}>
        <View style={styles.sentContainer}>
          <Text style={styles.sentIcon}>📧</Text>
          <Text style={styles.sentTitle}>{t('auth.resetEmailSent')}</Text>
          <Text style={styles.sentBody}>{t('auth.resetEmailSentMsg')}</Text>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.navigate('Auth')}
          >
            <Text style={styles.backButtonText}>{t('auth.backToSignIn')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.enterTokenButton}
            onPress={() => navigation.navigate('ResetPassword')}
          >
            <Text style={styles.enterTokenText}>{t('auth.enterResetCode')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.icon}>🔑</Text>
          <Text style={styles.title}>{t('auth.forgotPasswordTitle')}</Text>
          <Text style={styles.subtitle}>{t('auth.forgotPasswordSubtitle')}</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('auth.email')}</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder={t('auth.emailPlaceholder')}
              placeholderTextColor="#AAB8C2"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
              style={styles.input}
            />
          </View>

          <TouchableOpacity
            style={[styles.submitButton, loading && styles.submitButtonDisabled]}
            onPress={onSubmit}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.submitButtonText}>{t('auth.sendResetLink')}</Text>
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
    marginBottom: 40,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#657786',
    textAlign: 'center',
    lineHeight: 22,
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
  // Sent confirmation
  sentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  sentIcon: {
    fontSize: 64,
    marginBottom: 24,
  },
  sentTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 12,
    textAlign: 'center',
  },
  sentBody: {
    fontSize: 15,
    color: '#657786',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  backButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 12,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  enterTokenButton: {
    padding: 12,
  },
  enterTokenText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '500',
  },
});

