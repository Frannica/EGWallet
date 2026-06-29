import React, { useState, useEffect, useCallback } from 'react';
import { fetchWithdrawals } from './api';

const STATUS_OPTIONS = ['', 'pending_review', 'approved', 'processing', 'paid', 'failed', 'reversed'];
const CURRENCY_OPTIONS = ['', 'XAF', 'XOF', 'EUR', 'USD', 'GBP'];

const STATUS_BADGE = {
  pending_review: 'badge-pending',
  approved: 'badge-approved',
  processing: 'badge-processing',
  paid: 'badge-paid',
  failed: 'badge-failed',
  reversed: 'badge-reversed',
};

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ''}`;
}

const QUEUE_TABS = [
  { id: 'pending', label: 'Pending', statuses: ['pending_review', 'pending', 'submitted'] },
  { id: 'processing', label: 'Processing', statuses: ['processing', 'approved'] },
  { id: 'failed', label: 'Failed', statuses: ['failed', 'reversed'] },
  { id: 'completed', label: 'Completed', statuses: ['paid', 'completed'] },
];

export default function WithdrawalTable({ onSelect }) {
  const [queueTab, setQueueTab] = useState('pending');
  const [withdrawals, setWithdrawals] = useState([]);
  const [allWithdrawals, setAllWithdrawals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCurrency, setFilterCurrency] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  const load = useCallback(async (pageNum = page) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchWithdrawals({
        status:   filterStatus,
        currency: filterCurrency,
        userId:   filterUserId.trim(),
        page:     pageNum,
        limit:    20,
      });
      // Support both paginated shape { data, page, totalPages, totalItems }
      // and old shape { withdrawals } for safety
      if (data.data) {
        setAllWithdrawals(data.data);
        setPage(data.page);
        setTotalPages(data.totalPages);
        setTotalItems(data.totalItems);
      } else {
        const list = Array.isArray(data) ? data : data.withdrawals || [];
        setAllWithdrawals(list);
        setTotalPages(1);
        setTotalItems(list.length);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterCurrency, filterUserId, page]);

  // When filters change, reset to page 1 and reload
  useEffect(() => {
    setPage(1);
  }, [filterStatus, filterCurrency, filterUserId]);

  useEffect(() => { load(page); }, [filterStatus, filterCurrency, filterUserId, page]); // eslint-disable-line

  useEffect(() => {
    const tab = QUEUE_TABS.find((t) => t.id === queueTab);
    if (!tab) return;
    if (queueTab === 'pending' && !filterStatus) {
      setWithdrawals(allWithdrawals.filter((w) => tab.statuses.includes(w.status)));
    } else if (!filterStatus) {
      setWithdrawals(allWithdrawals.filter((w) => tab.statuses.includes(w.status)));
    } else {
      setWithdrawals(allWithdrawals);
    }
  }, [allWithdrawals, queueTab, filterStatus]);

  function handleQueueTab(tabId) {
    setQueueTab(tabId);
    setFilterStatus('');
    setPage(1);
  }

  function handlePrev() { if (page > 1) setPage(p => p - 1); }
  function handleNext() { if (page < totalPages) setPage(p => p + 1); }

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
          <select className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s}>{s || 'All'}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label className="form-label">Currency</label>
          <select className="form-select" value={filterCurrency} onChange={e => setFilterCurrency(e.target.value)}>
            {CURRENCY_OPTIONS.map(c => (
              <option key={c} value={c}>{c || 'All'}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label className="form-label">User ID</label>
          <input
            className="form-input"
            value={filterUserId}
            onChange={e => setFilterUserId(e.target.value)}
            placeholder="Filter by user ID"
          />
        </div>
        <button className="btn btn-primary" onClick={() => load(page)} style={{ alignSelf: 'flex-end' }}>
          Refresh
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <p className="loading-text">Loading…</p>
      ) : withdrawals.length === 0 ? (
        <p className="empty-text">No withdrawals found.</p>
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
              {withdrawals.map(w => (
                <tr
                  key={w.id}
                  className="clickable-row"
                  onClick={() => onSelect(w.id)}
                >
                  <td className="mono">{w.id ? w.id.slice(0, 8) + '…' : '—'}</td>
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
          <button className="btn btn-secondary" onClick={handlePrev} disabled={page <= 1 || loading}>
            ← Previous
          </button>
          <span className="pagination-info">
            Page {page} of {totalPages}
            <span className="pagination-total"> ({totalItems} total)</span>
          </span>
          <button className="btn btn-secondary" onClick={handleNext} disabled={page >= totalPages || loading}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
