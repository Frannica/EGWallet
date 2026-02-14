import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

interface FallbackScreenProps {
  message?: string;
  onRetry?: () => void;
  icon?: string;
  title?: string;
}

/**
 * Production-Safe Fallback UI
 * Shows when API fails or data can't load
 */
export const FallbackScreen: React.FC<FallbackScreenProps> = ({ 
  message, 
  onRetry,
  icon = '⚠️',
  title = 'Something went wrong'
}) => {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>
        {message || 'Unable to load data. Please check your connection and try again.'}
      </Text>
      {onRetry && (
        <TouchableOpacity style={styles.button} onPress={onRetry}>
          <Text style={styles.buttonText}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

/**
 * Loading state component
 */
export const LoadingScreen: React.FC<{ message?: string }> = ({ message }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>⏳</Text>
      <Text style={styles.message}>{message || 'Loading...'}</Text>
    </View>
  );
};

/**
 * Offline state component
 */
export const OfflineScreen: React.FC<{ onRetry?: () => void }> = ({ onRetry }) => {
  return (
    <FallbackScreen
      icon="📡"
      title="No Internet Connection"
      message="Please check your network connection and try again."
      onRetry={onRetry}
    />
  );
};

/**
 * Empty state component
 */
export const EmptyState: React.FC<{ message: string; icon?: string }> = ({ message, icon = '📭' }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#f5f5f5'
  },
  icon: {
    fontSize: 64,
    marginBottom: 16
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
    textAlign: 'center'
  },
  message: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 120
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center'
  }
});
