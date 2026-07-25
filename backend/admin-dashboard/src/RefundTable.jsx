import React, { useCallback, useEffect, useState } from 'react';
import { fetchRefunds } from './api';

const STATUS_OPTIONS = ['', 'requested', 'pending', 'requires_action', 'succeeded', 'failed', 'cancelled'];

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  return `${(Number(amount) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

export default function RefundTable({ onSelect }) {
  const [refunds, setRefunds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async (pageNum = 1) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchRefunds({
        status: filterStatus || undefined,
        userId: filterUserId.trim() || undefined,
        page: pageNum,
        limit: 20,
      });
      setRefunds(Array.isArray(data?.data) ? data.data : (data?.refunds || []));
      setPage(data?.page || 1);
      setTotalPages(data?.totalPages || 1);
    } catch (err) {
      setError(err.message || 'Failed to load refunds');
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterUserId]);

  useEffect(() => { load(1); }, [load]);

  return (
    <div>
      <div className="page-header">
        <h2>Refunds</h2>
        <p className="muted">Money always returns to the original Stripe payment method. Destination cannot be changed.</p>
      </div>

      <div className="filters-row">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s || 'all'} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>
        <input
          placeholder="Filter by user ID"
          value={filterUserId}
          onChange={(e) => setFilterUserId(e.target.value)}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => load(1)}>Refresh</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading ? <p>Loading…</p> : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Status</th>
              <th>Amount</th>
              <th>User</th>
              <th>PaymentIntent</th>
              <th>Stripe Refund</th>
            </tr>
          </thead>
          <tbody>
            {refunds.length === 0 && (
              <tr><td colSpan={6} className="muted">No refunds found.</td></tr>
            )}
            {refunds.map((r) => (
              <tr key={r.id} className="clickable-row" onClick={() => onSelect(r.id)}>
                <td>{formatDate(r.createdAt)}</td>
                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                <td>{formatAmount(r.amount, r.currency)}</td>
                <td className="mono">{r.userId?.slice(0, 8)}…</td>
                <td className="mono">{r.stripePaymentIntentId}</td>
                <td className="mono">{r.stripeRefundId || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="pagination">
        <button type="button" disabled={page <= 1} onClick={() => load(page - 1)}>Prev</button>
        <span>Page {page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => load(page + 1)}>Next</button>
      </div>
    </div>
  );
}
