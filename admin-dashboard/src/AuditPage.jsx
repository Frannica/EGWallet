import React, { useState, useEffect } from 'react';
import { fetchAuditLog } from './api';
import { SkeletonLines } from './components/Skeleton';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function AuditPage() {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchAuditLog(150);
        setActions(data.actions || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <SkeletonLines count={8} />;
  if (error) return <p className="error-text">{error}</p>;

  return (
    <div>
      <h2 className="page-title">Audit Log</h2>
      <p className="muted">Every admin action with admin, IP, browser, timestamp, and before/after values.</p>
      <div className="table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Time</th>
              <th>Admin</th>
              <th>Action</th>
              <th>IP</th>
              <th>Browser</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td>{formatDate(a.timestamp)}</td>
                <td>{a.admin}</td>
                <td>{a.action}</td>
                <td className="mono">{a.ipAddress}</td>
                <td>{a.browser}</td>
                <td><code className="audit-json">{a.before ? JSON.stringify(a.before) : '—'}</code></td>
                <td><code className="audit-json">{a.after ? JSON.stringify(a.after) : '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
