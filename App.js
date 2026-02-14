import React, { useEffect } from 'react';
import { AuthProvider } from './src/auth/AuthContext';
import AppNavigator from './src/navigation/AppNavigator';
import { GlobalErrorBoundary } from './src/utils/GlobalErrorBoundary';
import { initializeSentry } from './src/utils/sentry';
import config from './src/config/env';

// Initialize crash monitoring
initializeSentry();

export default function App() {
  useEffect(() => {
    console.log('🚀 App Startup - Production API URL:', config.API_BASE_URL);
    console.log('🚀 App Environment:', __DEV__ ? 'Development' : 'Production');
    console.log('🛡️ Crash protection: ENABLED');
    console.log('📦 Version: 12'); // Force fingerprint change
  }, []);

  return (
    <GlobalErrorBoundary>
      <AuthProvider>
        <AppNavigator />
      </AuthProvider>
    </GlobalErrorBoundary>
  );
}
