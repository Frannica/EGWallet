'use strict';

const { v4: uuidv4 } = require('uuid');

const CARD_STATUSES = ['active', 'frozen', 'blocked', 'closed'];
const TERMINAL_STATUSES = new Set(['closed', 'deleted']);
const ZERO_DECIMAL = new Set(['XAF', 'XOF', 'JPY', 'KRW', 'VND', 'CLP', 'UGX', 'RWF', 'GNF', 'BIF', 'DJF', 'KMF', 'MGA', 'PYG', 'VUV']);

function decimalsFor(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

function majorToMinor(amountMajor, currency) {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * Math.pow(10, d));
}

function getDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function defaultDailyLimit(currency) {
  return majorToMinor(1000, currency);
}

function defaultMonthlyLimit(currency) {
  return majorToMinor(10000, currency);
}

function ensureCardsArray(db) {
  if (!db.virtualCards) db.virtualCards = [];
  return db.virtualCards;
}

function isLiveStatus(status) {
  return status && !TERMINAL_STATUSES.has(status);
}

function normalizeCard(card) {
  if (!card) return card;
  if (!card.freezeHistory) card.freezeHistory = [];
  if (card.spentToday == null) card.spentToday = 0;
  if (card.spentMonth == null) card.spentMonth = 0;
  if (!card.spentTodayKey) card.spentTodayKey = getDayKey();
  if (!card.spentMonthKey) card.spentMonthKey = getMonthKey();
  if (!card.dailyLimit) card.dailyLimit = defaultDailyLimit(card.currency || 'USD');
  if (!card.monthlyLimit) card.monthlyLimit = defaultMonthlyLimit(card.currency || 'USD');
  if (card.status === 'deleted') card.status = 'closed';
  applySpendPeriodResets(card);
  return card;
}

function applySpendPeriodResets(card) {
  const dk = getDayKey();
  const mk = getMonthKey();
  if (card.spentTodayKey !== dk) {
    card.spentToday = 0;
    card.spentTodayKey = dk;
  }
  if (card.spentMonthKey !== mk) {
    card.spentMonth = 0;
    card.spentMonthKey = mk;
  }
}

function getUserVirtualCards(db, userId, { includeTerminal = false } = {}) {
  return ensureCardsArray(db)
    .filter((c) => c.userId === userId && (includeTerminal || isLiveStatus(c.status)))
    .map(normalizeCard)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getPrimaryVirtualCard(db, userId) {
  const cards = getUserVirtualCards(db, userId, { includeTerminal: false });
  return cards[0] || null;
}

function assertSingleOwnership(db, userId) {
  const live = getUserVirtualCards(db, userId, { includeTerminal: false });
  if (live.length > 1) {
    throw new Error(`User ${userId} has multiple live virtual cards`);
  }
  return live[0] || null;
}

function generateCardSecrets() {
  const cardNumber = `4${Math.floor(Math.random() * 1e15).toString().padStart(15, '0')}`;
  const cvv = Math.floor(Math.random() * 900 + 100).toString();
  const last4 = cardNumber.slice(-4);
  const now = new Date();
  return {
    cardNumber,
    cvv,
    last4,
    expiryMonth: (now.getMonth() + 1).toString().padStart(2, '0'),
    expiryYear: (now.getFullYear() + 3).toString().slice(-2),
  };
}

function buildVirtualCardRecord({ userId, walletId, currency, label = 'Virtual Card' }) {
  const secrets = generateCardSecrets();
  const card = normalizeCard({
    id: uuidv4(),
    userId,
    walletId,
    last4: secrets.last4,
    expiryMonth: secrets.expiryMonth,
    expiryYear: secrets.expiryYear,
    currency,
    label,
    status: 'active',
    createdAt: Date.now(),
    spentToday: 0,
    spentMonth: 0,
    spentTodayKey: getDayKey(),
    spentMonthKey: getMonthKey(),
    dailyLimit: defaultDailyLimit(currency),
    monthlyLimit: defaultMonthlyLimit(currency),
    freezeHistory: [],
  });
  return { card, secrets };
}

function provisionVirtualCardForUser(db, { userId, walletId, currency, label }) {
  if (!userId || !walletId || !currency) {
    throw new Error('userId, walletId, and currency are required');
  }

  const duplicateOwner = ensureCardsArray(db).find(
    (c) => c.id && c.userId !== userId && c.walletId === walletId,
  );
  if (duplicateOwner) {
    throw new Error('Wallet already linked to another user card');
  }

  const existing = getPrimaryVirtualCard(db, userId);
  if (existing) {
    return { card: existing, created: false, secrets: null };
  }

  const { card, secrets } = buildVirtualCardRecord({ userId, walletId, currency, label });
  ensureCardsArray(db).push(card);
  return { card, created: true, secrets };
}

function recordFreezeEvent(card, { from, to, actor = 'user', adminId = null, reason = null }) {
  if (!card.freezeHistory) card.freezeHistory = [];
  card.freezeHistory.push({
    from,
    to,
    at: Date.now(),
    actor,
    adminId,
    reason: reason || null,
  });
}

function toggleVirtualCardFreeze(db, card, { actor = 'user', adminId = null, reason = null } = {}) {
  normalizeCard(card);
  if (!['active', 'frozen'].includes(card.status)) {
    throw new Error(`Cannot toggle freeze while card status is ${card.status}`);
  }
  const from = card.status;
  const to = from === 'active' ? 'frozen' : 'active';
  card.status = to;
  recordFreezeEvent(card, { from, to, actor, adminId, reason });
  return card;
}

function setVirtualCardStatus(card, status, { actor = 'system', adminId = null, reason = null } = {}) {
  if (!CARD_STATUSES.includes(status)) {
    throw new Error(`Invalid card status: ${status}`);
  }
  const from = card.status;
  card.status = status;
  if (from !== status) {
    recordFreezeEvent(card, { from, to: status, actor, adminId, reason });
  }
  if (status === 'closed') card.closedAt = Date.now();
  return card;
}

function applySpendDelta(card, type, amount, status) {
  normalizeCard(card);
  const amt = Number(amount) || 0;
  if (type === 'purchase' && status !== 'declined') {
    card.spentToday += amt;
    card.spentMonth += amt;
  } else if (type === 'refund' || type === 'reversal') {
    card.spentToday = Math.max(0, card.spentToday - amt);
    card.spentMonth = Math.max(0, card.spentMonth - amt);
  }
}

function userVirtualCardFreezeHistory(db, userId) {
  return getUserVirtualCards(db, userId, { includeTerminal: true })
    .flatMap((card) => (card.freezeHistory || []).map((event, index) => ({
      id: `${card.id}-${event.at}-${index}`,
      cardId: card.id,
      userId,
      cardLast4: card.last4,
      maskedCard: `****${card.last4}`,
      ...event,
    })))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

function enrichCardForAdmin(card, userId) {
  const normalized = normalizeCard({ ...card });
  return {
    id: normalized.id,
    userId,
    walletId: normalized.walletId,
    last4: normalized.last4,
    maskedNumber: `****${normalized.last4}`,
    currency: normalized.currency,
    label: normalized.label || null,
    status: normalized.status,
    spentToday: normalized.spentToday ?? 0,
    spentMonth: normalized.spentMonth ?? 0,
    dailyLimit: normalized.dailyLimit ?? null,
    monthlyLimit: normalized.monthlyLimit ?? null,
    spentTodayKey: normalized.spentTodayKey,
    spentMonthKey: normalized.spentMonthKey,
    createdAt: normalized.createdAt || null,
    closedAt: normalized.closedAt || null,
    freezeHistory: (normalized.freezeHistory || []).slice(-20),
    freezeEventCount: (normalized.freezeHistory || []).length,
  };
}

module.exports = {
  CARD_STATUSES,
  TERMINAL_STATUSES,
  majorToMinor,
  getPrimaryVirtualCard,
  getUserVirtualCards,
  provisionVirtualCardForUser,
  toggleVirtualCardFreeze,
  setVirtualCardStatus,
  applySpendDelta,
  normalizeCard,
  userVirtualCardFreezeHistory,
  enrichCardForAdmin,
  assertSingleOwnership,
};
