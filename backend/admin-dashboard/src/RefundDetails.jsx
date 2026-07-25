import React, { useEffect, useState } from 'react';
import { fetchRefundById, reconcileRefund } from './api';

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  return `${(Number(amount) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

export default function RefundDetails({ id, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setData(await fetchRefundById(id));
    } catch (err) {
      setError(err.message || 'Failed to load refund');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function onReconcile() {
    setBusy(true);
    setMessage('');
    try {
      const result = await reconcileRefund(id);
      setData((prev) => ({ ...prev, refund: result.refund, reconciliation: result.reconciliation }));
      setMessage(`Reconciled: ${result.reconciliation?.outcome || 'ok'}`);
    } catch (err) {
      setMessage(err.message || 'Reconcile failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error) {
    return (
      <div>
        <button type="button" className="btn btn-secondary" onClick={onBack}>Back</button>
        <div className="error-banner">{error}</div>
      </div>
    );
  }

  const refund = data?.refund || {};
  const ledger = data?.ledger || [];
  const deposit = data?.deposit;

  return (
    <div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
      <h2 style={{ marginTop: 12 }}>Refund {refund.id?.slice(0, 8)}…</h2>

      <div className="info-banner" style={{ marginBottom: 16 }}>
        Destination policy: <strong>original payment method only</strong>. Admins cannot redirect refund money elsewhere.
      </div>

      <div className="detail-grid">
        <div><span className="muted">Status</span><div>{refund.status}</div></div>
        <div><span className="muted">Wallet amount</span><div>{formatAmount(refund.amount, refund.currency)}</div></div>
        <div><span className="muted">Stripe refund amount</span><div>{formatAmount(refund.stripeRefundAmount, refund.currency)}</div></div>
        <div><span className="muted">Stripe status</span><div>{refund.stripeStatus || '—'}</div></div>
        <div><span className="muted">PaymentIntent</span><div className="mono">{refund.stripePaymentIntentId}</div></div>
        <div><span className="muted">Stripe Refund ID</span><div className="mono">{refund.stripeRefundId || '—'}</div></div>
        <div><span className="muted">Hold placed</span><div>{String(!!refund.holdPlaced)}</div></div>
        <div><span className="muted">Hold released</span><div>{String(!!refund.holdReleased)}</div></div>
        <div><span className="muted">Wallet debited</span><div>{String(!!refund.walletDebited)}</div></div>
        <div><span className="muted">Created</span><div>{formatDate(refund.createdAt)}</div></div>
        <div><span className="muted">Completed</span><div>{formatDate(refund.completedAt)}</div></div>
        <div><span className="muted">Failure reason</span><div>{refund.failureReason || '—'}</div></div>
      </div>

      {deposit && (
        <div style={{ marginTop: 20 }}>
          <h3>Original deposit</h3>
          <div className="detail-grid">
            <div><span className="muted">Deposit ID</span><div className="mono">{deposit.id}</div></div>
            <div><span className="muted">Amount</span><div>{formatAmount(deposit.amount, deposit.currency)}</div></div>
            <div><span className="muted">Gross</span><div>{formatAmount(deposit.grossAmount, deposit.currency)}</div></div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <h3>Status history</h3>
        <ul>
          {(refund.statusHistory || []).map((h, i) => (
            <li key={i}>{formatDate(h.at)} — <strong>{h.status}</strong> by {h.by}{h.reason ? ` (${h.reason})` : ''}</li>
          ))}
        </ul>
      </div>

      <div style={{ marginTop: 20 }}>
        <h3>Ledger</h3>
        {ledger.length === 0 ? <p className="muted">No ledger entries.</p> : (
          <table className="data-table">
            <thead>
              <tr><th>Type</th><th>Amount</th><th>Before</th><th>After</th><th>At</th></tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <td>{l.type}</td>
                  <td>{formatAmount(l.amount, l.currency || refund.currency)}</td>
                  <td>{l.balanceBefore}</td>
                  <td>{l.balanceAfter}</td>
                  <td>{formatDate(l.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onReconcile}>
          {busy ? 'Reconciling…' : 'Reconcile with Stripe'}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>

      {refund.reconciliationResult && (
        <pre style={{ marginTop: 16, background: '#f5f7fa', padding: 12, borderRadius: 8 }}>
          {JSON.stringify(refund.reconciliationResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
