'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  commitDepositConfirmPostgres,
  fetchReplayByIntent,
} = require('./db/depositConfirmPostgres');

/**
 * Credit a wallet from a succeeded Stripe PaymentIntent (webhook fallback path).
 * Keeps app_state and PostgreSQL in sync via commitDepositConfirmPostgres.
 * Idempotent: safe for duplicate webhooks or concurrent /deposits/confirm.
 */
async function settleStripePaymentIntentDeposit(db, intent, { logger } = {}) {
  const intentId = intent.id;
  const {
    userId: intentUserId,
    walletId: intentWalletId,
    netCredited: netCreditedStr,
    feeAmount: feeAmountStr,
    feeRate: feeRateStr,
  } = intent.metadata || {};

  if (!intentUserId || !intentWalletId) {
    if (logger) {
      logger.warn('[stripe/deposit] payment_intent.succeeded missing metadata', { intentId });
    }
    return { handled: false, reason: 'missing_metadata' };
  }

  const currency = (intent.currency || '').toUpperCase();

  if ((db.transactions || []).some((tx) => tx.stripeIntentId === intentId)) {
    if (logger) {
      logger.info('[stripe/deposit] payment_intent.succeeded already credited — idempotent (app_state)', { intentId });
    }
    return { handled: true, reason: 'already_credited_app_state' };
  }

  const pgReplay = await fetchReplayByIntent(intentId, currency);
  if (pgReplay) {
    if (logger) {
      logger.info('[stripe/deposit] payment_intent.succeeded already credited — idempotent (postgres)', { intentId });
    }
    return { handled: true, reason: 'already_credited_postgres', response: pgReplay };
  }

  const wallet = (db.wallets || []).find(
    (w) => w.id === intentWalletId && w.userId === intentUserId
  );
  if (!wallet) {
    if (logger) {
      logger.error('[stripe/deposit] Wallet not found for payment_intent.succeeded', {
        intentId,
        intentUserId,
        intentWalletId,
      });
    }
    throw new Error('Wallet not found');
  }

  const netCredited = Number(netCreditedStr) || intent.amount;
  const feeAmount = Number(feeAmountStr) || 0;
  const feeRate = Number(feeRateStr) || 0;

  let balance = wallet.balances.find((b) => b.currency === currency);
  if (!balance) {
    balance = { currency, amount: 0 };
    wallet.balances.push(balance);
  }
  balance.amount += netCredited;

  const tx = {
    id: uuidv4(),
    type: 'deposit',
    fromWalletId: null,
    toWalletId: intentWalletId,
    amount: netCredited,
    currency,
    receivedAmount: netCredited,
    receivedCurrency: currency,
    wasConverted: false,
    feeAmount,
    feeRate,
    grossAmount: netCredited + feeAmount,
    status: 'completed',
    timestamp: Date.now(),
    memo: 'Deposit via Stripe (webhook settlement)',
    direction: 'in',
    stripeIntentId: intentId,
  };
  db.transactions.push(tx);

  const pgResult = await commitDepositConfirmPostgres({
    walletId: intentWalletId,
    currency,
    netCredited,
    tx,
    userId: intentUserId,
    intentId,
    stateDb: db,
  });

  if (pgResult.walletNotFound) {
    throw new Error('Wallet not found');
  }
  if (pgResult.replay && pgResult.response) {
    db.transactions.pop();
    balance.amount -= netCredited;
    if (logger) {
      logger.info('[stripe/deposit] payment_intent.succeeded postgres replay — idempotent', { intentId });
    }
    return { handled: true, reason: 'already_credited_postgres_race', response: pgResult.response };
  }

  if (logger) {
    logger.info('[stripe/deposit] payment_intent.succeeded — wallet credited via webhook', {
      intentId,
      intentUserId,
      intentWalletId,
      netCredited,
      currency,
    });
  }

  return {
    handled: true,
    reason: 'credited',
    transaction: tx,
    netCredited,
    currency,
    newBalance: pgResult.newBalance,
  };
}

module.exports = {
  settleStripePaymentIntentDeposit,
};
