import React, { useState, useEffect, useCallback } from 'react';
import { fetchWithdrawalById } from './api';

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

function Row({ label, value }) {
  return (
    <tr>
      <td className="detail-label">{label}</td>
      <td className="detail-value">{value ?? '—'}</td>
    </tr>
  );
}

export default function WithdrawalDetails({ id, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchWithdrawalById(id);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="loading-text">Loading withdrawal…</p>;
  if (error) return (
    <div>
      <button className="btn btn-secondary" onClick={onBack}>← Back</button>
      <p className="error-text" style={{ marginTop: 12 }}>{error}</p>
    </div>
  );
  if (!data) return null;

  const w = data.withdrawal || data;
  const ledger = data.ledgerEntries || [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>
          Withdrawal <span className="mono">{w.id}</span>
        </h2>
        <span className={`badge ${STATUS_BADGE[w.status] || ''}`}>{w.status}</span>
      </div>

      <div className="detail-grid">
        {/* Core info */}
        <section className="detail-section">
          <h3 className="section-title">Core</h3>
          <table className="detail-table">
            <tbody>
              <Row label="Withdrawal ID" value={<span className="mono">{w.id}</span>} />
              <Row label="User ID" value={<span className="mono">{w.userId}</span>} />
              <Row label="Amount" value={`${Number(w.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${w.currency}`} />
              <Row label="Method" value={w.method} />
              <Row label="Country" value={w.country} />
              <Row label="Created" value={formatDate(w.createdAt)} />
              <Row label="Updated" value={formatDate(w.updatedAt)} />
              {w.paidAt && <Row label="Paid At" value={formatDate(w.paidAt)} />}
              {w.failedAt && <Row label="Failed At" value={formatDate(w.failedAt)} />}
              {w.reversedAt && <Row label="Reversed At" value={formatDate(w.reversedAt)} />}
              <Row label="Idempotency Key" value={<span className="mono small">{w.idempotencyKey}</span>} />
              {w.payoutProvider  && <Row label="Provider"        value={w.payoutProvider} />}
              {w.payoutReference && <Row label="Payout Reference" value={<span className="mono">{w.payoutReference}</span>} />}
              {w.payoutError     && <Row label="Payout Error"     value={<span style={{ color: '#e63946' }}>{w.payoutError}</span>} />}
            </tbody>
          </table>
        </section>

        {/* Bank fields */}
        <section className="detail-section">
          <h3 className="section-title">Bank Details</h3>
          <table className="detail-table">
            <tbody>
              {w.accountHolderName && <Row label="Account Holder" value={w.accountHolderName} />}
              {w.bankName && <Row label="Bank Name" value={w.bankName} />}
              {w.accountNumber && <Row label="Account Number" value={<span className="mono">{w.accountNumber}</span>} />}
              {w.bankCode && <Row label="Bank Code" value={<span className="mono">{w.bankCode}</span>} />}
              {w.branchCode && <Row label="Branch Code" value={<span className="mono">{w.branchCode}</span>} />}
              {w.iban && <Row label="IBAN" value={<span className="mono">{w.iban}</span>} />}
              {w.swiftBic && <Row label="SWIFT/BIC" value={<span className="mono">{w.swiftBic}</span>} />}
              {w.cardLast4 && <Row label="Card Last 4" value={<span className="mono">•••• {w.cardLast4}</span>} />}
            </tbody>
          </table>
        </section>

        {/* Status history */}
        {w.statusHistory && w.statusHistory.length > 0 && (
          <section className="detail-section">
            <h3 className="section-title">Status History</h3>
            <table className="detail-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>By</th>
                  <th>Note</th>
                  <th>At</th>
                </tr>
              </thead>
              <tbody>
                {w.statusHistory.map((h, i) => (
                  <tr key={i}>
                    <td><span className={`badge ${STATUS_BADGE[h.from] || ''}`}>{h.from || '—'}</span></td>
                    <td><span className={`badge ${STATUS_BADGE[h.to] || ''}`}>{h.to}</span></td>
                    <td className="mono small">{h.by || '—'}</td>
                    <td>{h.note || '—'}</td>
                    <td>{formatDate(h.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Ledger entries */}
        {ledger.length > 0 && (
          <section className="detail-section">
            <h3 className="section-title">Ledger Entries</h3>
            <table className="detail-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Currency</th>
                  <th>At</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e, i) => (
                  <tr key={i}>
                    <td>{e.type}</td>
                    <td className={e.amount < 0 ? 'amount-negative' : 'amount-positive'}>
                      {Number(e.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td>{e.currency}</td>
                    <td>{formatDate(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

    </div>
  );
}
