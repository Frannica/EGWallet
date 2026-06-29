import React, { useState, useEffect, useCallback } from 'react';
import { fetchWithdrawals } from './api';

const STATUS_OPTIONS = ['', 'pending_review', 'pending', 'submitted', 'approved', 'processing', 'paid', 'completed', 'failed', 'reversed', 'rejected'];
const CURRENCY_OPTIONS = ['', 'XAF', 'XOF', 'EUR', 'USD', 'GBP'];

const STATUS_BADGE = {
  pending_review: 'badge-pending',
  pending: 'badge-pending',
  submitted: 'badge-pending',
  approved: 'badge-approved',
  processing: 'badge-processing',
  paid: 'badge-paid',
  completed: 'badge-paid',
  failed: 'badge-failed',
  reversed: 'badge-reversed',
  rejected: 'badge-failed',
};

const QUEUE_TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'processing', label: 'Processing' },
  { id: 'failed', label: 'Failed' },
  { id: 'completed', label: 'Completed' },
];

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  return `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

function normalizeListResponse(data) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.withdrawals)
      ? data.withdrawals
      : Array.isArray(data)
        ? data
        : [];
  return {
    list,
    page: data?.page || 1,
    totalPages: data?.totalPages || 1,
    totalItems: data?.totalItems ?? list.length,
  };
}

export default function WithdrawalTable({ onSelect }) {
  const [queueTab, setQueueTab] = useState('pending');
  const [withdrawals, setWithdrawals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCurrency, setFilterCurrency] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(async (pageNum = 1) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchWithdrawals({
        queue: filterStatus ? undefined : queueTab,
        status: filterStatus || undefined,
        currency: filterCurrency || undefined,
        userId: filterUserId.trim() || undefined,
        page: pageNum,
        limit: 20,
      });
      const normalized = normalizeListResponse(data);
      setWithdrawals(normalized.list);
      setPage(normalized.page);
      setTotalPages(normalized.totalPages);
      setTotalItems(normalized.totalItems);
    } catch (err) {
      setWithdrawals([]);
      setError(err?.message || 'Failed to load withdrawals');
    } finally {
      setLoading(false);
    }
  }, [queueTab, filterStatus, filterCurrency, filterUserId]);

  useEffect(() => {
    setPage(1);
    load(1);
  }, [queueTab, filterStatus, filterCurrency, filterUserId, load]);

  useEffect(() => {
    if (page > 1) load(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleQueueTab(tabId) {
    setQueueTab(tabId);
    setFilterStatus('');
    setPage(1);
  }

  function handlePrev() {
    if (page > 1) setPage((p) => p - 1);
  }

  function handleNext() {
    if (page < totalPages) setPage((p) => p + 1);
  }

  return (
    <div>
      <h2 className="page-title">Withdrawals Queue</h2>
      <div className="queue-tabs">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`queue-tab ${queueTab === t.id ? 'active' : ''}`}
            onClick={() => handleQueueTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <div className="filter-group">
          <label className="form-label">Status</label>
          <select className="form-select" value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s || 'all'} value={s}>{s || 'All (queue tab filter)'}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label className="form-label">Currency</label>
          <select className="form-select" value={filterCurrency} onChange={(e) => { setFilterCurrency(e.target.value); setPage(1); }}>
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c || 'all'} value={c}>{c || 'All'}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label className="form-label">User ID</label>
          <input
            className="form-input"
            value={filterUserId}
            onChange={(e) => { setFilterUserId(e.target.value); setPage(1); }}
            placeholder="Filter by user ID"
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={() => load(page)} style={{ alignSelf: 'flex-end' }}>
          Refresh
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <p className="loading-text">Loading…</p>
      ) : withdrawals.length === 0 ? (
        <p className="empty-text">No withdrawals found for this queue.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>User ID</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Country</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr
                  key={w.id}
                  className="clickable-row"
                  onClick={() => w.id && onSelect(w.id)}
                >
                  <td className="mono">{w.id ? `${String(w.id).slice(0, 8)}…` : '—'}</td>
                  <td className="mono">{w.userId || '—'}</td>
                  <td>{formatAmount(w.amount, w.currency)}</td>
                  <td>{w.method || '—'}</td>
                  <td>{w.country || '—'}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[w.status] || ''}`}>
                      {w.status || '—'}
                    </span>
                  </td>
                  <td>{formatDate(w.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="pagination-bar">
          <button type="button" className="btn btn-secondary" onClick={handlePrev} disabled={page <= 1 || loading}>
            ← Previous
          </button>
          <span className="pagination-info">
            Page {page} of {totalPages}
            <span className="pagination-total"> ({totalItems} total)</span>
          </span>
          <button type="button" className="btn btn-secondary" onClick={handleNext} disabled={page >= totalPages || loading}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
