import React, { useEffect } from 'react';
import { AuthProvider } from './src/auth/AuthContext';
import { ThemeProvider } from './src/contexts/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import { GlobalErrorBoundary } from './src/utils/GlobalErrorBoundary';
import { initializeSentry } from './src/utils/sentry';
import { requestNotificationPermissions } from './src/utils/NotificationService';
import { startRateMonitoring } from './src/utils/RateAlertService';
import config from './src/config/env';

// Initialize crash monitoring
initializeSentry();

export default function App() {
  useEffect(() => {
    console.log('🚀 App Startup - Production API URL:', config.API_BASE_URL);
    console.log('🚀 App Environment:', __DEV__ ? 'Development' : 'Production');
    console.log('🛡️ Crash protection: ENABLED');
    console.log('📦 Version: 12 - New Features'); // Force fingerprint change
    
    // Request notification permissions on startup
    requestNotificationPermissions();
    
    // Start rate monitoring
    const rateMonitorInterval = startRateMonitoring();
    
    return () => {
      if (rateMonitorInterval) {
        clearInterval(rateMonitorInterval);
      }
    };
  }, []);

  return (
    <GlobalErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <AppNavigator />
        </AuthProvider>
      </ThemeProvider>
    </GlobalErrorBoundary>
  );
}
