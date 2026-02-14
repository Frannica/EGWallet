import React from 'react';
import { View, Text, Button, ScrollView } from 'react-native';

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
    // TODO: Send to crash reporting service (e.g., Sentry, Firebase) in production
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
