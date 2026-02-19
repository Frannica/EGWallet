import React, { useEffect } from 'react';
import { AuthProvider } from './src/auth/AuthContext';
import { BiometricProvider, useBiometric } from './src/auth/BiometricContext';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/utils/ErrorBoundary';
import BiometricLock from './src/components/BiometricLock';
import config from './src/config/env';

function AppContent() {
  const { isLocked } = useBiometric();
  
  if (isLocked) {
    return <BiometricLock />;
  }
  
  return <AppNavigator />;
}

export default function App() {
  useEffect(() => {
    if (__DEV__) {
      console.log('🚀 App Startup - Production API URL:', config.API_BASE_URL);
      console.log('🚀 App Environment:', __DEV__ ? 'Development' : 'Production');
    }
  }, []);

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
