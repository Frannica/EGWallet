'use strict';

const { getPostgresStateSync, setPostgresStateSync, getPostgresStatusSync } = require('./postgresStateSync');

function emptyAppState() {
  return {
    users: [], wallets: [], transactions: [], paymentRequests: [],
    virtualCards: [], virtualCardCharges: [], budgets: [], devices: [], supportTickets: [],
    fraudAlerts: [], savedContacts: [], qrCodes: [], refreshTokens: [],
    auditLog: [], employers: [], employerEmployees: [], payrollBatches: [],
    demoIntents: [], notifications: [], passwordResetTokens: [],
    idempotencyRecords: [], withdrawals: [], ledger: [], kycIdentityClaims: {},
    payoutLocks: [], disputes: [], announcements: [],
    rates: {
      base: 'USD',
      values: {
        USD: 1, EUR: 0.93, GBP: 0.79, CHF: 0.90, CAD: 1.35,
        AUD: 1.52, NZD: 1.63,
        CNY: 7.25, JPY: 149, KRW: 1340, HKD: 7.82, SGD: 1.34,
        TWD: 31, THB: 34, MYR: 4.65, IDR: 15600, PHP: 56,
        VND: 24500, INR: 83, PKR: 278, BDT: 110, LKR: 320,
        SEK: 10.5, NOK: 10.7, DKK: 6.89, PLN: 3.95, CZK: 22.7,
        HUF: 360, RON: 4.62, RUB: 90, TRY: 32, UAH: 37,
        SAR: 3.75, AED: 3.67, QAR: 3.64, KWD: 0.31, BHD: 0.38,
        OMR: 0.38, ILS: 3.71,
        BRL: 5.2, MXN: 17, ARS: 850, CLP: 910, COP: 3900, PEN: 3.7,
        NGN: 1540, GHS: 12, XAF: 600, XOF: 600, ZAR: 19,
        KES: 130, TZS: 2650, UGX: 3800, RWF: 1300, ETB: 52,
        EGP: 50, TND: 3.1, MAD: 10, LYD: 4.8, DZD: 135,
        BWP: 14, ZWL: 360, MZN: 65, NAD: 19, LSL: 19,
        ERN: 15, AOA: 835, SOS: 570, SDG: 550, GMD: 65,
        MUR: 45, SCR: 13, ZMW: 25, MWK: 1700, GNF: 8600,
        SLE: 22, CDF: 2800, CVE: 103, HTG: 132,
      },
      updatedAt: Date.now(),
    },
  };
}

function hydrateAppState(state) {
  if (!state.paymentRequests) state.paymentRequests = [];
  if (!state.virtualCards) state.virtualCards = [];
  if (!state.virtualCardCharges) state.virtualCardCharges = [];
  if (!state.budgets) state.budgets = [];
  if (!state.devices) state.devices = [];
  if (!state.supportTickets) state.supportTickets = [];
  if (!state.fraudAlerts) state.fraudAlerts = [];
  if (!state.savedContacts) state.savedContacts = [];
  if (!state.qrCodes) state.qrCodes = [];
  if (!state.refreshTokens) state.refreshTokens = [];
  if (!state.auditLog) state.auditLog = [];
  if (!state.employers) state.employers = [];
  if (!state.employerEmployees) state.employerEmployees = [];
  if (!state.payrollBatches) state.payrollBatches = [];
  if (!state.demoIntents) state.demoIntents = [];
  if (!state.notifications) state.notifications = [];
  if (!state.disputes) state.disputes = [];
  if (!state.announcements) state.announcements = [];
  if (!state.passwordResetTokens) state.passwordResetTokens = [];
  if (!state.transactions) state.transactions = [];
  if (!state.withdrawals) state.withdrawals = [];
  if (!state.ledger) state.ledger = [];
  if (!state.idempotencyRecords) state.idempotencyRecords = [];
  if (!state.kycIdentityClaims) state.kycIdentityClaims = {};
  if (!state.payoutLocks) state.payoutLocks = [];
  return state;
}

function loadAppState() {
  const snapshot = getPostgresStateSync();
  if (snapshot.missing) {
    const seeded = emptyAppState();
    const saved = setPostgresStateSync(seeded, { skipVersionCheck: true });
    return hydrateAppState(saved.db);
  }
  return hydrateAppState(snapshot.db || emptyAppState());
}

function saveAppState(state, { skipVersionCheck = false, logger = null } = {}) {
  const saved = setPostgresStateSync(state, { skipVersionCheck });
  state._dbVersion = saved.version;
  if (logger) {
    logger.debug('App state saved', { timestamp: Date.now(), version: state._dbVersion });
  }
}

function isDatabaseConnected() {
  try {
    return !!getPostgresStatusSync().connected;
  } catch (_) {
    return false;
  }
}

module.exports = {
  emptyAppState,
  hydrateAppState,
  loadAppState,
  saveAppState,
  isDatabaseConnected,
};
