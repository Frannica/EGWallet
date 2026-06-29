import React, { useState, useEffect, useCallback } from 'react';
import { fetchDisputes, updateDispute, hasPermission } from './api';
import { showToast } from './utils/ui';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function DisputesPage({ onViewUser }) {
  const [disputes, setDisputes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [resolution, setResolution] = useState('');
  const canWrite = hasPermission('disputes:write');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchDisputes({ status: statusFilter || undefined });
      setDisputes(data.disputes || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function handleUpdate(status) {
    if (!selected) return;
    try {
      const data = await updateDispute(selected.id, { status, resolution: resolution.trim() || undefined });
      setSelected(data.dispute);
      showToast(`Dispute marked ${status}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (selected) {
    return (
      <div>
        <button className="btn btn-secondary" onClick={() => setSelected(null)}>← Back</button>
        <h2 className="page-title" style={{ marginTop: 12 }}>Dispute {selected.ticketNumber}</h2>
        {error && <p className="error-text">{error}</p>}
        <section className="detail-section">
          <table className="detail-table">
            <tbody>
              <tr><td className="detail-label">User</td><td>{selected.userEmail}</td></tr>
              <tr><td className="detail-label">Transaction</td><td className="mono">{selected.transactionId}</td></tr>
              <tr><td className="detail-label">Reason</td><td>{selected.reason}</td></tr>
              <tr><td className="detail-label">Status</td><td>{selected.status}</td></tr>
              <tr><td className="detail-label">Created</td><td>{formatDate(selected.createdAt)}</td></tr>
            </tbody>
          </table>
          <p style={{ marginTop: 12 }}>{selected.description}</p>
        </section>
        {canWrite && selected.status !== 'closed' && (
          <section className="detail-section">
            <h3>Resolution</h3>
            <textarea className="form-input" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Resolution notes…" />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => handleUpdate('investigating')}>Mark Investigating</button>
              <button className="btn btn-primary" onClick={() => handleUpdate('resolved')}>Resolve</button>
              <button className="btn btn-secondary" onClick={() => handleUpdate('closed')}>Close</button>
              {selected.userId && (
                <button className="btn btn-secondary" onClick={() => onViewUser?.(selected.userId)}>View User</button>
              )}
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="page-title">Disputes</h2>
      <div className="filter-bar">
        <select className="form-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="investigating">Investigating</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
        <button className="btn btn-secondary" onClick={load}>Refresh</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticket #</th>
              <th>User</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {disputes.map((d) => (
              <tr key={d.id}>
                <td>{d.ticketNumber}</td>
                <td>{d.userEmail || d.userId?.slice(0, 8)}</td>
                <td>{d.reason}</td>
                <td>{d.status}</td>
                <td>{formatDate(d.createdAt)}</td>
                <td><button className="btn btn-secondary btn-sm" onClick={() => setSelected(d)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && disputes.length === 0 && <p className="empty-text">No disputes.</p>}
      </div>
    </div>
  );
}
