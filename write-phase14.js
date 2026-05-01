'use strict';
const fs = require('fs');
const outPath = require('path').join(__dirname, '__tests__/regression/phase14.test.js');

const content = `'use strict';

const fs   = require('fs');
const path = require('path');

const lb   = fs.readFileSync(path.resolve(__dirname, '../../src/utils/localBalance.ts'), 'utf8');
const send = fs.readFileSync(path.resolve(__dirname, '../../src/screens/SendScreen.tsx'), 'utf8');
const th   = fs.readFileSync(path.resolve(__dirname, '../../src/screens/TransactionHistory.tsx'), 'utf8');
const dis  = fs.readFileSync(path.resolve(__dirname, '../../src/screens/DisputeTransactionScreen.tsx'), 'utf8');
const be   = fs.readFileSync(path.resolve(__dirname, '../../backend/index.js'), 'utf8');

module.exports = function phase14(check) {

  // A: Balance not updating after withdrawal
  check('[LocalBalance] Zero-reset guard present in syncLocalBalancesFromBackend',
    lb.includes('b.amount === 0 && localAmt !== undefined && localAmt > 0'));
  check('[LocalBalance] Zero-reset guard uses continue before debitTimes logic',
    lb.includes('synced[b.currency] = localAmt;') &&
    lb.includes('continue;') &&
    lb.indexOf('synced[b.currency] = localAmt;') < lb.indexOf('hasDebitRecord && localAmt !== undefined'));
  check('[LocalBalance] debitTimes protection still fires for non-zero stale backend values',
    lb.includes('hasDebitRecord && localAmt !== undefined') && lb.includes('b.amount <= localAmt'));
  check('[SendScreen] useFocusEffect imported from @react-navigation/native',
    send.includes('useFocusEffect') && send.includes('@react-navigation/native'));
  check('[SendScreen] useFocusEffect calls syncLocalBalancesFromBackend',
    send.includes('useFocusEffect') && send.includes('syncLocalBalancesFromBackend(res.wallets'));
  check('[SendScreen] useFocusEffect does NOT call setFromWalletId (preserves form)',
    (() => {
      const cbStart = send.indexOf('React.useCallback(() => {', send.indexOf('Re-sync balances'));
      const cbEnd   = send.indexOf('}, [auth.token])', cbStart);
      return !send.slice(cbStart, cbEnd).includes('setFromWalletId');
    })());
  check('[SendScreen] useFocusEffect does NOT call setCurrency (preserves form)',
    (() => {
      const cbStart = send.indexOf('React.useCallback(() => {', send.indexOf('Re-sync balances'));
      const cbEnd   = send.indexOf('}, [auth.token])', cbStart);
      return !send.slice(cbStart, cbEnd).includes('setCurrency');
    })());

  // B: Double transaction log dedup
  check('[TransactionHistory] Secondary dedup checks type+amount+currency+timestamp',
    th.includes('b.type === local.type') &&
    th.includes('b.amount === local.amount') &&
    th.includes('b.currency === local.currency') &&
    th.includes('5 * 60 * 1000'));
  check('[TransactionHistory] 5-minute window uses Math.abs',
    th.includes('Math.abs((b.timestamp ?? 0) - local.timestamp) < 5 * 60 * 1000'));
  check('[TransactionHistory] Primary dedup (exact id) still present',
    th.includes('backendIds.has(local.id)'));
  check('[TransactionHistory] uniqueLocal uses both dedup passes',
    th.includes('if (backendIds.has(local.id)) return false') && th.includes('return !backendTxs.some'));
  check('[TransactionHistory] null-safe timestamp: b.timestamp ?? 0',
    th.includes('b.timestamp ?? 0'));

  // C: Dispute ticket consistency
  check('[Dispute] finalTicket variable used (falls back to client ticketNum)',
    dis.includes('let finalTicket = ticketNum'));
  check('[Dispute] Server ticket extracted from response',
    dis.includes('data?.dispute?.ticketNumber'));
  check('[Dispute] finalTicket overrides when backend responds',
    dis.includes('if (data?.dispute?.ticketNumber) finalTicket = data.dispute.ticketNumber'));
  check('[Dispute] emailSubject uses finalTicket',
    dis.includes('\`[\${finalTicket}] Dispute:'));
  check('[Dispute] emailBody uses finalTicket',
    dis.includes('Ticket: \${finalTicket}'));
  check('[Dispute] Alert message uses finalTicket',
    dis.includes('Ticket \${finalTicket} created'));
  check('[Dispute] Fallback error uses finalTicket',
    dis.includes('with ticket number \${finalTicket}'));

  // D: Security - dispute POST body
  check('[Dispute] userEmail NOT sent in POST body',
    (() => {
      const postIdx = dis.indexOf("method: 'POST'");
      const bodyEnd = dis.indexOf('}),', postIdx);
      return !dis.slice(postIdx, bodyEnd).includes('userEmail');
    })());
  check('[Dispute] ticketNumber NOT sent in POST body',
    (() => {
      const postIdx = dis.indexOf("method: 'POST'");
      const bodyEnd = dis.indexOf('}),', postIdx);
      return !dis.slice(postIdx, bodyEnd).includes('ticketNumber');
    })());
  check('[Backend /disputes] reason validated against VALID_REASONS whitelist',
    be.includes("const VALID_REASONS = ['unauthorized', 'wrong_amount', 'not_received', 'duplicate', 'other']") &&
    be.includes('VALID_REASONS.includes(reason)'));
  check('[Backend /disputes] userEmail resolved from DB (not client body)',
    be.includes('const resolvedEmail = dbUser?.email || null') && be.includes('userEmail: resolvedEmail'));
  check('[Backend /disputes] ticketNumber generated server-side',
    be.includes('const ticketNumber = \`EGW-\${Math.floor(10000 + Math.random() * 90000)}\`') &&
    be.includes('ticketNumber,'));
  check('[Backend /disputes] description server-side length 10-2000',
    be.includes('description.trim().length < 10 || description.trim().length > 2000'));
  check('[Backend /disputes] transactionId length-capped',
    be.includes('String(transactionId).slice(0, 100)'));
  check('[Backend /disputes] notifyEmail hardcoded',
    be.includes("notifyEmail: 'support@egwalletfinance.com'"));
  check('[Backend /disputes] response omits full record',
    be.includes('dispute: { id: dispute.id, ticketNumber: dispute.ticketNumber, status: dispute.status }'));

  // E: Security - localBalance arithmetic guards
  check('[LocalBalance] creditLocalBalance uses Math.abs (no negative credit)',
    lb.includes('Math.abs(minorAmount)') && lb.includes('creditLocalBalance'));
  check('[LocalBalance] debitLocalBalance uses Math.max(0,...) (no negative balance)',
    lb.includes('Math.max(0, (balances[currency] || 0) - Math.abs(minorAmount))'));
  check('[LocalBalance] clearPendingWithdrawal uses Math.max(0,...) (no negative pending)',
    lb.includes('Math.max(0, (pending[currency] || 0) - Math.abs(minorAmount))'));
  check('[LocalBalance] logLocalTransaction caps history at 100 entries',
    lb.includes('existing.slice(0, 100)'));
  check('[LocalBalance] clearLocalUserData removes all 5 keys incl PENDING_WITHDRAWAL_KEY',
    lb.includes('PENDING_WITHDRAWAL_KEY') &&
    lb.includes('AsyncStorage.multiRemove([') &&
    lb.includes('@egwallet_budgets_v1'));
  check('[LocalBalance] syncLocalBalancesFromBackend wrapped in try/catch',
    lb.includes('} catch {') && lb.includes('// ignore storage errors'));
};
`;

fs.writeFileSync(outPath, content, 'utf8');
console.log('phase14.test.js written successfully');
