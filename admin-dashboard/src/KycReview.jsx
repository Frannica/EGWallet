import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchPendingKyc,
  fetchKycDocumentBlob,
  approveKycDocument,
  rejectKycDocument,
  hasPermission,
} from './api';
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function KycReview({ focusDocumentId, onClearFocus, onViewUser }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(focusDocumentId || null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [approveTier, setApproveTier] = useState(1);
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchPendingKyc();
      setDocuments(data.documents || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (focusDocumentId) setSelectedId(focusDocumentId);
  }, [focusDocumentId]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const canApprove = hasPermission('kyc:approve');
  const selected = documents.find((d) => d.id === selectedId) || null;

  async function handlePreview(docId) {
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = await fetchKycDocumentBlob(docId);
      setPreviewUrl(url);
      setSelectedId(docId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleApprove() {
    if (!selected) return;
    setActionLoading(true);
    setError('');
    try {
      await approveKycDocument(selected.id, approveTier);
      await load();
      setSelectedId(null);
      onClearFocus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject() {
    if (!selected) return;
    if (!rejectReason.trim()) {
      setError('Rejection reason is required.');
      return;
    }
    setActionLoading(true);
    setError('');
    try {
      await rejectKycDocument(selected.id, rejectReason.trim());
      setRejectReason('');
      await load();
      setSelectedId(null);
      onClearFocus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">KYC Review</h2>
      <p className="muted">Pending submissions requiring admin review.</p>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading…</p>}

      <div className="kyc-review-layout">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>User</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className={selectedId === doc.id ? 'row-selected' : ''}>
                  <td>{doc.type}</td>
                  <td>
                    <button className="link-btn" onClick={() => onViewUser?.(doc.userId)}>{doc.userId.slice(0, 8)}…</button>
                  </td>
                  <td>{formatDate(doc.uploadedAt)}</td>
                  <td>{doc.status}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => handlePreview(doc.id)}>View</button>
                  </td>
                </tr>
              ))}
              {!loading && documents.length === 0 && (
                <tr><td colSpan={5} className="muted">No pending KYC submissions.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="kyc-review-panel">
            <h3>Review Document</h3>
            <p className="mono">{selected.id}</p>
            {previewUrl && (
              <div className="doc-preview">
                <img src={previewUrl} alt="KYC document" />
              </div>
            )}
            {canApprove ? (
              <>
                <label className="form-label">Approve tier (0–3)</label>
                <input
                  type="number"
                  min="0"
                  max="3"
                  className="form-input"
                  value={approveTier}
                  onChange={(e) => setApproveTier(Number(e.target.value))}
                />
                <button className="btn btn-primary" disabled={actionLoading} onClick={handleApprove} style={{ marginTop: 12 }}>
                  Approve KYC
                </button>
                <hr className="divider" />
                <label className="form-label">Rejection reason</label>
                <textarea
                  className="form-input"
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason shown internally for audit"
                />
                <button className="btn btn-danger" disabled={actionLoading} onClick={handleReject} style={{ marginTop: 12 }}>
                  Reject KYC
                </button>
              </>
            ) : (
              <p className="muted">Compliance role required to approve or reject KYC.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
