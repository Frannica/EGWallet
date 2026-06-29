import React, { useState } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';
import ErrorBoundary from './components/ErrorBoundary';
import { isLoggedIn, initTheme } from './api';

initTheme();

export default function App() {
  const [authenticated, setAuthenticated] = useState(isLoggedIn);

  if (!authenticated) {
    return (
      <ErrorBoundary>
        <Login onLogin={() => setAuthenticated(true)} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Dashboard onLogout={() => setAuthenticated(false)} />
    </ErrorBoundary>
  );
}
