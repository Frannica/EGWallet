import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { AuthProvider } from './src/auth/AuthContext';
import { BiometricProvider, useBiometric } from './src/auth/BiometricContext';
import AppNavigator from './src/navigation/AppNavigator';
import BiometricLock from './src/components/BiometricLock';
import config from './src/config/env';

// Temporary ErrorBoundary (pass-through) to fix crash
function ErrorBoundary({ children }) {
  return children;
}

function AppContent() {
  const { isLocked } = useBiometric();
  
  if (isLocked) {
    return <BiometricLock />;
  }
  
  return <AppNavigator />;
}

export default function App() {
  const [initError, setInitError] = useState(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Pre-flight checks
        if (__DEV__) {
          console.log('🚀 App Startup - API URL:', config.API_BASE_URL);
          console.log('🚀 Environment:', __DEV__ ? 'Development' : 'Production');
        }
        
        // Verify config is valid
        if (!config || !config.API_BASE_URL) {
          throw new Error('Invalid configuration: API_BASE_URL is missing');
        }
        
        setIsReady(true);
      } catch (error) {
        console.error('App initialization error:', error);
        setInitError(error);
      }
    })();
  }, []);

  // Show loading or error before rendering main app
  if (!isReady) {
    if (initError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#f5f5f5' }}>
          <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#d32f2f', marginBottom: 12 }}>
            ⚠️ Startup Error
          </Text>
          <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
            {initError.message || 'Failed to initialize app'}
          </Text>
          {__DEV__ && (
            <Text style={{ fontSize: 12, color: '#999', marginTop: 12, fontFamily: 'monospace' }}>
              {initError.stack}
            </Text>
          )}
        </View>
      );
    }
    
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <ErrorBoundary>
      <BiometricProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </BiometricProvider>
    </ErrorBoundary>
  );
}
