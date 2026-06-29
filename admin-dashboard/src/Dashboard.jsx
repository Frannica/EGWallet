import React, { useState } from 'react';
import WithdrawalTable from './WithdrawalTable';
import WithdrawalDetails from './WithdrawalDetails';
import UsersList from './UsersList';
import UserDetail from './UserDetail';
import KycReview from './KycReview';
import { logout } from './api';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'kyc', label: 'KYC Review' },
  { id: 'withdrawals', label: 'Withdrawals' },
];

export default function Dashboard({ onLogout }) {
  const [tab, setTab] = useState('users');
  const [selectedWithdrawalId, setSelectedWithdrawalId] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [focusKycDocumentId, setFocusKycDocumentId] = useState(null);

  function handleLogout() {
    logout();
    onLogout();
  }

  function switchTab(nextTab) {
    setTab(nextTab);
    setSelectedWithdrawalId(null);
    setSelectedUserId(null);
    setFocusKycDocumentId(null);
  }

  return (
    <div className="dashboard">
      <header className="header">
        <span className="header-title">EGWallet Admin Dashboard</span>
        <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
      </header>

      <nav className="nav-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`nav-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => switchTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {tab === 'users' && !selectedUserId && (
          <UsersList onSelectUser={(id) => setSelectedUserId(id)} />
        )}

        {tab === 'users' && selectedUserId && (
          <UserDetail
            userId={selectedUserId}
            onBack={() => setSelectedUserId(null)}
            onReviewKyc={(docId) => {
              setFocusKycDocumentId(docId);
              setSelectedUserId(null);
              setTab('kyc');
            }}
          />
        )}

        {tab === 'kyc' && (
          <KycReview
            focusDocumentId={focusKycDocumentId}
            onClearFocus={() => setFocusKycDocumentId(null)}
            onViewUser={(userId) => {
              setTab('users');
              setSelectedUserId(userId);
              setFocusKycDocumentId(null);
            }}
          />
        )}

        {tab === 'withdrawals' && (
          selectedWithdrawalId ? (
            <WithdrawalDetails
              id={selectedWithdrawalId}
              onBack={() => setSelectedWithdrawalId(null)}
            />
          ) : (
            <WithdrawalTable onSelect={setSelectedWithdrawalId} />
          )
        )}
      </main>

      <footer className="site-footer">
        <a href="/privacy-policy">Privacy Policy</a>
      </footer>
    </div>
  );
}
