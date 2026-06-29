import React, { useState, useEffect } from 'react';
import WithdrawalTable from './WithdrawalTable';
import WithdrawalDetails from './WithdrawalDetails';
import UsersList from './UsersList';
import UserDetail from './UserDetail';
import UserTimeline from './UserTimeline';
import KycReview from './KycReview';
import DashboardHome from './DashboardHome';
import SystemLogs from './SystemLogs';
import SettingsPage from './SettingsPage';
import HealthPage from './HealthPage';
import SupportTickets from './SupportTickets';
import DisputesPage from './DisputesPage';
import NotificationsPage from './NotificationsPage';
import FraudPage from './FraudPage';
import AuditPage from './AuditPage';
import GlobalSearchBar from './components/GlobalSearchBar';
import ToastContainer from './components/ToastContainer';
import ConfirmDialog from './components/ConfirmDialog';
import { logout, fetchMe, getAdminProfile, hasPermission, toggleTheme, initTheme } from './api';
import { useInactivityLogout, useHeartbeat } from './hooks/useSession';

const ALL_TABS = [
  { id: 'home', label: 'Home', perm: 'stats:read' },
  { id: 'users', label: 'Users', perm: 'users:read' },
  { id: 'kyc', label: 'KYC Review', perm: 'kyc:read' },
  { id: 'withdrawals', label: 'Withdrawals', perm: 'withdrawals:read' },
  { id: 'support', label: 'Support', perm: 'tickets:read' },
  { id: 'disputes', label: 'Disputes', perm: 'disputes:read' },
  { id: 'fraud', label: 'Fraud', perm: 'fraud:read' },
  { id: 'notifications', label: 'Notifications', perm: 'notifications:read' },
  { id: 'audit', label: 'Audit', perm: 'audit:read' },
  { id: 'health', label: 'Health', perm: 'health:read' },
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
  const [focusTransactionId, setFocusTransactionId] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('adminTheme') || 'light');

  useEffect(() => { initTheme(); }, []);
  useInactivityLogout(onLogout);
  useHeartbeat();

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
    setFocusTransactionId(null);
  }

  function selectUser(id) {
    setSelectedUserId(id);
    setTimelineUserId(null);
    setFocusTransactionId(null);
    setTab('users');
  }

  function selectTransaction(result) {
    if (result?.userId) {
      selectUser(result.userId);
    }
  }

  return (
    <div className="dashboard">
      <header className="header">
        <span className="header-title">EGWallet Admin</span>
        <GlobalSearchBar onSelectUser={selectUser} onSelectTransaction={selectTransaction} />
        <div className="header-right">
          {admin && (
            <span className="header-admin">{admin.email} · {admin.role?.replace(/_/g, ' ')}</span>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTheme(toggleTheme())} title="Toggle dark mode">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <nav className="nav-tabs">
        {visibleTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => switchTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {tab === 'home' && <DashboardHome onNavigate={switchTab} />}

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
            <WithdrawalDetails id={selectedWithdrawalId} onBack={() => setSelectedWithdrawalId(null)} />
          ) : (
            <WithdrawalTable onSelect={setSelectedWithdrawalId} />
          )
        )}

        {tab === 'support' && (
          <SupportTickets onViewUser={selectUser} />
        )}

        {tab === 'disputes' && (
          <DisputesPage onViewUser={selectUser} />
        )}

        {tab === 'fraud' && (
          <FraudPage onViewUser={selectUser} />
        )}

        {tab === 'notifications' && (
          <NotificationsPage />
        )}

        {tab === 'audit' && <AuditPage />}
        {tab === 'health' && <HealthPage />}
        {tab === 'logs' && <SystemLogs />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      <footer className="site-footer"><a href="/privacy-policy">Privacy Policy</a></footer>
      <ToastContainer />
      <ConfirmDialog />
    </div>
  );
}
