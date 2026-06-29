import React, { useState, useEffect } from 'react';
import { fetchUserTimeline } from './api';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const TYPE_LABELS = {
  login: 'Login',
  deposit: 'Deposit',
  transfer: 'Transfer',
  transaction: 'Transaction',
  withdrawal: 'Withdrawal',
  payment_request: 'Payment Request',
  kyc: 'KYC',
  admin_action: 'Admin Action',
};

export default function UserTimeline({ userId, onBack }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await fetchUserTimeline(userId);
        setEvents(data.events || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  return (
    <div>
      <button className="btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>← Back</button>
      <h2 className="page-title">Support Timeline</h2>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading timeline…</p>}

      <div className="timeline">
        {events.map((event, i) => (
          <div key={`${event.type}-${event.timestamp}-${i}`} className={`timeline-item timeline-${event.type}`}>
            <div className="timeline-dot" />
            <div className="timeline-content">
              <div className="timeline-header">
                <span className="timeline-type">{TYPE_LABELS[event.type] || event.type}</span>
                <span className="timeline-date">{formatDate(event.timestamp)}</span>
              </div>
              <div className="timeline-summary">{event.summary}</div>
            </div>
          </div>
        ))}
        {!loading && events.length === 0 && <p className="muted">No timeline events.</p>}
      </div>
    </div>
  );
}
