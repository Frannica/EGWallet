import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Localization from 'expo-localization';
import { translations, deviceLocaleToLanguage } from '../i18n/translations';

/**
 * ErrorBoundary sits above LanguageProvider (it must catch crashes even if
 * LanguageProvider itself fails), so it cannot use the useLanguage() hook.
 * It resolves the device locale directly instead.
 */
function boundaryT(key: string): string {
  let lang: keyof typeof translations = 'en';
  try {
    const locales = Localization.getLocales();
    if (locales && locales.length > 0) {
      lang = deviceLocaleToLanguage(locales[0].languageCode);
    }
  } catch {
    lang = 'en';
  }
  return translations[lang]?.[key] ?? translations.en[key] ?? key;
}

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

/**
 * Global Error Boundary
 * Catches unexpected crashes and shows a friendly recovery UI.
 * Never exposes technical details in production.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Always log so adb logcat ReactNativeJS captures production crashes.
    console.error(
      'ErrorBoundary caught:',
      error?.message,
      error?.stack,
      errorInfo?.componentStack,
    );
    try {
      const Sentry = require('@sentry/react-native');
      Sentry.captureException(error, {
        contexts: { react: { componentStack: errorInfo?.componentStack } },
      });
    } catch {
      // Sentry optional if init failed
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Ionicons name="refresh-circle-outline" size={72} color="#1565C0" />
          <Text style={styles.title}>{boundaryT('errorBoundary.title')}</Text>
          <Text style={styles.subtitle}>
            {boundaryT('errorBoundary.subtitle')}
          </Text>
          {__DEV__ && this.state.error?.message ? (
            <View style={styles.devBox}>
              <Text style={styles.devText}>{this.state.error.message}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.button} onPress={this.handleReset} activeOpacity={0.85}>
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={styles.buttonText}>{boundaryT('errorBoundary.tryAgain')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F9FF',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a2e',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#555',
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 320,
  },
  devBox: {
    backgroundColor: '#FFF3E0',
    borderRadius: 8,
    padding: 12,
    width: '100%',
    borderWidth: 1,
    borderColor: '#FFB300',
  },
  devText: {
    fontSize: 12,
    color: '#E65100',
    fontFamily: 'monospace',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1565C0',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 8,
    marginTop: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

