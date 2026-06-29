import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchAnnouncements,
  sendNotification,
  broadcastAnnouncement,
  hasPermission,
} from './api';
import { showToast } from './utils/ui';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const AUDIENCE_OPTIONS = [
  { value: 'user_ids', label: 'Individual / selected users' },
  { value: 'all', label: 'All users' },
  { value: 'country', label: 'Users by country' },
  { value: 'kyc_tier', label: 'Users by KYC tier' },
  { value: 'account_status', label: 'Users by account status' },
];

export default function NotificationsPage() {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('all');
  const [userIds, setUserIds] = useState('');
  const [country, setCountry] = useState('');
  const [kycTier, setKycTier] = useState('0');
  const [accountStatus, setAccountStatus] = useState('active');
  const [notifType, setNotifType] = useState('admin_message');
  const canWrite = hasPermission('notifications:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAnnouncements();
      setAnnouncements(data.announcements || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function buildPayload() {
    const payload = { title, body, audience };
    if (audience === 'user_ids') {
      payload.userIds = userIds.split(/[\s,]+/).filter(Boolean);
    }
    if (audience === 'country') payload.country = country.trim();
    if (audience === 'kyc_tier') payload.kycTier = Number(kycTier);
    if (audience === 'account_status') payload.accountStatus = accountStatus;
    return payload;
  }

  async function handleSend(e) {
    e.preventDefault();
    setError('');
    try {
      const result = await sendNotification({ ...buildPayload(), type: notifType });
      showToast(`Sent to ${result.recipientCount} user(s)`);
      setTitle('');
      setBody('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBroadcast(e) {
    e.preventDefault();
    setError('');
    try {
      const result = await broadcastAnnouncement({
        ...buildPayload(),
        type: notifType === 'maintenance' ? 'maintenance' : 'announcement',
      });
      showToast(`Broadcast to ${result.recipientCount} user(s)`);
      setTitle('');
      setBody('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h2 className="page-title">Notifications & Announcements</h2>
      {error && <p className="error-text">{error}</p>}

      {canWrite && (
        <form className="detail-section" onSubmit={handleSend}>
          <h3>Send Notification</h3>
          <label className="form-label">Type</label>
          <select className="form-input" value={notifType} onChange={(e) => setNotifType(e.target.value)}>
            <option value="admin_message">Admin message</option>
            <option value="maintenance">Maintenance</option>
            <option value="announcement">Announcement</option>
          </select>

          <label className="form-label">Audience</label>
          <select className="form-input" value={audience} onChange={(e) => setAudience(e.target.value)}>
            {AUDIENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          {audience === 'user_ids' && (
            <>
              <label className="form-label">User IDs (comma-separated)</label>
              <input className="form-input" value={userIds} onChange={(e) => setUserIds(e.target.value)} placeholder="uuid1, uuid2…" />
            </>
          )}
          {audience === 'country' && (
            <>
              <label className="form-label">Country / region code</label>
              <input className="form-input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="GQ" />
            </>
          )}
          {audience === 'kyc_tier' && (
            <>
              <label className="form-label">KYC tier</label>
              <select className="form-input" value={kycTier} onChange={(e) => setKycTier(e.target.value)}>
                {[0, 1, 2, 3].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </>
          )}
          {audience === 'account_status' && (
            <>
              <label className="form-label">Account status</label>
              <select className="form-input" value={accountStatus} onChange={(e) => setAccountStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="locked">Locked</option>
              </select>
            </>
          )}

          <label className="form-label">Title</label>
          <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <label className="form-label">Message</label>
          <textarea className="form-input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} required />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="submit" className="btn btn-primary">Send Notification</button>
            <button type="button" className="btn btn-secondary" onClick={handleBroadcast}>Broadcast Announcement</button>
          </div>
        </form>
      )}

      <section className="detail-section">
        <h3>Recent Broadcasts</h3>
        {loading && <p className="muted">Loading…</p>}
        {announcements.map((a) => (
          <div key={a.id} className="note-item">
            <strong>{a.title}</strong>
            <span className="muted"> · {a.type} · {a.recipientCount} users · {formatDate(a.createdAt)}</span>
            <p>{a.body}</p>
          </div>
        ))}
        {!loading && announcements.length === 0 && <p className="empty-text">No broadcasts yet.</p>}
      </section>
    </div>
  );
}
