import React, { useState, useEffect, useCallback } from 'react';
import { searchUsers } from './api';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function QuickSearch({ onSelectUser }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const runSearch = useCallback(async (q) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const data = await searchUsers(q);
      setResults(data.users || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runSearch(query), 300);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  return (
    <div className="quick-search">
      <label className="form-label">Instant user search</label>
      <input
        className="form-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Email, username, wallet ID…"
      />
      {loading && <p className="muted">Searching…</p>}
      {results.length > 0 && (
        <ul className="search-results">
          {results.map((user) => (
            <li key={user.id}>
              <button type="button" className="search-result-btn" onClick={() => onSelectUser(user.id)}>
                <strong>{user.email}</strong>
                <span>{user.username || user.fullName || user.id.slice(0, 8)}</span>
                <span className={`badge badge-${user.kycStatus || 'pending'}`}>{user.accountStatus || 'active'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
