'use strict';

/**
 * Credit EGWallet wallets from official Lightspark INCOMING_PAYMENT.COMPLETED
 * events only. Stripe deposits stay on stripe_intent_id / deposit_credit.
 */

const { v4: uuidv4 } = require('uuid');
const gridDb = require('../db/gridPostgres');
const { commitGridIncomingCreditPostgres } = require('../db/gridIncomingPostgres');
const { loadAppState, saveAppState } = require('../db/appStateStore');

const GRID_INCOMING_SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP']);
const CUSTOMER_ID = /^Customer:[A-Za-z0-9-]+$/;
const TRANSACTION_ID = /^Transaction:[A-Za-z0-9-]+$/;
const INTERNAL_ACCOUNT_ID = /^InternalAccount:[A-Za-z0-9-]+$/;

function extractIncomingTransactionId(data) {
  if (!data) return null;
  if (typeof data.id === 'string' && TRANSACTION_ID.test(data.id)) return data.id;
  if (typeof data.transactionId === 'string' && TRANSACTION_ID.test(data.transactionId)) {
    return data.transactionId;
  }
  return null;
}

function extractIncomingCustomerId(data) {
  if (!data) return null;
  if (typeof data.customerId === 'string' && CUSTOMER_ID.test(data.customerId)) return data.customerId;
  return null;
}

function extractIncomingInternalAccountId(data) {
  if (!data) return null;
  const candidates = [
    data.internalAccountId,
    data.accountId,
    data.destination && data.destination.id,
    data.destinationAccountId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && INTERNAL_ACCOUNT_ID.test(value)) return value;
  }
  return null;
}

function extractIncomingAmount(data) {
  const received = data && data.receivedAmount;
  if (!received || typeof received !== 'object') return null;
  const amount = received.amount;
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const code = (received.currency && received.currency.code)
    || (typeof received.currency === 'string' ? received.currency : null);
  if (!code) return null;
  return { amount, currency: String(code).toUpperCase() };
}

function isFinalSuccessfulIncoming(type, data) {
  if (type !== 'INCOMING_PAYMENT.COMPLETED') return false;
  if (!data || typeof data !== 'object') return false;
  if (data.status && String(data.status).toUpperCase() !== 'COMPLETED') return false;
  if (data.type && String(data.type).toUpperCase() !== 'INCOMING') return false;
  return true;
}

function findWalletInState(stateDb, userId) {
  if (!stateDb || !Array.isArray(stateDb.wallets)) return null;
  return stateDb.wallets.find((w) => w.userId === userId) || null;
}

async function resolveIncomingCreditTarget(data, deps) {
  const transactionId = extractIncomingTransactionId(data);
  if (!transactionId) return { ok: false, reason: 'missing_reference' };

  const money = extractIncomingAmount(data);
  if (!money) return { ok: false, reason: 'malformed' };
  if (!GRID_INCOMING_SUPPORTED_CURRENCIES.has(money.currency)) {
    return { ok: false, reason: 'unsupported_currency' };
  }

  const customerId = extractIncomingCustomerId(data);
  if (!customerId) return { ok: false, reason: 'unmatched' };

  const customer = await deps.getGridCustomerByGridId(customerId);
  if (!customer || !customer.user_id) return { ok: false, reason: 'unmatched' };

  if (data.platformCustomerId && customer.platform_customer_id
      && String(data.platformCustomerId) !== String(customer.platform_customer_id)) {
    return { ok: false, reason: 'wrong_user' };
  }

  const internalAccountId = extractIncomingInternalAccountId(data);
  if (internalAccountId) {
    const account = await deps.getGridInternalAccountByGridId(internalAccountId);
    if (!account) return { ok: false, reason: 'unmatched' };
    if (account.user_id && String(account.user_id) !== String(customer.user_id)) {
      return { ok: false, reason: 'wrong_user' };
    }
    if (account.currency && String(account.currency).toUpperCase() !== money.currency) {
      return { ok: false, reason: 'unsupported_currency' };
    }
  }

  return {
    ok: true,
    userId: customer.user_id,
    transactionId,
    amount: money.amount,
    currency: money.currency,
  };
}

async function applyIncomingPayment(type, data, logger, withBalanceMutex, injected = {}) {
  const deps = {
    getGridCustomerByGridId: injected.getGridCustomerByGridId || gridDb.getGridCustomerByGridId,
    getGridInternalAccountByGridId: injected.getGridInternalAccountByGridId || gridDb.getGridInternalAccountByGridId,
    findWalletIdForUser: injected.findWalletIdForUser || gridDb.findWalletIdForUser,
    commitCredit: injected.commitCredit || commitGridIncomingCreditPostgres,
    loadAppState: injected.loadAppState || loadAppState,
    saveAppState: injected.saveAppState || saveAppState,
  };

  if (type === 'TEST' || type === 'INCOMING_PAYMENT.PENDING'
      || type === 'INCOMING_PAYMENT.PROCESSING' || type === 'INCOMING_PAYMENT.FAILED') {
    if (logger && logger.info) logger.info('[webhook/grid] Incoming payment not credited', { type, reason: type === 'TEST' ? 'test' : 'not_final' });
    return { credited: false, reason: type === 'TEST' ? 'test' : 'not_final' };
  }
  if (!isFinalSuccessfulIncoming(type, data)) {
    if (logger && logger.info) logger.info('[webhook/grid] Incoming payment not credited', { type, reason: 'not_final' });
    return { credited: false, reason: 'not_final' };
  }

  const resolved = await resolveIncomingCreditTarget(data, deps);
  if (!resolved.ok) {
    if (logger && logger.info) {
      logger.info('[webhook/grid] Incoming payment not credited', { type, reason: resolved.reason });
    }
    return { credited: false, reason: resolved.reason };
  }

  const run = withBalanceMutex ? withBalanceMutex : (fn) => fn();
  return run(async () => {
    const db = deps.loadAppState();
    const stateWallet = findWalletInState(db, resolved.userId);
    const walletId = stateWallet && stateWallet.id
      ? stateWallet.id
      : await deps.findWalletIdForUser(resolved.userId);
    if (!walletId) {
      if (logger && logger.info) logger.info('[webhook/grid] Incoming payment not credited', { reason: 'unmatched' });
      return { credited: false, reason: 'unmatched' };
    }

    const tx = {
      id: uuidv4(),
      type: 'grid_incoming',
      fromWalletId: null,
      toWalletId: walletId,
      amount: resolved.amount,
      currency: resolved.currency,
      receivedAmount: resolved.amount,
      receivedCurrency: resolved.currency,
      status: 'completed',
      timestamp: Date.now(),
      memo: 'Incoming payment via Lightspark Grid',
      direction: 'in',
      gridTransactionId: resolved.transactionId,
      stripeIntentId: null,
    };

    const result = await deps.commitCredit({
      walletId,
      userId: resolved.userId,
      currency: resolved.currency,
      netCredited: resolved.amount,
      tx,
      gridTransactionId: resolved.transactionId,
      stateDb: db,
    });

    if (result.credited) {
      if (stateWallet) {
        let balance = (stateWallet.balances || []).find((b) => b.currency === resolved.currency);
        if (!balance) {
          balance = { currency: resolved.currency, amount: 0 };
          stateWallet.balances = stateWallet.balances || [];
          stateWallet.balances.push(balance);
        }
        balance.amount += resolved.amount;
      }
      db.transactions = db.transactions || [];
      if (!db.transactions.some((row) => row.gridTransactionId === resolved.transactionId)) {
        db.transactions.push(tx);
      }
      deps.saveAppState(db);
      if (logger && logger.info) {
        logger.info('[webhook/grid] Incoming payment credited', {
          currency: resolved.currency,
        });
      }
    }

    return result;
  });
}

module.exports = {
  GRID_INCOMING_SUPPORTED_CURRENCIES,
  extractIncomingTransactionId,
  extractIncomingCustomerId,
  extractIncomingAmount,
  isFinalSuccessfulIncoming,
  resolveIncomingCreditTarget,
  applyIncomingPayment,
};
