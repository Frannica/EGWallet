import React, { useState, useEffect, useCallback } from 'react';
import { fetchUsers } from './api';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function UsersList({ onSelectUser }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (search = query) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchUsers(search);
      setUsers(data.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(''); }, []); // eslint-disable-line

  function handleSearch(e) {
    e.preventDefault();
    load(query);
  }

  return (
    <div>
      <h2 className="page-title">Users</h2>
      <form className="filter-bar" onSubmit={handleSearch}>
        <div className="filter-group" style={{ flex: 1 }}>
          <label className="form-label">Search email, username, or wallet ID</label>
          <input
            className="form-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>Search</button>
      </form>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading…</p>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Username</th>
              <th>KYC Status</th>
              <th>KYC Tier</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.fullName || '—'}</td>
                <td>{user.email}</td>
                <td>{user.username || '—'}</td>
                <td><span className={`badge badge-${user.kycStatus || 'pending'}`}>{user.kycStatus || 'pending'}</span></td>
                <td>{user.kycTier ?? 0}</td>
                <td>{formatDate(user.createdAt)}</td>
                <td>
                  <button className="btn btn-secondary btn-sm" onClick={() => onSelectUser(user.id)}>View</button>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={7} className="muted">No users found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
