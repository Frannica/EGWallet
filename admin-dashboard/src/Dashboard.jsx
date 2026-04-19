import React, { useState } from 'react';
import WithdrawalTable from './WithdrawalTable';
import WithdrawalDetails from './WithdrawalDetails';
import { logout } from './api';

export default function Dashboard({ onLogout }) {
  const [selectedId, setSelectedId] = useState(null);

  function handleLogout() {
    logout();
    onLogout();
  }

  return (
    <div className="dashboard">
      <header className="header">
        <span className="header-title">EGWallet — Withdrawal Admin</span>
        <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
      </header>
      <main className="main-content">
        {selectedId ? (
          <WithdrawalDetails
            id={selectedId}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <WithdrawalTable onSelect={setSelectedId} />
        )}
      </main>
    </div>
  );
}
