'use strict';

/**
 * Official Lightspark Sandbox verification with synthetic data only.
 * Never prints credentials, tokens, or real customer PII.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const gridClient = require('../grid/gridClient');
const { isGridSandboxConfigured, ALLOWED_GRID_ENVIRONMENT } = require('../grid/gridEnv');

const RESULT_PATH = path.join(__dirname, '..', 'db', 'backups', 'grid-sandbox-verify.json');

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

function loadResult() {
  if (!fs.existsSync(RESULT_PATH)) return {};
  return JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
}

function saveResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
}

function clipId(id) {
  return typeof id === 'string' ? id.slice(0, 28) : null;
}

async function phaseApi(result) {
  if (!isGridSandboxConfigured()) {
    throw new Error('Grid sandbox is not configured');
  }
  if (process.env.GRID_ENVIRONMENT !== ALLOWED_GRID_ENVIRONMENT) {
    throw new Error('Refusing non-sandbox Grid environment');
  }

  const terms = await gridClient.getEndUserTerms();
  result.flows.endUserTerms = {
    ok: terms.ok === true,
    httpStatus: terms.httpStatus,
    versionPresent: !!(terms.data && terms.data.version),
    urlHttps: !!(terms.data && typeof terms.data.url === 'string' && terms.data.url.startsWith('https://')),
  };

  const platformCustomerId = result.platformCustomerId || uuidv4();
  result.platformCustomerId = platformCustomerId;
  const created = await gridClient.createCustomer({
    customerType: 'INDIVIDUAL',
    platformCustomerId,
    region: 'US',
    currencies: ['USD'],
    fullName: 'EGWallet Sandbox Verify',
    email: `grid.sandbox.verify.${platformCustomerId.slice(0, 8)}@example.test`,
    birthDate: '1990-01-15',
    address: {
      line1: '1 Synthetic Way',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
      country: 'US',
    },
    endUserTermsConsent: {
      acceptedAt: new Date().toISOString(),
      ipAddress: '203.0.113.10',
      termsVersion: terms.data && terms.data.version,
      acceptanceMethod: 'CLICK_TO_ACCEPT',
    },
  }, { idempotencyKey: `egw-sandbox-verify-${platformCustomerId}` });

  result.flows.customerCreate = {
    ok: created.ok === true,
    httpStatus: created.httpStatus,
    customerIdPrefix: clipId(created.data && created.data.id),
    kycStatus: created.data && created.data.kycStatus ? String(created.data.kycStatus) : null,
  };
  if (!created.ok || !created.data || !created.data.id) {
    throw new Error(`customer create failed status=${created.httpStatus} reason=${created.reason}`);
  }
  result.gridCustomerId = created.data.id;

  const kyc = await gridClient.createKycLink(created.data.id, {}, {
    idempotencyKey: `egw-sandbox-kyc-${platformCustomerId}`,
  });
  result.flows.hostedKyc = {
    ok: kyc.ok === true,
    httpStatus: kyc.httpStatus,
    reason: kyc.ok ? 'link_issued' : 'sandbox_uses_post_customers',
  };

  const internals = await gridClient.listInternalAccounts({ customerId: created.data.id });
  const list = internals.data && (internals.data.data || internals.data);
  const usdInternal = Array.isArray(list)
    ? list.find((a) => (a.currency && a.currency.code) === 'USD' || a.currency === 'USD') || list[0]
    : null;
  result.flows.internalAccounts = {
    ok: internals.ok === true && !!usdInternal,
    httpStatus: internals.httpStatus,
    count: Array.isArray(list) ? list.length : 0,
    internalAccountPrefix: clipId(usdInternal && usdInternal.id),
  };
  result.internalAccountId = usdInternal && usdInternal.id;

  const external = await gridClient.createExternalAccount({
    customerId: created.data.id,
    currency: 'USD',
    platformAccountId: `egw-sandbox-ext-${platformCustomerId}`,
    accountInfo: {
      accountType: 'USD_ACCOUNT',
      accountNumber: '123456789',
      routingNumber: '021000021',
      bankAccountType: 'CHECKING',
      beneficiary: { beneficiaryType: 'INDIVIDUAL', fullName: 'EGWallet Sandbox Verify' },
    },
  }, { idempotencyKey: `egw-sandbox-ext-${platformCustomerId}` });
  result.flows.externalAccount = {
    ok: external.ok === true,
    httpStatus: external.httpStatus,
    externalAccountPrefix: clipId(external.data && external.data.id),
    status: external.data && external.data.status ? String(external.data.status) : null,
  };
  result.externalAccountId = external.data && external.data.id;
  return result;
}

async function phasePersist(result) {
  const pool = poolFromEnv();
  if (!pool) throw new Error('DATABASE_PUBLIC_URL required to persist synthetic mapping');
  const userId = result.platformCustomerId;
  const walletId = result.walletId || uuidv4();
  result.walletId = walletId;
  const passwordHash = crypto.createHash('sha256').update(`sandbox-${userId}`).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, preferred_currency, created_at)
       VALUES ($1, $2, $3, 'US', 'individual', 'USD', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `grid.sandbox.verify.${String(userId).slice(0, 8)}@example.test`, passwordHash]
    );
    await client.query(
      `INSERT INTO wallets (id, user_id, type, created_at)
       VALUES ($1, $2, 'personal', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [walletId, userId]
    );
    await client.query(
      `INSERT INTO wallet_balances (wallet_id, currency, amount)
       VALUES ($1, 'USD', 0)
       ON CONFLICT (wallet_id, currency) DO NOTHING`,
      [walletId]
    );
    await client.query(
      `INSERT INTO grid_customers (user_id, grid_customer_id, platform_customer_id, kyc_status, customer_type)
       VALUES ($1, $2, $3, $4, 'INDIVIDUAL')
       ON CONFLICT (user_id) DO UPDATE SET
         grid_customer_id = EXCLUDED.grid_customer_id,
         platform_customer_id = EXCLUDED.platform_customer_id,
         kyc_status = EXCLUDED.kyc_status`,
      [userId, result.gridCustomerId, userId, result.flows.customerCreate.kycStatus || 'APPROVED']
    );
    if (result.internalAccountId) {
      await client.query(
        `INSERT INTO grid_internal_accounts (user_id, grid_customer_id, grid_internal_account_id, currency, status)
         VALUES ($1, $2, $3, 'USD', 'ACTIVE')
         ON CONFLICT (grid_internal_account_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [userId, result.gridCustomerId, result.internalAccountId]
      );
    }
    await client.query('COMMIT');
    result.flows.persistMapping = { ok: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* ignore */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
  return result;
}

async function phaseMoney(result) {
  if (!result.internalAccountId) throw new Error('internal account missing');
  const fund = await gridClient.sandboxFundInternalAccount(result.internalAccountId, 100000, {
    idempotencyKey: `egw-sandbox-fund-${result.platformCustomerId}`,
  });
  result.flows.sandboxFund = {
    ok: fund.ok === true,
    httpStatus: fund.httpStatus,
    balancePresent: !!(fund.data && (fund.data.balance || fund.data.id)),
  };

  const transfer = await gridClient.createTransferOut({
    source: { accountId: result.internalAccountId },
    destination: { accountId: result.externalAccountId },
    amount: 100,
    remittanceInformation: 'EGWallet sandbox verify',
  }, { idempotencyKey: `egw-sandbox-xfer-${result.platformCustomerId}` });
  result.flows.transferOut = {
    ok: transfer.ok === true,
    httpStatus: transfer.httpStatus,
    transactionPrefix: clipId(transfer.data && transfer.data.id),
    status: transfer.data && transfer.data.status ? String(transfer.data.status) : null,
  };
  result.outgoingTransactionId = transfer.data && transfer.data.id;

  if (result.outgoingTransactionId) {
    const tx = await gridClient.getTransaction(result.outgoingTransactionId);
    result.flows.transactionReconcile = {
      ok: tx.ok === true,
      httpStatus: tx.httpStatus,
      status: tx.data && tx.data.status ? String(tx.data.status) : null,
      type: tx.data && tx.data.type ? String(tx.data.type) : null,
    };
  } else {
    const quote = await gridClient.createQuote({
      source: { sourceType: 'ACCOUNT', accountId: result.internalAccountId },
      destination: { destinationType: 'ACCOUNT', accountId: result.externalAccountId },
      lockedCurrencySide: 'SENDING',
      lockedCurrencyAmount: 100,
      description: 'EGWallet sandbox verify',
    }, { idempotencyKey: `egw-sandbox-quote-${result.platformCustomerId}` });
    result.flows.quoteCreate = {
      ok: quote.ok === true,
      httpStatus: quote.httpStatus,
      quotePrefix: clipId(quote.data && quote.data.id),
    };
    if (quote.ok && quote.data && quote.data.id) {
      const executed = await gridClient.executeQuote(quote.data.id, {
        idempotencyKey: `egw-sandbox-exec-${result.platformCustomerId}`,
      });
      result.flows.quoteExecute = {
        ok: executed.ok === true,
        httpStatus: executed.httpStatus,
        transactionPrefix: clipId(executed.data && (executed.data.id || executed.data.transactionId)),
      };
    }
  }

  const testWh = await gridClient.sendOfficialTestWebhook();
  result.flows.signedTestWebhook = {
    ok: testWh.ok === true,
    httpStatus: testWh.httpStatus,
    endpointStatus: testWh.data && testWh.data.response_status != null ? testWh.data.response_status : null,
  };
  return result;
}

async function phaseCheck(result) {
  const pool = poolFromEnv();
  if (!pool) throw new Error('DATABASE_PUBLIC_URL required for proof queries');
  const client = await pool.connect();
  try {
    const events = await client.query(
      `SELECT event_type, COUNT(*)::int AS count
         FROM grid_webhook_events
        GROUP BY event_type
        ORDER BY event_type`
    );
    const incoming = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM transactions
        WHERE type = 'grid_incoming'
          AND grid_transaction_id IS NOT NULL`
    );
    const stripeBleed = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM transactions
        WHERE type = 'grid_incoming' AND stripe_intent_id IS NOT NULL`
    );
    const wallet = result.walletId
      ? await client.query(
        'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2',
        [result.walletId, 'USD']
      )
      : { rows: [] };
    result.flows.dbProof = {
      webhookTypes: events.rows,
      gridIncomingCount: incoming.rows[0].count,
      gridIncomingWithStripeIntent: stripeBleed.rows[0].count,
      syntheticWalletUsd: wallet.rows[0] ? Number(wallet.rows[0].amount) : null,
    };
  } finally {
    client.release();
    await pool.end();
  }
  return result;
}

async function main() {
  const phase = process.argv[2] || 'all';
  let result = loadResult();
  result.flows = result.flows || {};
  result.environment = 'sandbox';
  result.startedAt = result.startedAt || new Date().toISOString();

  if (phase === 'api' || phase === 'all') result = await phaseApi(result);
  if (phase === 'persist' || phase === 'all') result = await phasePersist(result);
  if (phase === 'money' || phase === 'all') result = await phaseMoney(result);
  if (phase === 'check' || phase === 'all') result = await phaseCheck(result);

  result.finishedAt = new Date().toISOString();
  saveResult(result);
  console.log(JSON.stringify({
    phase,
    flows: result.flows,
    customerPrefix: clipId(result.gridCustomerId),
    internalPrefix: clipId(result.internalAccountId),
    externalPrefix: clipId(result.externalAccountId),
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(err && err.message ? err.message : err).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted]'),
  }));
  process.exit(1);
});
