import React, { useState, useEffect } from 'react';
import { fetchSystemLogs } from './api';

export default function SystemLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchSystemLogs(150);
        setLogs(data.logs || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <h2 className="page-title">System Logs</h2>
      <p className="muted">Recent backend errors from server log files.</p>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      <div className="log-viewer">
        {logs.map((line, i) => (
          <pre key={i} className="log-line">{line}</pre>
        ))}
        {!loading && logs.length === 0 && <p className="muted">No error logs found.</p>}
      </div>
    </div>
  );
}
