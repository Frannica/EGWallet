import React, { useState, useEffect, useCallback } from 'react';
import { fetchSupportTickets, fetchSupportTicket, replySupportTicket, closeSupportTicket, hasPermission } from './api';
import { showToast } from './utils/ui';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function SupportTickets({ onViewUser }) {
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reply, setReply] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const canWrite = hasPermission('tickets:write');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchSupportTickets({ status: statusFilter || undefined });
      setTickets(data.tickets || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function openTicket(id) {
    setSelectedId(id);
    setDetail(null);
    try {
      const data = await fetchSupportTicket(id);
      setDetail(data.ticket);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReply(e) {
    e.preventDefault();
    if (!reply.trim()) return;
    setActionLoading(true);
    try {
      await replySupportTicket(selectedId, reply.trim());
      setReply('');
      showToast('Reply sent');
      await openTicket(selectedId);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleClose() {
    setActionLoading(true);
    try {
      await closeSupportTicket(selectedId);
      showToast('Ticket closed');
      setSelectedId(null);
      setDetail(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  if (selectedId && detail) {
    return (
      <div>
        <button className="btn btn-secondary" onClick={() => { setSelectedId(null); setDetail(null); }}>← Back</button>
        <h2 className="page-title" style={{ marginTop: 12 }}>{detail.subject}</h2>
        <p className="muted">{detail.userEmail} · {detail.priority} · {detail.status}</p>
        {error && <p className="error-text">{error}</p>}

        <section className="detail-section">
          <h3>Description</h3>
          <p>{detail.description}</p>
        </section>

        {(detail.replies || []).length > 0 && (
          <section className="detail-section">
            <h3>Replies</h3>
            {detail.replies.map((r) => (
              <div key={r.id} className="note-item">
                <strong>{r.from === 'admin' ? r.adminEmail : 'User'}</strong>
                <span className="muted"> · {formatDate(r.createdAt)}</span>
                <p>{r.message}</p>
              </div>
            ))}
          </section>
        )}

        {canWrite && detail.status !== 'closed' && (
          <section className="detail-section">
            <h3>Reply</h3>
            <form onSubmit={handleReply}>
              <textarea className="form-input" rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Type your reply…" />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={actionLoading}>Send Reply</button>
                <button type="button" className="btn btn-secondary" onClick={handleClose} disabled={actionLoading}>Close Ticket</button>
                {detail.userId && (
                  <button type="button" className="btn btn-secondary" onClick={() => onViewUser?.(detail.userId)}>View User</button>
                )}
              </div>
            </form>
          </section>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="page-title">Support Tickets</h2>
      <div className="filter-bar">
        <select className="form-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
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
              <th>Subject</th>
              <th>User</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id}>
                <td>{t.subject}</td>
                <td>{t.userEmail || t.userId?.slice(0, 8)}</td>
                <td><span className={`badge badge-${t.priority === 'urgent' ? 'failed' : 'pending'}`}>{t.priority}</span></td>
                <td>{t.status}</td>
                <td>{formatDate(t.updatedAt)}</td>
                <td><button className="btn btn-secondary btn-sm" onClick={() => openTicket(t.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && tickets.length === 0 && <p className="empty-text">No support tickets.</p>}
      </div>
    </div>
  );
}
