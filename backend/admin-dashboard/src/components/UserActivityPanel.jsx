import React, { useState, useEffect, useCallback } from 'react';
import { fetchUserActivity } from '../api';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString()} ${currency || ''}`.trim();
}

const TABS = [
  { id: 'deposits', label: 'Deposits' },
  { id: 'exchanges', label: 'Exchanges' },
  { id: 'qr_payments', label: 'QR Payments' },
  { id: 'qr_codes', label: 'QR Codes' },
  { id: 'payment_requests', label: 'Request Money' },
  { id: 'withdrawals', label: 'Withdrawals' },
  { id: 'virtual_cards', label: 'Virtual Cards' },
  { id: 'virtual_card_charges', label: 'Card Charges' },
  { id: 'virtual_card_freeze_history', label: 'Freeze History' },
  { id: 'transactions', label: 'All Transactions' },
];

function renderRow(category, item) {
  if (category === 'virtual_cards') {
    return (
      <tr key={item.id}>
        <td className="mono">{item.maskedNumber || item.last4}</td>
        <td>{item.label || '—'}</td>
        <td>{item.status}</td>
        <td>{formatAmount(item.spentToday, item.currency)} today</td>
        <td>{formatAmount(item.spentMonth, item.currency)} month</td>
        <td>{formatAmount(item.dailyLimit, item.currency)} / {formatAmount(item.monthlyLimit, item.currency)}</td>
        <td>{formatDate(item.createdAt)}</td>
      </tr>
    );
  }
  if (category === 'virtual_card_freeze_history') {
    return (
      <tr key={item.id}>
        <td>{formatDate(item.at)}</td>
        <td className="mono">{item.maskedCard || item.cardLast4 || '—'}</td>
        <td>{item.from} → {item.to}</td>
        <td>{item.actor || '—'}</td>
        <td>{item.adminId || '—'}</td>
        <td>{item.reason || '—'}</td>
      </tr>
    );
  }
  if (category === 'virtual_card_charges') {
    return (
      <tr key={item.id}>
        <td>{formatDate(item.createdAt)}</td>
        <td className="mono">{item.maskedCard || item.cardLast4 || '—'}</td>
        <td>{item.type}</td>
        <td>{formatAmount(item.amount, item.currency)}</td>
        <td>{item.merchant || '—'}</td>
        <td>{item.status}</td>
        <td className="mono">{item.providerReference ? String(item.providerReference).slice(0, 12) : '—'}</td>
      </tr>
    );
  }
  if (category === 'qr_codes') {
    return (
      <tr key={item.id}>
        <td className="mono">{String(item.id).slice(0, 8)}…</td>
        <td>{item.type || '—'}</td>
        <td>{item.used ? 'used' : 'open'}</td>
        <td>{formatAmount(item.amount, item.currency)}</td>
        <td>{item.memo || '—'}</td>
        <td>{formatDate(item.createdAt)}</td>
      </tr>
    );
  }
  if (category === 'payment_requests') {
    return (
      <tr key={item.id}>
        <td>{formatDate(item.createdAt)}</td>
        <td>{formatAmount(item.amount, item.currency)}</td>
        <td>{item.status}</td>
        <td colSpan={2}>{item.memo || '—'}</td>
      </tr>
    );
  }
  if (category === 'withdrawals') {
    return (
      <tr key={item.id}>
        <td>{formatDate(item.createdAt)}</td>
        <td>{formatAmount(item.amount, item.currency)}</td>
        <td>{item.status}</td>
        <td colSpan={2}>{item.method || '—'}</td>
      </tr>
    );
  }
  return (
    <tr key={item.id}>
      <td>{formatDate(item.createdAt)}</td>
      <td>{item.type || category}</td>
      <td>{formatAmount(item.amount, item.currency)}</td>
      <td>{item.status || '—'}</td>
      <td>{item.memo || '—'}</td>
    </tr>
  );
}

function tableHeaders(category) {
  if (category === 'virtual_cards') {
    return ['Card', 'Label', 'Status', 'Spent Today', 'Spent Month', 'Daily / Monthly Limit', 'Created'];
  }
  if (category === 'virtual_card_freeze_history') {
    return ['Date', 'Card', 'Transition', 'Actor', 'Admin', 'Reason'];
  }
  if (category === 'virtual_card_charges') {
    return ['Date', 'Card', 'Type', 'Amount', 'Merchant', 'Status', 'Provider Ref'];
  }
  if (category === 'qr_codes') {
    return ['ID', 'Type', 'State', 'Amount', 'Memo', 'Created'];
  }
  if (category === 'payment_requests' || category === 'withdrawals') {
    return ['Date', 'Amount', 'Status', 'Details', ''];
  }
  return ['Date', 'Type', 'Amount', 'Status', 'Memo'];
}

export default function UserActivityPanel({ userId, activityCounts = {} }) {
  const [tab, setTab] = useState('deposits');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (category, pageNum = 1) => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchUserActivity(userId, category, pageNum);
      setData(result);
      setPage(result.page || pageNum);
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    setPage(1);
    load(tab, 1);
  }, [tab, load]);

  function switchTab(id) {
    setTab(id);
    setPage(1);
  }

  return (
    <section className="detail-section">
      <h3>Money Activity <span className="read-only-tag">Paginated</span></h3>
      <div className="queue-tabs activity-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`queue-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
            {activityCounts[t.id] != null && (
              <span className="tab-count"> ({activityCounts[t.id]})</span>
            )}
          </button>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading activity…</p>}

      {!loading && data && (
        <>
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>{tableHeaders(tab).map((h) => <th key={h || 'blank'}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {(data.data || []).map((item) => renderRow(tab, item))}
                {(data.data || []).length === 0 && (
                  <tr><td colSpan={6} className="muted">No records in this category.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {data.totalPages > 1 && (
            <div className="pagination-bar">
              <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => load(tab, page - 1)}>← Previous</button>
              <span className="pagination-info">
                Page {data.page} of {data.totalPages} ({data.totalItems} total)
              </span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={page >= data.totalPages || loading} onClick={() => load(tab, page + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
