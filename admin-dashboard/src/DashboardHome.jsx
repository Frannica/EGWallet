import React, { useState, useEffect } from 'react';
import { fetchStats } from './api';

function StatCard({ label, value, accent }) {
  return (
    <div className={`stat-card ${accent || ''}`}>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function DashboardHome({ onNavigate }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchStats();
        setStats(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <h2 className="page-title">Dashboard</h2>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading stats…</p>}

      {stats && (
        <>
          <div className="stats-grid">
            <StatCard label="Total Users" value={stats.totalUsers} />
            <StatCard label="Pending KYC" value={stats.pendingKyc} accent="warn" onClick={() => onNavigate?.('kyc')} />
            <StatCard label="Verified Users" value={stats.verifiedUsers} accent="ok" />
            <StatCard label="Pending Withdrawals" value={stats.pendingWithdrawals} accent="warn" />
            <StatCard label="Transactions Today" value={stats.transactionsToday} />
            <StatCard label="New Users Today" value={stats.newUsersToday} accent="ok" />
          </div>
          <div className="quick-links">
            <button className="btn btn-secondary" onClick={() => onNavigate?.('users')}>Search Users</button>
            <button className="btn btn-secondary" onClick={() => onNavigate?.('kyc')}>KYC Queue</button>
            <button className="btn btn-secondary" onClick={() => onNavigate?.('withdrawals')}>Withdrawals</button>
          </div>
        </>
      )}
    </div>
  );
}
