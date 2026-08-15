'use strict';

/**
 * Live Lightspark Sandbox USD→EUR quote/execute verification.
 * Synthetic data only. Never prints credentials, IBANs, or real PII.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const gridClient = require('../grid/gridClient');
const { isGridSandboxConfigured, ALLOWED_GRID_ENVIRONMENT } = require('../grid/gridEnv');

const STATE_PATH = path.join(__dirname, '..', 'db', 'backups', 'grid-sandbox-verify.json');
const RESULT_PATH = path.join(__dirname, '..', 'db', 'backups', 'grid-sandbox-quote-live.json');
const SUCCESS_IBAN_SUFFIX = '000';
const OFFICIAL_EUR_IBAN = 'DE89370400440532013000';
const SEND_MINOR = 10000;

function clipId(id) {
  return typeof id === 'string' ? id.slice(0, 28) : null;
}

function connectionString() {
  const url = process.env.DATABASE_URL;
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (url && !/railway\.internal/i.test(url)) return url;
  if (pub) return pub;
  return null;
}

function poolFromEnv() {
  const conn = connectionString();
  if (!conn) return null;
  return new Pool({
    connectionString: conn,
    max: 2,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
}

function moneyShape(value) {
  if (value == null) return { present: false };
  if (typeof value === 'number') return { present: true, type: 'number', positive: value > 0 };
  if (typeof value === 'object') {
    const amount = value.amount;
    const code = value.currency && (value.currency.code || value.currency);
    return {
      present: true,
      type: 'object',
      amountInteger: Number.isInteger(amount),
      amountPositive: Number(amount) > 0,
      currencyCode: typeof code === 'string' ? code : null,
    };
  }
  return { present: true, type: typeof value };
}

function sanitizeGridError(data) {
  if (!data || typeof data !== 'object') return { errorCode: null, errorReason: null, errorFields: [] };
  const code = data.code || (data.error && data.error.code) || null;
  const raw = data.message || data.reason || (data.error && data.error.message) || null;
  const reason = typeof raw === 'string' && !/@/.test(raw) && !/\b[A-Z]{2}\d{2}[A-Z0-9]{10,}/.test(raw)
    ? raw.slice(0, 240)
    : null;
  const details = Array.isArray(data.details) ? data.details : [];
  const extra = []
    .concat(data.missingFields || [])
    .concat(data.requiredFields || [])
    .concat(data.fields || []);
  const fields = details
    .map((d) => (d && (d.field || d.path || d.pointer || d.name)) || null)
    .concat(extra.map((f) => (typeof f === 'string' ? f : f && f.name)))
    .filter(Boolean)
    .slice(0, 12);
  return {
    errorCode: code ? String(code) : null,
    errorReason: reason,
    errorFields: fields,
  };
}

function inspectQuote(data) {
  const keys = data && typeof data === 'object' ? Object.keys(data).sort() : [];
  const sendingCode = data && data.sendingCurrency && (data.sendingCurrency.code || data.sendingCurrency);
  const receivingCode = data && data.receivingCurrency && (data.receivingCurrency.code || data.receivingCurrency);
  return {
    idPrefix: clipId(data && data.id),
    status: data && data.status ? String(data.status) : null,
    sendingCurrency: sendingCode || null,
    receivingCurrency: receivingCode || null,
    sendAmount: moneyShape(data && (data.totalSendingAmount != null ? data.totalSendingAmount : data.sendingAmount)),
    receiveAmount: moneyShape(data && (data.totalReceivingAmount != null ? data.totalReceivingAmount : data.receivingAmount)),
    exchangeRate: {
      present: data && data.exchangeRate != null,
      type: data && data.exchangeRate != null ? typeof data.exchangeRate : null,
      positive: data && Number(data.exchangeRate) > 0,
    },
    fees: moneyShape(data && (data.feesIncluded != null ? data.feesIncluded : data.fees)),
    expiresAtPresent: !!(data && data.expiresAt),
    expiresAtIsDate: !!(data && data.expiresAt && !Number.isNaN(Date.parse(data.expiresAt))),
    limitsPresent: !!(data && (data.limits || data.minAmount != null || data.maxAmount != null)),
    fundingInstructionsPresent: Array.isArray(data && data.paymentInstructions)
      ? data.paymentInstructions.length > 0
      : false,
    fundingInstructionsApplicable: false,
    transactionIdPrefix: clipId(data && data.transactionId),
    topLevelKeys: keys,
  };
}

async function phaseApi(result) {
  if (!isGridSandboxConfigured()) throw new Error('Grid sandbox is not configured');
  if (process.env.GRID_ENVIRONMENT !== ALLOWED_GRID_ENVIRONMENT) {
    throw new Error('Refusing non-sandbox Grid environment');
  }

  const prior = loadJson(STATE_PATH);
  result.platformCustomerId = prior.platformCustomerId;
  result.gridCustomerId = prior.gridCustomerId;
  result.usdInternalAccountId = prior.internalAccountId;
  result.walletId = prior.walletId;
  if (!result.gridCustomerId || !result.usdInternalAccountId) {
    throw new Error('Missing synthetic customer from prior sandbox verify state');
  }

  const customer = await gridClient.getCustomer(result.gridCustomerId);
  result.flows.reuseCustomer = {
    ok: customer.ok === true,
    httpStatus: customer.httpStatus,
    kycStatus: customer.data && customer.data.kycStatus ? String(customer.data.kycStatus) : null,
    customerPrefix: clipId(result.gridCustomerId),
  };
  if (!customer.ok) throw new Error(`reuse customer failed status=${customer.httpStatus}`);

  const patched = await gridClient.updateCustomer(result.gridCustomerId, {
    customerType: 'INDIVIDUAL',
    currencies: ['USD', 'EUR'],
  }, { idempotencyKey: `egw-quote-ccy-v2-${result.platformCustomerId}` });
  result.flows.customerCurrencies = {
    ok: patched.ok === true || patched.httpStatus === 200 || patched.httpStatus === 201,
    httpStatus: patched.httpStatus,
    reason: patched.ok ? 'usd_eur' : patched.reason,
    ...sanitizeGridError(patched.data),
  };
  saveResult(result);

  const config = await gridClient.gridRequest({ method: 'GET', path: '/config' });
  const supported = config.data && Array.isArray(config.data.supportedCurrencies)
    ? config.data.supportedCurrencies
    : [];
  const eurCfg = supported.find((c) => (c.currencyCode || (c.currency && c.currency.code)) === 'EUR') || null;
  result.flows.platformConfig = {
    ok: config.ok === true,
    httpStatus: config.httpStatus,
    eurSupported: !!eurCfg,
    eurMinPresent: !!(eurCfg && (eurCfg.minAmount != null || eurCfg.min != null)),
    eurMaxPresent: !!(eurCfg && (eurCfg.maxAmount != null || eurCfg.max != null)),
    providerRequiredCustomerFields: eurCfg && Array.isArray(eurCfg.providerRequiredCustomerFields)
      ? eurCfg.providerRequiredCustomerFields.map((f) => (typeof f === 'string' ? f : f.name)).filter(Boolean)
      : [],
    requiredCounterpartyFields: eurCfg && Array.isArray(eurCfg.requiredCounterpartyFields)
      ? eurCfg.requiredCounterpartyFields.map((f) => f.name || f).filter(Boolean)
      : [],
  };
  saveResult(result);

  const customerFields = customer.data || {};
  result.flows.customerFieldPresence = {
    hasFullName: typeof customerFields.fullName === 'string' && customerFields.fullName.length > 0,
    hasBirthDate: !!customerFields.birthDate,
    hasNationality: typeof customerFields.nationality === 'string' && customerFields.nationality.length === 2,
    hasAddress: !!(customerFields.address && customerFields.address.country),
    hasPhone: typeof customerFields.phoneNumber === 'string' && customerFields.phoneNumber.length > 0,
    currencies: Array.isArray(customerFields.currencies) ? customerFields.currencies : [],
  };

  const infoPatch = await gridClient.updateCustomer(result.gridCustomerId, {
    customerType: 'INDIVIDUAL',
    nationality: 'US',
    birthDate: '1990-01-15',
    address: {
      line1: '1 Synthetic Way',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
      country: 'US',
    },
  }, { idempotencyKey: `egw-quote-pii-v1-${result.platformCustomerId}` });
  result.flows.customerRequiredFields = {
    ok: infoPatch.ok === true,
    httpStatus: infoPatch.httpStatus,
    ...sanitizeGridError(infoPatch.data),
  };
  saveResult(result);

  const internals = await gridClient.listInternalAccounts({ customerId: result.gridCustomerId });
  const list = internals.data && (internals.data.data || internals.data);
  const usdInternal = Array.isArray(list)
    ? list.find((a) => (a.currency && a.currency.code) === 'USD' || a.currency === 'USD')
    : null;
  result.usdInternalAccountId = (usdInternal && usdInternal.id) || result.usdInternalAccountId;
  result.flows.internalAccounts = {
    ok: internals.ok === true && !!result.usdInternalAccountId,
    httpStatus: internals.httpStatus,
    count: Array.isArray(list) ? list.length : 0,
    usdInternalPrefix: clipId(result.usdInternalAccountId),
  };

  const listedExt = await gridClient.listExternalAccounts({ customerId: result.gridCustomerId });
  const extList = listedExt.data && (listedExt.data.data || listedExt.data);
  const existingEur = Array.isArray(extList)
    ? extList.find((a) => (a.currency && a.currency.code) === 'EUR' || a.currency === 'EUR')
    : null;
  if (existingEur && existingEur.id) {
    result.eurExternalAccountId = existingEur.id;
    result.flows.eurExternalAccount = {
      ok: true,
      httpStatus: listedExt.httpStatus,
      status: existingEur.status ? String(existingEur.status) : null,
      externalPrefix: clipId(existingEur.id),
      officialIbanSuffix: SUCCESS_IBAN_SUFFIX,
      reused: true,
    };
  } else {
    const external = await gridClient.createExternalAccount({
      customerId: result.gridCustomerId,
      currency: 'EUR',
      platformAccountId: `egw-sandbox-eur-v3-${result.platformCustomerId}`,
      accountInfo: {
        accountType: 'EUR_ACCOUNT',
        iban: OFFICIAL_EUR_IBAN,
        swiftCode: 'DEUTDEFF',
        bankName: 'Deutsche Bank',
        beneficiary: {
          beneficiaryType: 'INDIVIDUAL',
          fullName: 'EGWallet Sandbox Verify',
          birthDate: '1990-01-15',
          nationality: 'DE',
          countryOfResidence: 'DE',
          address: {
            line1: 'Hauptstrasse 789',
            city: 'Berlin',
            state: 'Berlin',
            postalCode: '10115',
            country: 'DE',
          },
        },
      },
    }, { idempotencyKey: `egw-sandbox-eur-v3-${result.platformCustomerId}` });
    result.flows.eurExternalAccount = {
      ok: external.ok === true,
      httpStatus: external.httpStatus,
      status: external.data && external.data.status ? String(external.data.status) : null,
      externalPrefix: clipId(external.data && external.data.id),
      officialIbanSuffix: SUCCESS_IBAN_SUFFIX,
      reused: false,
      ...sanitizeGridError(external.data),
    };
    if (!external.ok || !external.data || !external.data.id) {
      saveResult(result);
      throw new Error(`EUR external account failed status=${external.httpStatus} code=${result.flows.eurExternalAccount.errorCode}`);
    }
    result.eurExternalAccountId = external.data.id;
  }
  saveResult(result);

  const fund = await gridClient.sandboxFundInternalAccount(result.usdInternalAccountId, 100000, {
    idempotencyKey: `egw-quote-fund-${result.platformCustomerId}`,
  });
  result.flows.sandboxFund = {
    ok: fund.ok === true,
    httpStatus: fund.httpStatus,
    balancePresent: !!(fund.data && (fund.data.balance || fund.data.id)),
  };
  if (!fund.ok) throw new Error(`sandbox fund failed status=${fund.httpStatus}`);

  const quote = await gridClient.createQuote({
    source: { sourceType: 'ACCOUNT', accountId: result.usdInternalAccountId },
    destination: { destinationType: 'ACCOUNT', accountId: result.eurExternalAccountId, currency: 'EUR' },
    lockedCurrencySide: 'SENDING',
    lockedCurrencyAmount: SEND_MINOR,
    description: 'EGWallet sandbox USD to EUR quote',
    purposeOfPayment: 'GOODS_OR_SERVICES',
    senderCustomerInfo: { PURPOSE_OF_PAYMENT: 'GOODS_OR_SERVICES' },
  }, { idempotencyKey: `egw-quote-live-v3-${result.platformCustomerId}` });

  const quoteInspect = inspectQuote(quote.data || {});
  quoteInspect.fundingInstructionsApplicable = false;
  result.flows.quoteCreate = {
    ok: quote.ok === true,
    httpStatus: quote.httpStatus,
    inspect: quoteInspect,
    ...sanitizeGridError(quote.data),
  };
  saveResult(result);
  if (!quote.ok || !quote.data || !quote.data.id) {
    throw new Error(`quote create failed status=${quote.httpStatus} code=${result.flows.quoteCreate.errorCode}`);
  }
  result.quoteId = quote.data.id;
  result.quoteTransactionId = quote.data.transactionId || null;

  const executed = await gridClient.executeQuote(result.quoteId, {
    idempotencyKey: `egw-quote-exec-${result.platformCustomerId}`,
  });
  const execData = executed.data || {};
  result.outgoingTransactionId = execData.transactionId || execData.id || result.quoteTransactionId;
  result.flows.quoteExecute = {
    ok: executed.ok === true,
    httpStatus: executed.httpStatus,
    status: execData.status ? String(execData.status) : null,
    quotePrefix: clipId(result.quoteId),
    transactionPrefix: clipId(result.outgoingTransactionId),
    ...sanitizeGridError(execData),
  };
  if (!executed.ok) {
    throw new Error(`quote execute failed status=${executed.httpStatus} code=${result.flows.quoteExecute.errorCode}`);
  }

  if (result.outgoingTransactionId && String(result.outgoingTransactionId).startsWith('Transaction:')) {
    const tx = await gridClient.getTransaction(result.outgoingTransactionId);
    result.flows.transactionAfterExecute = {
      ok: tx.ok === true,
      httpStatus: tx.httpStatus,
      status: tx.data && tx.data.status ? String(tx.data.status) : null,
      type: tx.data && tx.data.type ? String(tx.data.type) : null,
    };
  }
  return result;
}

async function phasePoll(result) {
  if (!result.outgoingTransactionId) throw new Error('no transaction to poll');
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    const tx = await gridClient.getTransaction(result.outgoingTransactionId);
    last = {
      ok: tx.ok === true,
      httpStatus: tx.httpStatus,
      status: tx.data && tx.data.status ? String(tx.data.status) : null,
      type: tx.data && tx.data.type ? String(tx.data.type) : null,
      attempt: i + 1,
    };
    if (last.status === 'COMPLETED' || last.status === 'FAILED' || last.status === 'EXPIRED') break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  result.flows.transactionPoll = last;
  return result;
}

async function phasePersist(result) {
  const pool = poolFromEnv();
  if (!pool) throw new Error('DATABASE_PUBLIC_URL required');
  if (!result.platformCustomerId || !result.quoteId) throw new Error('quote state missing');
  const sending = result.flows.quoteCreate && result.flows.quoteCreate.inspect;
  const status = (result.flows.transactionPoll && result.flows.transactionPoll.status)
    || (result.flows.quoteExecute && result.flows.quoteExecute.status)
    || 'PROCESSING';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO grid_external_accounts (
         user_id, grid_customer_id, grid_external_account_id, currency, status,
         account_mask, bank_name_display, updated_at
       ) VALUES ($1,$2,$3,'EUR','ACTIVE',$4,'Sandbox EUR', NOW())
       ON CONFLICT (grid_external_account_id) DO UPDATE SET
         status = EXCLUDED.status, updated_at = NOW()`,
      [result.platformCustomerId, result.gridCustomerId, result.eurExternalAccountId, `****${SUCCESS_IBAN_SUFFIX}`]
    );
    await client.query(
      `INSERT INTO grid_quotes (
         withdrawal_id, user_id, grid_quote_id, grid_transaction_id, status,
         sending_currency, receiving_currency, sending_amount, receiving_amount, updated_at
       ) VALUES (NULL,$1,$2,$3,$4,'USD','EUR',$5,NULL, NOW())
       ON CONFLICT (grid_quote_id) DO UPDATE SET
         grid_transaction_id = COALESCE(EXCLUDED.grid_transaction_id, grid_quotes.grid_transaction_id),
         status = COALESCE(EXCLUDED.status, grid_quotes.status),
         updated_at = NOW()`,
      [
        result.platformCustomerId,
        result.quoteId,
        result.outgoingTransactionId || result.quoteTransactionId || null,
        status,
        SEND_MINOR,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* ignore */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
  result.flows.persistQuote = {
    ok: true,
    quotePrefix: clipId(result.quoteId),
    transactionPrefix: clipId(result.outgoingTransactionId),
    inspectSendPresent: !!(sending && sending.sendAmount && sending.sendAmount.present),
  };
  return result;
}

async function phaseCheck(result) {
  const pool = poolFromEnv();
  if (!pool) throw new Error('DATABASE_PUBLIC_URL required');
  const client = await pool.connect();
  try {
    const quoteRow = await client.query(
      `SELECT grid_quote_id, grid_transaction_id, status, sending_currency, receiving_currency, sending_amount
         FROM grid_quotes WHERE grid_quote_id = $1`,
      [result.quoteId]
    );
    const outgoingEvents = await client.query(
      `SELECT event_type, COUNT(*)::int AS count
         FROM grid_webhook_events
        WHERE event_type LIKE 'OUTGOING_PAYMENT.%'
          AND received_at >= NOW() - INTERVAL '15 minutes'
        GROUP BY event_type
        ORDER BY event_type`
    );
    const completedForTx = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM grid_webhook_events
        WHERE event_type = 'OUTGOING_PAYMENT.COMPLETED'
          AND received_at >= NOW() - INTERVAL '15 minutes'`
    );
    const syntheticLedger = await client.query(
      `SELECT type, currency, COUNT(*)::int AS count, SUM(amount)::bigint AS amount
         FROM ledger
        WHERE user_id = $1
          AND at >= NOW() - INTERVAL '30 minutes'
        GROUP BY type, currency
        ORDER BY type, currency`,
      [result.platformCustomerId]
    );
    const syntheticTxBleed = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE stripe_intent_id IS NOT NULL)::int AS stripe,
         COUNT(*) FILTER (WHERE grid_transaction_id IS NOT NULL)::int AS grid
         FROM transactions
        WHERE (from_wallet_id = $1 OR to_wallet_id = $1)
          AND timestamp >= NOW() - INTERVAL '30 minutes'`,
      [result.walletId]
    );
    const stripeBleed = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM transactions
        WHERE grid_transaction_id = $1 AND stripe_intent_id IS NOT NULL`,
      [result.outgoingTransactionId || '']
    );
    const koraBleed = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM withdrawals
        WHERE grid_quote_id = $1 OR grid_transaction_id = $1`,
      [result.quoteId]
    );
    const otherLedger = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM ledger
        WHERE user_id <> $1
          AND at >= NOW() - INTERVAL '30 minutes'`,
      [result.platformCustomerId]
    );
    const synthetic = result.walletId
      ? await client.query(
        `SELECT currency, amount FROM wallet_balances WHERE wallet_id = $1 ORDER BY currency`,
        [result.walletId]
      )
      : { rows: [] };

    const row = quoteRow.rows[0] || null;
    result.flows.dbProof = {
      quoteRecorded: !!row,
      quoteIdMatches: !!(row && row.grid_quote_id === result.quoteId),
      transactionIdMatches: !!(row && result.outgoingTransactionId && row.grid_transaction_id === result.outgoingTransactionId),
      quoteStatus: row ? row.status : null,
      sendingCurrency: row ? row.sending_currency : null,
      receivingCurrency: row ? row.receiving_currency : null,
      sendingAmount: row ? Number(row.sending_amount) : null,
      recentOutgoingWebhooks: outgoingEvents.rows,
      outgoingCompletedWebhooks15m: completedForTx.rows[0].count,
      stripeIntentOnQuoteTx: stripeBleed.rows[0].count,
      koraWithdrawalsForQuote: koraBleed.rows[0].count,
      otherUsersLedgerLast30m: otherLedger.rows[0].count,
      syntheticLedgerLast30m: syntheticLedger.rows.map((r) => ({
        type: r.type,
        currency: r.currency,
        count: r.count,
        amount: Number(r.amount),
      })),
      syntheticTxStripeLast30m: syntheticTxBleed.rows[0].stripe,
      syntheticTxGridLast30m: syntheticTxBleed.rows[0].grid,
      syntheticBalances: synthetic.rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) })),
    };
  } finally {
    client.release();
    await pool.end();
  }
  return result;
}

async function main() {
  const phase = process.argv[2] || 'api';
  let result = loadJson(RESULT_PATH);
  result.flows = result.flows || {};
  result.environment = 'sandbox';
  result.startedAt = result.startedAt || new Date().toISOString();

  try {
    if (phase === 'api') result = await phaseApi(result);
    if (phase === 'poll') result = await phasePoll(result);
    if (phase === 'persist') result = await phasePersist(result);
    if (phase === 'check') result = await phaseCheck(result);
    result.finishedAt = new Date().toISOString();
    saveResult(result);
    console.log(JSON.stringify({
      phase,
      flows: result.flows,
      quotePrefix: clipId(result.quoteId),
      transactionPrefix: clipId(result.outgoingTransactionId),
      eurExternalPrefix: clipId(result.eurExternalAccountId),
    }, null, 2));
  } catch (err) {
    result.lastError = String(err && err.message ? err.message : err).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted]');
    result.finishedAt = new Date().toISOString();
    saveResult(result);
    console.error(JSON.stringify({
      ok: false,
      error: result.lastError,
      flows: result.flows,
    }, null, 2));
    process.exit(1);
  }
}

main();
