import React, { useState, useEffect } from 'react';
import { fetchDashboardOverview } from './api';
import SkeletonGrid, { SkeletonLines } from './components/Skeleton';

function StatCard({ label, value, accent }) {
  return (
    <div className={`stat-card ${accent || ''}`}>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function DashboardHome({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setData(await fetchDashboardOverview());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return (<><SkeletonGrid count={6} columns={3} /><SkeletonLines count={5} /></>);
  if (error) return <p className="error-text">{error}</p>;

  const { stats, activity, onlineAdmins, health } = data;

  return (
    <div>
      <h2 className="page-title">Dashboard</h2>

      <div className="stats-grid">
        <StatCard label="Total Users" value={stats.totalUsers} />
        <StatCard label="Pending KYC" value={stats.pendingKyc} accent="warn" />
        <StatCard label="Verified Users" value={stats.verifiedUsers} accent="ok" />
        <StatCard label="Pending Withdrawals" value={stats.pendingWithdrawals} accent="warn" />
        <StatCard label="Transactions Today" value={stats.transactionsToday} />
        <StatCard label="New Users Today" value={stats.newUsersToday} accent="ok" />
      </div>

      <div className="home-panels">
        <section className="detail-section">
          <h3>Server Health</h3>
          <p>API: <strong>{health.api}</strong> · DB: <strong>{health.database}</strong> · Railway: <strong>{health.railway}</strong></p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate?.('health')}>Full health report</button>
        </section>

        <section className="detail-section">
          <h3>Online Admins ({onlineAdmins.length})</h3>
          {onlineAdmins.length === 0 && <p className="muted">No active admin sessions.</p>}
          <ul className="online-list">
            {onlineAdmins.map((a) => (
              <li key={a.adminId}>
                <strong>{a.email}</strong> · {a.role}
                <div className="muted">Last seen {formatDate(a.lastSeen)}{a.lastLoginAt ? ` · Last login ${formatDate(a.lastLoginAt)}` : ''}</div>
              </li>
            ))}
          </ul>
        </section>

        <section className="detail-section">
          <h3>Recent Activity</h3>
          <ul className="activity-feed">
            {(activity || []).slice(0, 12).map((item) => (
              <li key={item.id}>
                <strong>{item.action}</strong> by {item.admin}
                <div className="muted">{formatDate(item.timestamp)} · {item.ipAddress} · {item.browser}</div>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate?.('audit')}>View full audit log</button>
        </section>
      </div>
    </div>
  );
}
