import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

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
    if (__DEV__) {
      console.error('ErrorBoundary caught:', error, errorInfo);
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
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>
            The app hit an unexpected issue. Tap below to continue — your wallet is safe.
          </Text>
          {__DEV__ && this.state.error?.message ? (
            <View style={styles.devBox}>
              <Text style={styles.devText}>{this.state.error.message}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.button} onPress={this.handleReset} activeOpacity={0.85}>
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={styles.buttonText}>Try Again</Text>
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


type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

/**
 * Global Error Boundary
 * Catches unexpected crashes and displays a fallback UI
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
    // Log error for crash reporting (only in dev, or to crash service in prod)
    if (__DEV__) {
      console.error('ErrorBoundary caught:', error, errorInfo);
    }
    
    // Send to Sentry in production
    if (!__DEV__) {
      try {
        const Sentry = require('@sentry/react-native');
        Sentry.captureException(error, {
          contexts: {
            react: {
              componentStack: errorInfo.componentStack,
            },
          },
        });
      } catch (e) {
        console.warn('Failed to send error to Sentry:', e);
      }
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, backgroundColor: '#f5f5f5', padding: 20, justifyContent: 'center' }}>
          <ScrollView>
            <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 16, color: '#d32f2f' }}>
              ⚠️ Something went wrong
            </Text>
            <Text style={{ fontSize: 16, color: '#666', marginBottom: 12, lineHeight: 24 }}>
              The app encountered an unexpected error. Please try again or contact support if the problem persists.
            </Text>
            {__DEV__ && (
              <View style={{ backgroundColor: '#fff', padding: 12, borderRadius: 8, marginBottom: 16, borderColor: '#ddd', borderWidth: 1 }}>
                <Text style={{ fontWeight: 'bold', marginBottom: 8, color: '#d32f2f' }}>Error Details (Dev):</Text>
                <Text style={{ color: '#333', fontSize: 12, fontFamily: 'monospace' }}>
                  {this.state.error?.message}
                </Text>
              </View>
            )}
            <Button title="Try Again" onPress={this.handleReset} color="#007AFF" />
          </ScrollView>
        </View>
      );
    }

    return this.props.children;
  }
}
