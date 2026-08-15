'use strict';

/**
 * Lightspark Grid sandbox payout executor.
 * Official money-movement calls only:
 *   POST /sandbox/internal-accounts/{id}/fund
 *   POST /transfer-out
 *   POST /quotes
 *   POST /quotes/{id}/execute
 *   GET /transactions/{id}
 *   GET /customers/internal-accounts
 *
 * Never contacts Kora or Stripe. Never uses Production Grid.
 */

const { decryptPII, maskAccountNumber } = require('../piiCipher');
const { isGridSandboxConfigured } = require('./gridEnv');
const gridClient = require('./gridClient');
const gridDb = require('../db/gridPostgres');

function gridError(message, { definitive = true, status = 400 } = {}) {
  const err = new Error(message);
  err._definitiveRejection = definitive;
  err.providerContacted = false;
  err.status = status;
  return err;
}

function pickInternalAccount(accounts, currency) {
  const list = Array.isArray(accounts) ? accounts : [];
  const code = (currency || '').toUpperCase();
  return (
    list.find((a) => (a.currency?.code || a.currency) === code && (a.status || 'ACTIVE') === 'ACTIVE') ||
    list.find((a) => (a.status || 'ACTIVE') === 'ACTIVE') ||
    list[0] ||
    null
  );
}

function internalBalanceMinor(account) {
  if (!account) return 0;
  if (account.balance && typeof account.balance.amount === 'number') return account.balance.amount;
  if (typeof account.balance === 'number') return account.balance;
  return 0;
}

function buildExternalAccountBody({ customerId, withdrawal, currency, userId }) {
  const code = (currency || withdrawal.currency || 'USD').toUpperCase();
  const accountNumber = decryptPII(withdrawal.accountNumber) || '';
  const holder = decryptPII(withdrawal.accountHolderName) || '';
  const iban = decryptPII(withdrawal.iban) || '';
  const bankName = decryptPII(withdrawal.bankName) || withdrawal.bankNameDisplay || '';
  const routing = withdrawal.routingNumber || withdrawal.bankCode || '';

  const beneficiary = {
    beneficiaryType: 'INDIVIDUAL',
    fullName: holder || 'EGWallet Customer',
  };

  let accountInfo;
  if (code === 'USD') {
    accountInfo = {
      accountType: 'USD_ACCOUNT',
      accountNumber,
      routingNumber: routing,
      bankAccountType: 'CHECKING',
      beneficiary,
    };
  } else if (code === 'EUR') {
    const country = String(withdrawal.country || '').trim().toUpperCase();
    accountInfo = {
      accountType: 'EUR_ACCOUNT',
      iban,
      swiftCode: decryptPII(withdrawal.swiftBic) || undefined,
      bankName: bankName || undefined,
      beneficiary: {
        ...beneficiary,
        countryOfResidence: country || undefined,
      },
    };
  } else if (code === 'GBP') {
    accountInfo = {
      accountType: 'GBP_ACCOUNT',
      sortCode: routing,
      accountNumber,
      beneficiary,
    };
  } else {
    throw gridError(`Grid sandbox payouts do not accept ${code} external accounts in this integration`);
  }

  return {
    customerId,
    currency: code,
    platformAccountId: `egw-${userId}-${code}-${maskAccountNumber(accountNumber || iban || routing)}`,
    accountInfo,
  };
}

async function ensureExternalAccount(withdrawal, customer, options = {}) {
  const currency = (withdrawal.currency || 'USD').toUpperCase();
  const existing = await gridDb.listGridExternalAccounts(withdrawal.userId);
  const match = existing.find((a) => (a.currency || '').toUpperCase() === currency && (a.status || 'ACTIVE') !== 'INACTIVE');
  if (match) return match.grid_external_account_id;

  const created = await gridClient.createExternalAccount(
    buildExternalAccountBody({
      customerId: customer.grid_customer_id,
      withdrawal,
      currency,
      userId: withdrawal.userId,
    }),
    { idempotencyKey: `egw-ext-${withdrawal.id}`, axiosImpl: options.axiosImpl }
  );
  if (!created.ok || !created.data || !created.data.id) {
    throw gridError(created.reason === 'unauthorized' ? 'Grid authentication failed' : 'Grid external account creation failed');
  }
  await gridDb.upsertGridExternalAccount({
    userId: withdrawal.userId,
    gridCustomerId: customer.grid_customer_id,
    gridExternalAccountId: created.data.id,
    currency,
    status: created.data.status || 'ACTIVE',
    accountMask: maskAccountNumber(decryptPII(withdrawal.accountNumber) || decryptPII(withdrawal.iban) || ''),
    bankNameDisplay: withdrawal.bankNameDisplay || null,
  });
  return created.data.id;
}

async function ensureFundedInternalAccount(customer, currency, amountMinor, options = {}) {
  const listed = await gridClient.listInternalAccounts(
    { customerId: customer.grid_customer_id, currency },
    { axiosImpl: options.axiosImpl }
  );
  const accounts = listed.ok && listed.data
    ? (Array.isArray(listed.data.data) ? listed.data.data : listed.data)
    : [];
  const account = pickInternalAccount(accounts, currency);
  if (!account || !account.id) {
    throw gridError('Grid internal account is not provisioned. Complete End User Terms and customer onboarding first.');
  }
  await gridDb.upsertGridInternalAccount({
    userId: customer.user_id || customer.userId,
    gridCustomerId: customer.grid_customer_id,
    gridInternalAccountId: account.id,
    currency,
    status: account.status || 'ACTIVE',
  });

  const balance = internalBalanceMinor(account);
  if (balance < amountMinor) {
    const fund = await gridClient.sandboxFundInternalAccount(
      account.id,
      amountMinor,
      { idempotencyKey: options.fundIdempotencyKey, axiosImpl: options.axiosImpl }
    );
    if (!fund.ok) {
      throw gridError('Grid sandbox funding failed', { definitive: fund.reason !== 'unreachable' });
    }
  }
  return account.id;
}

function mapTransactionResult(tx, fallbackProvider = 'lightspark') {
  const status = (tx && tx.status) || 'PENDING';
  const settled = status === 'COMPLETED';
  const failed = status === 'FAILED' || status === 'EXPIRED';
  if (failed) {
    const err = gridError(`Grid transaction ${status}`, { definitive: true });
    err.providerContacted = true;
    throw err;
  }
  return {
    provider: fallbackProvider,
    reference: tx && tx.id ? tx.id : null,
    settled,
    raw: { id: tx && tx.id, status },
  };
}

/**
 * @param {object} w withdrawal record
 * @param {object} logger
 * @param {{ axiosImpl?: object }} [options]
 */
async function lightsparkPayout(w, logger, options = {}) {
  if (!isGridSandboxConfigured()) {
    throw gridError('Lightspark Grid is not configured for sandbox');
  }

  const customer = await gridDb.getGridCustomerByUserId(w.userId);
  if (!customer) {
    throw gridError('Grid customer onboarding is required before Lightspark withdrawals');
  }

  const currency = (w.currency || 'USD').toUpperCase();
  const amount = Math.round(Number(w.netPayout || w.amount || 0));
  if (!Number.isInteger(amount) || amount <= 0) {
    throw gridError('Invalid Lightspark payout amount');
  }

  const externalAccountId = w.gridExternalAccountId
    || w.grid_external_account_id
    || await ensureExternalAccount(w, customer, options);
  const internalAccountId = await ensureFundedInternalAccount(
    customer,
    currency,
    amount,
    { axiosImpl: options.axiosImpl, fundIdempotencyKey: `egw-fund-${w.id}` }
  );

  w.gridCustomerId = customer.grid_customer_id;
  w.gridExternalAccountId = externalAccountId;

  const destinationCurrency = (w.destinationCurrency || currency).toUpperCase();
  const sameCurrency = destinationCurrency === currency;

  let tx;
  let quoteId = null;
  if (sameCurrency) {
    logger.info('[Grid] Creating transfer-out', { withdrawalId: w.id, currency, amount });
    const transfer = await gridClient.createTransferOut(
      {
        source: { accountId: internalAccountId },
        destination: { accountId: externalAccountId },
        amount,
        remittanceInformation: `EGWallet ${w.id}`.slice(0, 80),
      },
      { idempotencyKey: `egw-${w.id}`, axiosImpl: options.axiosImpl }
    );
    if (!transfer.ok || !transfer.data) {
      const err = gridError(
        transfer.reason === 'unauthorized' ? 'Grid authentication failed' : 'Grid transfer-out failed',
        { definitive: transfer.httpStatus && transfer.httpStatus >= 400 && transfer.httpStatus < 500 && transfer.httpStatus !== 429 }
      );
      err.providerContacted = transfer.reason !== 'unreachable' && transfer.reason !== 'not_configured';
      throw err;
    }
    tx = transfer.data;
  } else {
    const quote = await gridClient.createQuote(
      {
        source: { sourceType: 'ACCOUNT', accountId: internalAccountId },
        destination: { destinationType: 'ACCOUNT', accountId: externalAccountId },
        lockedCurrencySide: 'SENDING',
        lockedCurrencyAmount: amount,
        description: `EGWallet withdrawal ${w.id}`,
        purposeOfPayment: 'GOODS_OR_SERVICES',
        senderCustomerInfo: { PURPOSE_OF_PAYMENT: 'GOODS_OR_SERVICES' },
      },
      { idempotencyKey: `egw-quote-${w.id}`, axiosImpl: options.axiosImpl }
    );
    if (!quote.ok || !quote.data || !quote.data.id) {
      throw gridError('Grid quote creation failed');
    }
    quoteId = quote.data.id;
    await gridDb.upsertGridQuote({
      withdrawalId: w.id,
      userId: w.userId,
      gridQuoteId: quote.data.id,
      gridTransactionId: quote.data.transactionId || null,
      status: quote.data.status || 'PENDING',
      sendingCurrency: currency,
      receivingCurrency: destinationCurrency,
      sendingAmount: amount,
    });
    const executed = await gridClient.executeQuote(quote.data.id, {
      idempotencyKey: `egw-exec-${w.id}`,
      axiosImpl: options.axiosImpl,
    });
    if (!executed.ok || !executed.data) {
      throw gridError('Grid quote execution failed');
    }
    tx = {
      id: executed.data.transactionId || executed.data.id,
      status: executed.data.status || 'PROCESSING',
    };
    await gridDb.upsertGridQuote({
      withdrawalId: w.id,
      userId: w.userId,
      gridQuoteId: quote.data.id,
      gridTransactionId: tx.id,
      status: executed.data.status || 'PROCESSING',
      sendingCurrency: currency,
      receivingCurrency: destinationCurrency,
      sendingAmount: amount,
    });
  }

  if (tx && tx.id) {
    w.gridTransactionId = tx.id;
    w.gridQuoteId = quoteId;
    if (quoteId) {
      await gridDb.upsertGridQuote({
        withdrawalId: w.id,
        userId: w.userId,
        gridQuoteId: quoteId,
        gridTransactionId: tx.id,
        status: tx.status || 'PENDING',
        sendingCurrency: currency,
        receivingCurrency: destinationCurrency,
        sendingAmount: amount,
      });
    }
    try {
      await gridDb.updateWithdrawalGridRefs(w.id, {
        gridCustomerId: customer.grid_customer_id,
        gridExternalAccountId: externalAccountId,
        gridQuoteId: quoteId,
        gridTransactionId: tx.id,
      });
    } catch (_err) {
      logger.warn('[Grid] Could not persist Grid reference columns', { withdrawalId: w.id });
    }
  }

  logger.info('[Grid] Transfer submitted', {
    withdrawalId: w.id,
    status: tx && tx.status,
  });
  const result = mapTransactionResult(tx);
  result.gridCustomerId = customer.grid_customer_id;
  result.gridExternalAccountId = externalAccountId;
  result.gridQuoteId = quoteId;
  result.gridTransactionId = tx && tx.id ? tx.id : null;
  return result;
}

async function queryLightsparkStatus(reference, options = {}) {
  if (!reference || !String(reference).startsWith('Transaction:')) {
    return { status: 'unknown', reference: reference || null };
  }
  const result = await gridClient.getTransaction(reference, { axiosImpl: options.axiosImpl });
  if (!result.ok || !result.data) {
    return { status: result.httpStatus === 404 ? 'absent' : 'unknown', reference };
  }
  const status = (result.data.status || '').toUpperCase();
  if (status === 'COMPLETED') return { status: 'paid', reference };
  if (status === 'FAILED' || status === 'EXPIRED') return { status: 'failed', reference };
  return { status: 'pending', reference };
}

module.exports = {
  lightsparkPayout,
  queryLightsparkStatus,
  buildExternalAccountBody,
  pickInternalAccount,
};
