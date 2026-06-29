import React, { useState, useEffect } from 'react';
import {
  fetchUserById,
  fetchKycDocumentBlob,
  fetchUserNotes,
  addUserNote,
  suspendUser,
  unsuspendUser,
  lockUser,
  unlockUser,
  resetFailedLogins,
  exportUserCsv,
  hasPermission,
} from './api';
import { confirmAction, copyText, showToast } from './utils/ui';
import { normalizeWalletBalances } from './currencies';
import KycDocumentViewer from './components/KycDocumentViewer';
import UserLimitsPanel from './components/UserLimitsPanel';
import UserActivityPanel from './components/UserActivityPanel';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function formatAmount(amount, currency) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString()} ${currency || ''}`;
}

export default function UserDetail({ userId, onBack, onReviewKyc, onViewTimeline }) {
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null);
  const [selectedDocId, setSelectedDocId] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const canWrite = hasPermission('users:write');
  const canNote = hasPermission('notes:write');

  async function reload() {
    const detail = await fetchUserById(userId);
    setData(detail);
    if (hasPermission('notes:read')) {
      try {
        const notesData = await fetchUserNotes(userId);
        setNotes(notesData.notes || detail.notes || []);
      } catch {
        setNotes(detail.notes || []);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        await reload();
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

  async function runAction(action, confirmMsg) {
    const ok = await confirmAction(confirmMsg, 'Confirm action');
    if (!ok) return;
    setActionLoading(true);
    setError('');
    try {
      await action();
      await reload();
      showToast('Action completed', 'success');
    } catch (err) {
      setError(err.message);
      showToast(err.message, 'error');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAddNote(e) {
    e.preventDefault();
    if (!noteText.trim()) return;
    await runAction(async () => {
      await addUserNote(userId, noteText.trim());
      setNoteText('');
    });
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError('');
    try {
      await reload();
      showToast('User data refreshed', 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }
  async function handlePreviewDocument(docId) {
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = await fetchKycDocumentBlob(docId);
      setPreviewUrl(url);
      setSelectedDocId(docId);
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <p className="muted">Loading user…</p>;
  if (error && !data) return <p className="error-text">{error}</p>;
  if (!data) return null;

  const { profile, wallets, kycDocuments, riskFlags, limits, activityCounts, syncHint } = data;
  const status = profile.accountStatus || 'active';

  return (
    <div>
      <button className="btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>← Back to users</button>
      <div className="detail-header-row">
        <h2 className="page-title">User Detail</h2>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyText(profile.id, 'User ID')}>Copy User ID</button>
          {wallets?.[0] && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyText(wallets[0].id, 'Wallet ID')}>Copy Wallet ID</button>
          )}
          {hasPermission('users:export') && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => exportUserCsv(userId).then(() => showToast('CSV exported', 'success'))}>Export CSV</button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onViewTimeline?.(userId)}>Timeline</button>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      {syncHint && <p className="sync-hint">{syncHint}</p>}

      {canWrite && (
        <section className="detail-section support-tools">
          <h3>Support Tools</h3>
          <div className="btn-row">
            {status !== 'suspended' ? (
              <button type="button" className="btn btn-danger btn-sm" disabled={actionLoading} onClick={() => runAction(() => suspendUser(userId), 'Suspend this user account?')}>Suspend</button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={actionLoading} onClick={() => runAction(() => unsuspendUser(userId), 'Unsuspend this user account?')}>Unsuspend</button>
            )}
            {status !== 'locked' ? (
              <button type="button" className="btn btn-danger btn-sm" disabled={actionLoading} onClick={() => runAction(() => lockUser(userId), 'Lock this user account?')}>Lock</button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={actionLoading} onClick={() => runAction(() => unlockUser(userId), 'Unlock this user account?')}>Unlock</button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" disabled={actionLoading} onClick={() => runAction(() => resetFailedLogins(userId), 'Reset failed login attempts?')}>Reset Failed Logins</button>
          </div>
          <p className="muted">Status: <strong>{status}</strong> · Failed attempts: {profile.failedLoginAttempts || 0}</p>
        </section>
      )}

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
        <h3>Internal Notes</h3>
        {(notes || []).map((n) => (
          <div key={n.id} className="note-item">
            <div className="note-meta">{n.adminEmail} · {formatDate(n.createdAt)}</div>
            <div>{n.note}</div>
          </div>
        ))}
        {canNote && (
          <form onSubmit={handleAddNote} style={{ marginTop: 12 }}>
            <textarea className="form-input" rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add internal note…" />
            <button type="submit" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={actionLoading}>Add Note</button>
          </form>
        )}
      </section>

      <section className="detail-section">
        <h3>Wallet Balances <span className="read-only-tag">Read-only</span></h3>
        {wallets.map((wallet) => (
          <div key={wallet.id} className="wallet-card">
            <div className="mono wallet-id-label">{wallet.id}</div>
            <div className="wallet-balance-grid">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th>Name</th>
                    <th>Balance (minor units)</th>
                  </tr>
                </thead>
                <tbody>
                  {normalizeWalletBalances(wallet.balances).map((b) => (
                    <tr key={b.currency} className={b.amount === 0 ? 'balance-zero' : ''}>
                      <td className="mono">{b.currency}</td>
                      <td>{b.name}</td>
                      <td>{formatAmount(b.amount, b.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {wallets.length === 0 && <p className="muted">No wallets.</p>}
      </section>

      <UserLimitsPanel limits={limits} />

      <UserActivityPanel userId={userId} activityCounts={activityCounts} />

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
              {doc.status === 'under_review' && hasPermission('kyc:approve') && (
                <button className="btn btn-primary btn-sm" onClick={() => onReviewKyc(doc.id)}>Review</button>
              )}
            </div>
          </div>
        ))}
        {previewUrl && selectedDocId && (
          <KycDocumentViewer blobUrl={previewUrl} documentId={selectedDocId} onClose={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); setSelectedDocId(null); }} />
        )}
        {(kycDocuments || []).length === 0 && <p className="muted">No KYC documents uploaded.</p>}
      </section>
    </div>
  );
}
