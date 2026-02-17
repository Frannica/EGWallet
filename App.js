import React, { useEffect } from 'react';
import { AuthProvider } from './src/auth/AuthContext';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/utils/ErrorBoundary';
import config from './src/config/env';

export default function App() {
  useEffect(() => {
    console.log('🚀 App Startup - Production API URL:', config.API_BASE_URL);
    console.log('🚀 App Environment:', __DEV__ ? 'Development' : 'Production');
  }, []);

  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppNavigator />
      </AuthProvider>
    </ErrorBoundary>
  );
}
