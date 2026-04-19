import React, { useState } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';
import { isLoggedIn } from './api';

export default function App() {
  const [authenticated, setAuthenticated] = useState(isLoggedIn);

  if (authenticated) {
    return <Dashboard onLogout={() => setAuthenticated(false)} />;
  }
  return <Login onLogin={() => setAuthenticated(true)} />;
}
