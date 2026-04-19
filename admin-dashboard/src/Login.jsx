import React, { useState } from 'react';
import { login } from './api';

export default function Login({ onLogin }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(secret);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-title">EGWallet Admin</h1>
        <p className="login-subtitle">Withdrawal Management</p>
        <form onSubmit={handleSubmit}>
          <label className="form-label">Admin Secret</label>
          <input
            type="password"
            className="form-input"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            placeholder="Enter admin secret"
            autoFocus
          />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%', marginTop: 12 }}>
            {loading ? 'Logging in…' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}
