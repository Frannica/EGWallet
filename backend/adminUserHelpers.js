'use strict';

/** Read-only mirror of KYC_TIERS in index.js — keep in sync for Admin display. */
const KYC_TIERS = {
  0: { name: 'Starter', dailyLimit: 300, weeklyLimit: 1000, monthlyLimit: 2000 },
  1: { name: 'Basic KYC', dailyLimit: 2000, weeklyLimit: 5000, monthlyLimit: 10000 },
  2: { name: 'Verified', dailyLimit: 10000, weeklyLimit: 25000, monthlyLimit: 50000 },
};

const ACTIVITY_CATEGORIES = [
  'deposits',
  'exchanges',
  'qr_payments',
  'qr_codes',
  'payment_requests',
  'withdrawals',
  'virtual_cards',
  'transactions',
];

function getDayKey() { return new Date().toISOString().slice(0, 10); }

function getWeekKey() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil((((d - Date.UTC(year, 0, 1)) / 86400000) + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}

function getMonthKey() { return new Date().toISOString().slice(0, 7); }

function ensureLimitTracking(user) {
  if (!user.limitTracking) {
    user.limitTracking = {
      dailyUsedUSD: 0,
      weeklyUsedUSD: 0,
      monthlyUsedUSD: 0,
      dayKey: getDayKey(),
      weekKey: getWeekKey(),
      monthKey: getMonthKey(),
    };
  }
}

function applyLimitResets(user) {
  ensureLimitTracking(user);
  const lt = user.limitTracking;
  const dk = getDayKey();
  const wk = getWeekKey();
  const mk = getMonthKey();
  if (lt.dayKey !== dk) { lt.dailyUsedUSD = 0; lt.dayKey = dk; }
  if (lt.weekKey !== wk) { lt.weeklyUsedUSD = 0; lt.weekKey = wk; }
  if (lt.monthKey !== mk) { lt.monthlyUsedUSD = 0; lt.monthKey = mk; }
}

function buildLimitSummary(user) {
  applyLimitResets(user);
  const tierLevel = user.kycTier || 0;
  const tier = KYC_TIERS[tierLevel] || KYC_TIERS[0];
  const lt = user.limitTracking || {};
  const dailyUsed = lt.dailyUsedUSD || 0;
  const weeklyUsed = lt.weeklyUsedUSD || 0;
  const monthlyUsed = lt.monthlyUsedUSD || 0;
  return {
    tierLevel,
    tierName: tier.name,
    daily: { usedUSD: dailyUsed, limitUSD: tier.dailyLimit, remainingUSD: Math.max(0, tier.dailyLimit - dailyUsed) },
    weekly: { usedUSD: weeklyUsed, limitUSD: tier.weeklyLimit, remainingUSD: Math.max(0, tier.weeklyLimit - weeklyUsed) },
    monthly: { usedUSD: monthlyUsed, limitUSD: tier.monthlyLimit, remainingUSD: Math.max(0, tier.monthlyLimit - monthlyUsed) },
    periodKeys: { dayKey: lt.dayKey, weekKey: lt.weekKey, monthKey: lt.monthKey },
    enforcedOnMobile: true,
  };
}

function getUserWalletIds(db, userId) {
  return new Set((db.wallets || []).filter((w) => w.userId === userId).map((w) => w.id));
}

function mapTransaction(tx) {
  return {
    id: tx.id,
    type: tx.type,
    amount: tx.amount,
    currency: tx.currency,
    status: tx.status,
    fromWalletId: tx.fromWalletId || null,
    toWalletId: tx.toWalletId || null,
    memo: tx.memo || null,
    createdAt: tx.createdAt || tx.timestamp || null,
  };
}

function userTransactions(db, walletIds) {
  return (db.transactions || [])
    .filter((tx) => walletIds.has(tx.fromWalletId) || walletIds.has(tx.toWalletId))
    .slice()
    .sort((a, b) => (b.createdAt || b.timestamp || 0) - (a.createdAt || a.timestamp || 0));
}

function isDeposit(tx) {
  return tx.type === 'deposit' || (!tx.fromWalletId && tx.toWalletId);
}

function isExchange(tx) {
  return tx.type === 'exchange';
}

function isQrPayment(tx) {
  return tx.type === 'qr_payment' || tx.type === 'qr_dynamic';
}

function filterTransactionsByCategory(transactions, category) {
  switch (category) {
    case 'deposits': return transactions.filter(isDeposit);
    case 'exchanges': return transactions.filter(isExchange);
    case 'qr_payments': return transactions.filter(isQrPayment);
    case 'transactions': return transactions;
    default: return [];
  }
}

function paginate(items, page, limit) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;
  return {
    data: items.slice(start, start + limit),
    page: safePage,
    totalPages,
    totalItems,
    limit,
  };
}

function sanitizeVirtualCard(card) {
  if (!card) return card;
  const { cvv, cardNumber, ...rest } = card;
  const last4 = rest.last4 || (cardNumber ? cardNumber.slice(-4) : '****');
  return {
    id: rest.id,
    walletId: rest.walletId,
    last4,
    maskedNumber: `****${last4}`,
    currency: rest.currency,
    label: rest.label || null,
    status: rest.status,
    spentToday: rest.spentToday ?? 0,
    dailyLimit: rest.dailyLimit ?? null,
    createdAt: rest.createdAt || null,
  };
}

function sanitizeQrCode(qr) {
  return {
    id: qr.id,
    type: qr.type || null,
    used: !!qr.used,
    createdAt: qr.createdAt || null,
    expiry: qr.expiry || qr.payload?.expiry || null,
    amount: qr.payload?.amount ?? null,
    currency: qr.payload?.currency ?? null,
    memo: qr.payload?.memo ?? null,
  };
}

function mapPaymentRequest(pr) {
  return {
    id: pr.id,
    walletId: pr.walletId || null,
    amount: pr.amount,
    currency: pr.currency,
    status: pr.status,
    memo: pr.memo || null,
    createdAt: pr.createdAt || null,
  };
}

function mapWithdrawal(w) {
  return {
    id: w.id,
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    method: w.method || null,
    createdAt: w.createdAt || null,
  };
}

function userPaymentRequests(db, userId, walletIds) {
  return (db.paymentRequests || [])
    .filter((pr) => pr.requesterId === userId || pr.userId === userId || walletIds.has(pr.walletId))
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function userWithdrawals(db, userId) {
  return (db.withdrawals || [])
    .filter((w) => w.userId === userId)
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function userVirtualCards(db, userId) {
  return (db.virtualCards || [])
    .filter((c) => c.userId === userId && c.status !== 'deleted')
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function userQrCodes(db, userId) {
  return (db.qrCodes || [])
    .filter((qr) => qr.userId === userId || qr.payload?.userId === userId)
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function buildActivityCounts(db, userId, walletIds) {
  const txs = userTransactions(db, walletIds);
  return {
    deposits: txs.filter(isDeposit).length,
    exchanges: txs.filter(isExchange).length,
    qr_payments: txs.filter(isQrPayment).length,
    transactions: txs.length,
    payment_requests: userPaymentRequests(db, userId, walletIds).length,
    withdrawals: userWithdrawals(db, userId).length,
    virtual_cards: userVirtualCards(db, userId).length,
    qr_codes: userQrCodes(db, userId).length,
  };
}

function getUserActivity(db, user, category, page, limit) {
  const walletIds = getUserWalletIds(db, user.id);
  const txs = userTransactions(db, walletIds);

  if (['deposits', 'exchanges', 'qr_payments', 'transactions'].includes(category)) {
    const filtered = filterTransactionsByCategory(txs, category).map(mapTransaction);
    return { category, ...paginate(filtered, page, limit) };
  }

  if (category === 'payment_requests') {
    const list = userPaymentRequests(db, user.id, walletIds).map(mapPaymentRequest);
    return { category, ...paginate(list, page, limit) };
  }

  if (category === 'withdrawals') {
    const list = userWithdrawals(db, user.id).map(mapWithdrawal);
    return { category, ...paginate(list, page, limit) };
  }

  if (category === 'virtual_cards') {
    const list = userVirtualCards(db, user.id).map(sanitizeVirtualCard);
    return { category, ...paginate(list, page, limit) };
  }

  if (category === 'qr_codes') {
    const list = userQrCodes(db, user.id).map(sanitizeQrCode);
    return { category, ...paginate(list, page, limit) };
  }

  return null;
}

module.exports = {
  KYC_TIERS,
  ACTIVITY_CATEGORIES,
  buildLimitSummary,
  buildActivityCounts,
  getUserActivity,
  getUserWalletIds,
  userTransactions,
  userPaymentRequests,
  userWithdrawals,
  userVirtualCards,
  userQrCodes,
  mapTransaction,
  sanitizeVirtualCard,
  sanitizeQrCode,
  paginate,
};
