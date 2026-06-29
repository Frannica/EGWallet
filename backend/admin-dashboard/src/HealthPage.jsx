import React, { useState, useEffect } from 'react';
import { fetchAdminHealth } from './api';
import { SkeletonLines } from './components/Skeleton';

function StatusBadge({ ok }) {
  return <span className={`badge ${ok ? 'badge-approved' : 'badge-failed'}`}>{ok ? 'OK' : 'ERROR'}</span>;
}

export default function HealthPage() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchAdminHealth();
        setHealth(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <SkeletonLines count={6} />;
  if (error) return <div className="error-page"><h2>Health check failed</h2><p>{error}</p></div>;

  return (
    <div>
      <h2 className="page-title">System Health</h2>
      <div className="detail-grid">
        <div className="detail-section">
          <h3>API</h3>
          <StatusBadge ok={health.api?.status === 'ok'} />
          <p className="muted">Uptime: {health.api?.uptimeSeconds}s</p>
        </div>
        <div className="detail-section">
          <h3>Database</h3>
          <StatusBadge ok={health.database?.status === 'ok'} />
          <p className="muted">Latency: {health.database?.latencyMs ?? '—'}ms · App state: {health.database?.appState}</p>
        </div>
        <div className="detail-section">
          <h3>Railway</h3>
          <p>{health.railway?.environment || 'local'}</p>
          <p className="muted">{health.railway?.service || '—'}</p>
        </div>
      </div>
    </div>
  );
}
