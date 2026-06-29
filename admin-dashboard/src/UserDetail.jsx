import React, { useState, useEffect } from 'react';
import { fetchUserById, fetchKycDocumentBlob } from './api';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString()} ${currency || ''}`;
}

export default function UserDetail({ userId, onBack, onReviewKyc }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const detail = await fetchUserById(userId);
        if (!cancelled) setData(detail);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function handlePreviewDocument(docId) {
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = await fetchKycDocumentBlob(docId);
      setPreviewUrl(url);
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <p className="muted">Loading user…</p>;
  if (error && !data) return <p className="error-text">{error}</p>;
  if (!data) return null;

  const { profile, wallets, transactions, paymentRequests, withdrawals, kycDocuments, riskFlags } = data;

  return (
    <div>
      <button className="btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>← Back to users</button>
      <h2 className="page-title">User Detail</h2>
      {error && <p className="error-text">{error}</p>}

      <section className="detail-section">
        <h3>Profile</h3>
        <div className="detail-grid">
          <div><strong>Email</strong><div>{profile.email}</div></div>
          <div><strong>Username</strong><div>{profile.username || '—'}</div></div>
          <div><strong>Name</strong><div>{profile.fullName || '—'}</div></div>
          <div><strong>Role</strong><div>{profile.role}</div></div>
          <div><strong>KYC Status</strong><div>{profile.kycStatus}</div></div>
          <div><strong>KYC Tier</strong><div>{profile.kycTier}</div></div>
          <div><strong>Created</strong><div>{formatDate(profile.createdAt)}</div></div>
          <div><strong>User ID</strong><div className="mono">{profile.id}</div></div>
        </div>
      </section>

      {riskFlags?.length > 0 && (
        <section className="detail-section">
          <h3>Risk / Account Flags</h3>
          <ul className="flag-list">
            {riskFlags.map((flag, i) => (
              <li key={i} className={`flag-item flag-${flag.severity}`}>{flag.type}{flag.count ? ` (${flag.count})` : ''}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="detail-section">
        <h3>Wallet Balances <span className="read-only-tag">Read-only</span></h3>
        {wallets.map((wallet) => (
          <div key={wallet.id} className="wallet-card">
            <div className="mono">{wallet.id}</div>
            {(wallet.balances || []).map((b) => (
              <div key={b.currency}>{formatAmount(b.amount, b.currency)}</div>
            ))}
          </div>
        ))}
        {wallets.length === 0 && <p className="muted">No wallets.</p>}
      </section>

      <section className="detail-section">
        <h3>Recent Transactions <span className="read-only-tag">Read-only</span></h3>
        <div className="table-wrap">
          <table className="data-table compact">
            <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {(transactions || []).map((tx) => (
                <tr key={tx.id}>
                  <td>{formatDate(tx.createdAt)}</td>
                  <td>{tx.type}</td>
                  <td>{formatAmount(tx.amount, tx.currency)}</td>
                  <td>{tx.status || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="detail-section">
        <h3>Payment Requests <span className="read-only-tag">Read-only</span></h3>
        <div className="table-wrap">
          <table className="data-table compact">
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Memo</th></tr></thead>
            <tbody>
              {(paymentRequests || []).map((pr) => (
                <tr key={pr.id}>
                  <td>{formatDate(pr.createdAt)}</td>
                  <td>{formatAmount(pr.amount, pr.currency)}</td>
                  <td>{pr.status}</td>
                  <td>{pr.memo || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="detail-section">
        <h3>Withdrawals <span className="read-only-tag">Read-only</span></h3>
        <div className="table-wrap">
          <table className="data-table compact">
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Method</th></tr></thead>
            <tbody>
              {(withdrawals || []).map((w) => (
                <tr key={w.id}>
                  <td>{formatDate(w.createdAt)}</td>
                  <td>{formatAmount(w.amount, w.currency)}</td>
                  <td>{w.status}</td>
                  <td>{w.method || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="detail-section">
        <h3>KYC Documents</h3>
        {(kycDocuments || []).map((doc) => (
          <div key={doc.id} className="kyc-doc-row">
            <div>
              <strong>{doc.type}</strong>
              <div className="muted">{doc.status} · {formatDate(doc.uploadedAt)}</div>
            </div>
            <div className="kyc-doc-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => handlePreviewDocument(doc.id)}>View</button>
              {doc.status === 'under_review' && (
                <button className="btn btn-primary btn-sm" onClick={() => onReviewKyc(doc.id)}>Review</button>
              )}
            </div>
          </div>
        ))}
        {previewUrl && (
          <div className="doc-preview">
            <img src={previewUrl} alt="KYC document preview" />
          </div>
        )}
        {(kycDocuments || []).length === 0 && <p className="muted">No KYC documents uploaded.</p>}
      </section>
    </div>
  );
}
