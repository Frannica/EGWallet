import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';

interface LoadingScreenProps {
  message?: string;
  fullScreen?: boolean;
}

/**
 * Loading Screen Component
 * Shows animated spinner during data fetching
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({ 
  message = 'Loading...', 
  fullScreen = true 
}) => {
  return (
    <View style={[styles.container, !fullScreen && styles.inline]}>
      <ActivityIndicator size="large" color="#007AFF" />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
  },
  inline: {
    flex: 0,
    padding: 32,
  },
  message: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
    fontWeight: '500',
  },
});
