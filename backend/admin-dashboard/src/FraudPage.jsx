import React, { useState, useEffect, useCallback } from 'react';
import { fetchFraudSignals, hasPermission } from './api';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const SEVERITY_BADGE = {
  critical: 'badge-failed',
  high: 'badge-failed',
  medium: 'badge-pending',
  low: 'badge-approved',
};

export default function FraudPage({ onViewUser }) {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchFraudSignals({ type: typeFilter || undefined });
      setSignals(data.signals || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => { load(); }, [load]);

  if (!hasPermission('fraud:read')) {
    return <p className="error-text">Insufficient permissions.</p>;
  }

  return (
    <div>
      <h2 className="page-title">Fraud Investigation</h2>
      <div className="filter-bar">
        <select className="form-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All signal types</option>
          <option value="fraud_alert">Fraud alerts</option>
          <option value="support_escalation">Support escalations</option>
          <option value="dispute">Disputes</option>
          <option value="failed_logins">Failed logins</option>
          <option value="account_restricted">Restricted accounts</option>
        </select>
        <button className="btn btn-secondary" onClick={load}>Refresh</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Severity</th>
              <th>Summary</th>
              <th>Source</th>
              <th>When</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id}>
                <td>{s.type.replace(/_/g, ' ')}</td>
                <td><span className={`badge ${SEVERITY_BADGE[s.severity] || ''}`}>{s.severity}</span></td>
                <td>{s.summary}</td>
                <td>{s.source}</td>
                <td>{formatDate(s.createdAt)}</td>
                <td>
                  {s.userId && (
                    <button className="btn btn-secondary btn-sm" onClick={() => onViewUser?.(s.userId)}>View User</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && signals.length === 0 && <p className="empty-text">No fraud signals.</p>}
      </div>
    </div>
  );
}
