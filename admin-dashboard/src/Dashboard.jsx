import React, { useState, useEffect } from 'react';
import WithdrawalTable from './WithdrawalTable';
import WithdrawalDetails from './WithdrawalDetails';
import UsersList from './UsersList';
import UserDetail from './UserDetail';
import UserTimeline from './UserTimeline';
import KycReview from './KycReview';
import DashboardHome from './DashboardHome';
import QuickSearch from './QuickSearch';
import SystemLogs from './SystemLogs';
import SettingsPage from './SettingsPage';
import { logout, fetchMe, getAdminProfile, hasPermission } from './api';

const ALL_TABS = [
  { id: 'home', label: 'Home', perm: 'stats:read' },
  { id: 'users', label: 'Users', perm: 'users:read' },
  { id: 'kyc', label: 'KYC Review', perm: 'kyc:read' },
  { id: 'withdrawals', label: 'Withdrawals', perm: 'withdrawals:read' },
  { id: 'logs', label: 'System Logs', perm: 'logs:read' },
  { id: 'settings', label: 'Settings', perm: 'settings:read' },
];

export default function Dashboard({ onLogout }) {
  const [tab, setTab] = useState('home');
  const [admin, setAdmin] = useState(getAdminProfile());
  const [selectedWithdrawalId, setSelectedWithdrawalId] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [timelineUserId, setTimelineUserId] = useState(null);
  const [focusKycDocumentId, setFocusKycDocumentId] = useState(null);

  useEffect(() => {
    fetchMe().then(setAdmin).catch(() => {});
  }, []);

  const visibleTabs = ALL_TABS.filter((t) => hasPermission(t.perm));

  function handleLogout() {
    logout();
    onLogout();
  }

  function switchTab(nextTab) {
    setTab(nextTab);
    setSelectedWithdrawalId(null);
    setSelectedUserId(null);
    setTimelineUserId(null);
    setFocusKycDocumentId(null);
  }

  function selectUser(id) {
    setSelectedUserId(id);
    setTimelineUserId(null);
    setTab('users');
  }

  return (
    <div className="dashboard">
      <header className="header">
        <span className="header-title">EGWallet Admin Dashboard</span>
        <div className="header-right">
          {admin && (
            <span className="header-admin">{admin.email} · {admin.role?.replace('_', ' ')}</span>
          )}
          <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <nav className="nav-tabs">
        {visibleTabs.map((item) => (
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
        {tab === 'home' && (
          <>
            <DashboardHome onNavigate={switchTab} />
            {hasPermission('search:read') && (
              <div style={{ marginTop: 24 }}>
                <QuickSearch onSelectUser={selectUser} />
              </div>
            )}
          </>
        )}

        {tab === 'users' && timelineUserId && (
          <UserTimeline userId={timelineUserId} onBack={() => setTimelineUserId(null)} />
        )}

        {tab === 'users' && !timelineUserId && !selectedUserId && (
          <UsersList onSelectUser={(id) => setSelectedUserId(id)} />
        )}

        {tab === 'users' && !timelineUserId && selectedUserId && (
          <UserDetail
            userId={selectedUserId}
            onBack={() => setSelectedUserId(null)}
            onViewTimeline={(id) => setTimelineUserId(id)}
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
            onViewUser={selectUser}
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

        {tab === 'logs' && <SystemLogs />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      <footer className="site-footer">
        <a href="/privacy-policy">Privacy Policy</a>
      </footer>
    </div>
  );
}
