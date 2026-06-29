import React, { useState } from 'react';
import { hasPermission } from '../api';
import { copyText } from '../utils/ui';

export default function GlobalSearchBar({ onSelectUser, onSelectTransaction }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!hasPermission('search:read')) return null;

  async function runSearch(q) {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const { globalSearch } = await import('../api');
      const data = await globalSearch(q);
      setResults(data.results || []);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="global-search">
      <input
        className="global-search-input"
        placeholder="Search name, email, wallet, phone, tx ID…"
        value={query}
        onChange={(e) => runSearch(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
      />
      {loading && <span className="global-search-hint">…</span>}
      {open && results.length > 0 && (
        <ul className="search-results global-search-results">
          {results.map((r) => (
            <li key={`${r.type}-${r.id}`}>
              <button
                type="button"
                className="search-result-btn"
                onClick={() => {
                  setOpen(false);
                  if (r.type === 'user') onSelectUser?.(r.id);
                  else onSelectTransaction?.(r);
                }}
              >
                <strong>{r.type === 'user' ? r.email : r.id}</strong>
                <span>{r.matchType}</span>
                {r.type === 'user' && r.walletIds?.[0] && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => { e.stopPropagation(); copyText(r.walletIds[0], 'Wallet ID'); }}
                  >
                    Copy wallet
                  </button>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
