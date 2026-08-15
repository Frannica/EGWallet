'use strict';

/**
 * Lightspark Grid sandbox — routing isolation, official client allowlist,
 * webhook signature/idempotency, payout executor, and failure paths.
 * No live Grid HTTP. No Production. No secrets in assertions.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  OFFICIAL_GRID_API_BASE_URL,
  validateGridEnvironment,
  isGridSandboxConfigured,
  isGridSandboxCountry,
  isGridWebhookPublicKeyConfigured,
} = require('../grid/gridEnv');
const { isAllowedPath, gridRequest, createTransferOut, createQuote, executeQuote } = require('../grid/gridClient');
const { verifyGridWebhookSignature, handleGridWebhook, processGridWebhookEvent } = require('../grid/gridWebhook');
const { lightsparkPayout, buildExternalAccountBody, queryLightsparkStatus } = require('../grid/gridPayout');
const { payoutRouter, isPayoutProviderReady, dispatchToProvider } = require('../payoutProviders');
const gridDb = require('../db/gridPostgres');

const SECRET_CANARY = 'grid-secret-must-never-appear-in-errors';
const GRID_KEYS = [
  'GRID_CLIENT_ID',
  'GRID_CLIENT_SECRET',
  'GRID_ENVIRONMENT',
  'GRID_API_BASE_URL',
  'GRID_WEBHOOK_PUBLIC_KEY',
  'GRID_SANDBOX_COUNTRIES',
  'STRIPE_CONNECT_ENABLED',
  'STRIPE_CONNECT_APPROVED_COUNTRIES',
];

function snapshotEnv() {
  const snap = {};
  for (const key of GRID_KEYS) snap[key] = process.env[key];
  return snap;
}
function restoreEnv(snap) {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function clearGridEnv() {
  for (const key of GRID_KEYS) {
    if (key.startsWith('GRID_')) delete process.env[key];
  }
}
function setValidSandboxEnv() {
  process.env.GRID_CLIENT_ID = 'test-grid-client-id';
  process.env.GRID_CLIENT_SECRET = SECRET_CANARY;
  process.env.GRID_ENVIRONMENT = 'sandbox';
  process.env.GRID_API_BASE_URL = OFFICIAL_GRID_API_BASE_URL;
}

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const payoutSource = fs.readFileSync(path.join(__dirname, '..', 'payoutProviders.js'), 'utf8');
const webhookSource = fs.readFileSync(path.join(__dirname, '..', 'grid', 'gridWebhook.js'), 'utf8');

describe('Lightspark Grid sandbox', { concurrency: 1 }, () => {
test('routing isolation: Grid configured sends US/GB/EU to lightspark and keeps Kora eight on Kora', () => {
  const snap = snapshotEnv();
  try {
    clearGridEnv();
    delete process.env.STRIPE_CONNECT_ENABLED;
    delete process.env.STRIPE_CONNECT_APPROVED_COUNTRIES;
    setValidSandboxEnv();
    assert.equal(isGridSandboxConfigured(), true);
    for (const country of ['NG', 'KE', 'ZA', 'GH', 'CI', 'CM', 'EG', 'TZ']) {
      assert.equal(payoutRouter(country), 'kora', `${country} must stay on Kora`);
      assert.equal(isGridSandboxCountry(country), false);
    }
    assert.equal(payoutRouter('US'), 'lightspark');
    assert.equal(payoutRouter('GB'), 'lightspark');
    assert.equal(payoutRouter('DE'), 'lightspark');
    assert.equal(payoutRouter('FR'), 'lightspark');
    assert.equal(payoutRouter('GQ'), null);
    assert.equal(payoutRouter('SN'), null);
    assert.equal(isPayoutProviderReady('US'), true);
  } finally {
    restoreEnv(snap);
  }
});

test('routing isolation: Stripe Connect is checked before Grid; Kora still wins over both', () => {
  const snap = snapshotEnv();
  try {
    setValidSandboxEnv();
    process.env.STRIPE_CONNECT_ENABLED = 'true';
    process.env.STRIPE_CONNECT_APPROVED_COUNTRIES = 'US';
    // This worker has no Stripe client, so Connect stays inert and Grid
    // takes US. stripe-connect.test.js covers the live Connect win when
    // STRIPE_SECRET_KEY is present. Source order must stay Connect-then-Grid.
    assert.match(payoutSource, /isCountryStripeConnectApproved\(iso2\)\) return 'stripe_connect'/);
    assert.match(payoutSource, /isGridSandboxCountry\(iso2\)\) return 'lightspark'/);
    assert.ok(
      payoutSource.indexOf("return 'stripe_connect'") < payoutSource.indexOf("return 'lightspark'")
    );
    assert.equal(payoutRouter('NG'), 'kora');
    assert.equal(payoutRouter('US'), 'lightspark');
    assert.equal(payoutRouter('GB'), 'lightspark');
  } finally {
    restoreEnv(snap);
  }
});

test('routing isolation: Kora countries cannot be forced onto Grid via GRID_SANDBOX_COUNTRIES', () => {
  const snap = snapshotEnv();
  try {
    setValidSandboxEnv();
    process.env.GRID_SANDBOX_COUNTRIES = 'US,NG,KE';
    assert.equal(payoutRouter('NG'), 'kora');
    assert.equal(payoutRouter('KE'), 'kora');
    assert.equal(isGridSandboxCountry('NG'), false);
    assert.equal(payoutRouter('US'), 'lightspark');
  } finally {
    restoreEnv(snap);
  }
});

test('dispatchToProvider isolation: lightspark never calls Kora; unknown never defaults to Kora', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const snap = snapshotEnv();
  try {
    clearGridEnv();
    await assert.rejects(
      () => dispatchToProvider('lightspark', { id: 'wd-grid', userId: 'u1', currency: 'USD', netPayout: 100 }, logger),
      /not configured/
    );
    await assert.rejects(
      () => dispatchToProvider('unknown', { id: 'wd-x' }, logger),
      /No payout executor for provider unknown/
    );
    await assert.rejects(
      () => dispatchToProvider(null, { id: 'wd-null' }, logger),
      /No payout executor for provider none/
    );
    assert.match(payoutSource, /if \(provider === 'lightspark'\) \{\s*return lightsparkPayout/);
    assert.doesNotMatch(payoutSource, /else \{\s*return koraPayout/);
  } finally {
    restoreEnv(snap);
  }
});

test('official client rejects invented paths and does not leak the client secret', async () => {
  const snap = snapshotEnv();
  try {
    setValidSandboxEnv();
    const blocked = await gridRequest({ method: 'POST', path: '/transfer-in', body: { amount: 1 } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'path_not_allowed');
    assert.doesNotMatch(JSON.stringify(blocked), new RegExp(SECRET_CANARY));
    assert.equal(isAllowedPath('POST', '/sandbox/internal-accounts/InternalAccount:abc-1/fund'), true);
    assert.equal(isAllowedPath('POST', '/sandbox/internal-accounts/InternalAccount:abc-1/debit'), false);
  } finally {
    restoreEnv(snap);
  }
});

test('createTransferOut and quote execute use official paths and Idempotency-Key', async () => {
  const snap = snapshotEnv();
  try {
    setValidSandboxEnv();
    const calls = [];
    const axiosImpl = async (config) => {
      calls.push(config);
      return { status: 201, data: { id: 'Transaction:019542f5-b3e7-1d02-0000-000000000001', status: 'PENDING' } };
    };
    const transfer = await createTransferOut(
      { source: { accountId: 'InternalAccount:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123' }, destination: { accountId: 'ExternalAccount:e85dcbd6-dced-4ec4-b756-3c3a9ea3d965' }, amount: 12550 },
      { axiosImpl, idempotencyKey: 'egw-wd-1' }
    );
    assert.equal(transfer.ok, true);
    assert.equal(calls[0].url, `${OFFICIAL_GRID_API_BASE_URL}/transfer-out`);
    assert.equal(calls[0].headers['Idempotency-Key'], 'egw-wd-1');
    assert.doesNotMatch(JSON.stringify(transfer), new RegExp(SECRET_CANARY));

    const quote = await createQuote({
      source: { sourceType: 'ACCOUNT', accountId: 'InternalAccount:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123' },
      destination: { destinationType: 'ACCOUNT', accountId: 'ExternalAccount:e85dcbd6-dced-4ec4-b756-3c3a9ea3d965' },
      lockedCurrencySide: 'SENDING',
      lockedCurrencyAmount: 10000,
    }, { axiosImpl });
    assert.equal(quote.ok, true);
    assert.equal(calls[1].url, `${OFFICIAL_GRID_API_BASE_URL}/quotes`);

    const executed = await executeQuote('Quote:019542f5-b3e7-1d02-0000-000000000006', { axiosImpl });
    assert.equal(executed.ok, true);
    assert.equal(calls[2].url, `${OFFICIAL_GRID_API_BASE_URL}/quotes/Quote:019542f5-b3e7-1d02-0000-000000000006/execute`);
  } finally {
    restoreEnv(snap);
  }
});

test('USD/EUR/GBP external-account bodies match official Grid account types', () => {
  const usd = buildExternalAccountBody({
    customerId: 'Customer:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123',
    withdrawal: { accountNumber: '123456789', routingNumber: '021000021', accountHolderName: 'Ada Lovelace' },
    currency: 'USD',
    userId: 'user-1',
  });
  assert.equal(usd.accountInfo.accountType, 'USD_ACCOUNT');
  assert.equal(usd.accountInfo.routingNumber, '021000021');
  assert.equal(usd.accountInfo.bankAccountType, 'CHECKING');

  const eur = buildExternalAccountBody({
    customerId: 'Customer:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123',
    withdrawal: { iban: 'DE89370400440532013000', accountHolderName: 'Ada Lovelace' },
    currency: 'EUR',
    userId: 'user-1',
  });
  assert.equal(eur.accountInfo.accountType, 'EUR_ACCOUNT');
  assert.equal(eur.accountInfo.iban, 'DE89370400440532013000');

  const gbp = buildExternalAccountBody({
    customerId: 'Customer:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123',
    withdrawal: { accountNumber: '12345678', bankCode: '123456', accountHolderName: 'Ada Lovelace' },
    currency: 'GBP',
    userId: 'user-1',
  });
  assert.equal(gbp.accountInfo.accountType, 'GBP_ACCOUNT');
  assert.equal(gbp.accountInfo.sortCode, '123456');
});

test('X-Grid-Signature verifies SHA-256 against GRID_WEBHOOK_PUBLIC_KEY over the raw body', () => {
  const snap = snapshotEnv();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const rawBody = Buffer.from('{"id":"wh_1","type":"TEST","data":{}}', 'utf8');
  const signer = crypto.createSign('SHA256');
  signer.update(rawBody);
  signer.end();
  const signature = signer.sign(privateKey);
  const header = JSON.stringify({ v: '1', s: signature.toString('base64') });
  try {
    process.env.GRID_WEBHOOK_PUBLIC_KEY = pem.replace(/\n/g, '\\n');
    assert.equal(isGridWebhookPublicKeyConfigured(), true);
    assert.equal(verifyGridWebhookSignature(rawBody, header).ok, true);
    assert.equal(verifyGridWebhookSignature(Buffer.from('{"tampered":true}'), header).ok, false);
    assert.equal(verifyGridWebhookSignature(rawBody, '{"v":"1","s":"AAAA"}').ok, false);
  } finally {
    restoreEnv(snap);
  }
});

test('webhook handler returns 503 when GRID_WEBHOOK_PUBLIC_KEY is missing', async () => {
  const snap = snapshotEnv();
  try {
    delete process.env.GRID_WEBHOOK_PUBLIC_KEY;
    const result = await handleGridWebhook({
      rawBody: Buffer.from('{"id":"wh_1","type":"TEST"}'),
      signatureHeader: '{"v":"1","s":"AAAA"}',
      parsedBody: { id: 'wh_1', type: 'TEST' },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(result.status, 503);
  } finally {
    restoreEnv(snap);
  }
});

test('duplicate Grid webhooks are acknowledged and not processed twice', async () => {
  const snap = snapshotEnv();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const parsedBody = { id: 'wh_dup_1', type: 'TEST', data: {} };
  const rawBody = Buffer.from(JSON.stringify(parsedBody), 'utf8');
  const signer = crypto.createSign('SHA256');
  signer.update(rawBody);
  signer.end();
  const header = JSON.stringify({ v: '1', s: signer.sign(privateKey).toString('base64') });

  const originalReserve = gridDb.reserveGridWebhookEvent;
  const originalMark = gridDb.markGridWebhookEventProcessed;
  let reserveCalls = 0;
  let processMarks = 0;
  gridDb.reserveGridWebhookEvent = async () => {
    reserveCalls += 1;
    return reserveCalls === 1;
  };
  gridDb.markGridWebhookEventProcessed = async () => { processMarks += 1; };

  try {
    process.env.GRID_WEBHOOK_PUBLIC_KEY = pem;
    const first = await handleGridWebhook({
      rawBody, signatureHeader: header, parsedBody,
      logger: { info() {}, warn() {}, error() {} },
    });
    const second = await handleGridWebhook({
      rawBody, signatureHeader: header, parsedBody,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, undefined);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(reserveCalls, 2);
    assert.equal(processMarks, 1);
  } finally {
    gridDb.reserveGridWebhookEvent = originalReserve;
    gridDb.markGridWebhookEventProcessed = originalMark;
    restoreEnv(snap);
  }
});

test('incoming Grid payments are acknowledged and never treated as EGWallet deposits', async () => {
  const logs = [];
  const result = await processGridWebhookEvent(
    { id: 'wh_in', type: 'INCOMING_PAYMENT.COMPLETED', data: { id: 'Transaction:abc-1', amount: 5000 } },
    { info: (msg) => logs.push(msg), warn() {}, error() {} }
  );
  assert.equal(result.handled, true);
  assert.match(logs.join('\n'), /Incoming payment ignored for ledger/);
  assert.match(webhookSource, /Incoming payments never credit EGWallet/);
  assert.doesNotMatch(webhookSource, /markWithdrawalPaid\(db, withdrawalId, transactionId, 'stripe'\)/);
});

test('lightsparkPayout funds sandbox, transfer-out, and stays off Kora/Stripe', async () => {
  const snap = snapshotEnv();
  const originalCustomer = gridDb.getGridCustomerByUserId;
  const originalListExt = gridDb.listGridExternalAccounts;
  const originalUpsertExt = gridDb.upsertGridExternalAccount;
  const originalUpsertInt = gridDb.upsertGridInternalAccount;
  const originalUpsertQuote = gridDb.upsertGridQuote;
  const originalUpdateRefs = gridDb.updateWithdrawalGridRefs;
  gridDb.getGridCustomerByUserId = async () => ({
    user_id: 'user-1',
    grid_customer_id: 'Customer:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123',
  });
  gridDb.listGridExternalAccounts = async () => [];
  gridDb.upsertGridExternalAccount = async () => ({});
  gridDb.upsertGridInternalAccount = async () => ({});
  gridDb.upsertGridQuote = async () => ({});
  gridDb.updateWithdrawalGridRefs = async () => ({});

  const calls = [];
  const axiosImpl = async (config) => {
    calls.push({ method: config.method, url: config.url, body: config.data });
    if (config.url.endsWith('/customers/external-accounts') && config.method === 'POST') {
      return { status: 201, data: { id: 'ExternalAccount:e85dcbd6-dced-4ec4-b756-3c3a9ea3d965', status: 'ACTIVE' } };
    }
    if (config.url.endsWith('/customers/internal-accounts')) {
      return {
        status: 200,
        data: {
          data: [{
            id: 'InternalAccount:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123',
            currency: { code: 'USD' },
            status: 'ACTIVE',
            balance: { amount: 0 },
          }],
        },
      };
    }
    if (String(config.url).includes('/sandbox/internal-accounts/') && String(config.url).endsWith('/fund')) {
      return { status: 200, data: { ok: true } };
    }
    if (config.url.endsWith('/transfer-out')) {
      return { status: 201, data: { id: 'Transaction:019542f5-b3e7-1d02-0000-000000000001', status: 'PENDING' } };
    }
    return { status: 404, data: { message: 'unexpected' } };
  };

  try {
    setValidSandboxEnv();
    const result = await lightsparkPayout({
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      currency: 'USD',
      netPayout: 12550,
      accountNumber: '123456789',
      routingNumber: '021000021',
      accountHolderName: 'Ada Lovelace',
    }, { info() {}, warn() {}, error() {} }, { axiosImpl });
    assert.equal(result.provider, 'lightspark');
    assert.equal(result.settled, false);
    assert.equal(result.reference, 'Transaction:019542f5-b3e7-1d02-0000-000000000001');
    assert.ok(calls.some((c) => c.url.endsWith('/transfer-out')));
    assert.ok(calls.some((c) => String(c.url).includes('/sandbox/internal-accounts/')));
    assert.ok(!calls.some((c) => String(c.url).includes('korapay')));
    assert.ok(!calls.some((c) => String(c.url).includes('stripe')));
  } finally {
    gridDb.getGridCustomerByUserId = originalCustomer;
    gridDb.listGridExternalAccounts = originalListExt;
    gridDb.upsertGridExternalAccount = originalUpsertExt;
    gridDb.upsertGridInternalAccount = originalUpsertInt;
    gridDb.upsertGridQuote = originalUpsertQuote;
    gridDb.updateWithdrawalGridRefs = originalUpdateRefs;
    restoreEnv(snap);
  }
});

test('lightsparkPayout uses official quote + execute when sending and receiving currencies differ', async () => {
  const snap = snapshotEnv();
  const originalCustomer = gridDb.getGridCustomerByUserId;
  const originalListExt = gridDb.listGridExternalAccounts;
  const originalUpsertExt = gridDb.upsertGridExternalAccount;
  const originalUpsertInt = gridDb.upsertGridInternalAccount;
  const originalUpsertQuote = gridDb.upsertGridQuote;
  const originalUpdateRefs = gridDb.updateWithdrawalGridRefs;
  gridDb.getGridCustomerByUserId = async () => ({
    user_id: 'user-1',
    grid_customer_id: 'Customer:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123',
  });
  gridDb.listGridExternalAccounts = async () => [{
    grid_external_account_id: 'ExternalAccount:e85dcbd6-dced-4ec4-b756-3c3a9ea3d965',
    currency: 'EUR',
    status: 'ACTIVE',
  }];
  gridDb.upsertGridExternalAccount = async () => ({});
  gridDb.upsertGridInternalAccount = async () => ({});
  gridDb.upsertGridQuote = async () => ({});
  gridDb.updateWithdrawalGridRefs = async () => ({});

  const calls = [];
  const axiosImpl = async (config) => {
    calls.push(config.url);
    if (String(config.url).endsWith('/customers/internal-accounts')) {
      return {
        status: 200,
        data: { data: [{ id: 'InternalAccount:a12dcbd6-dced-4ec4-b756-3c3a9ea3d123', currency: { code: 'USD' }, status: 'ACTIVE', balance: { amount: 50000 } }] },
      };
    }
    if (String(config.url).endsWith('/quotes')) {
      return { status: 201, data: { id: 'Quote:019542f5-b3e7-1d02-0000-000000000006', status: 'PENDING' } };
    }
    if (String(config.url).endsWith('/execute')) {
      return { status: 200, data: { transactionId: 'Transaction:019542f5-b3e7-1d02-0000-000000000009', status: 'PROCESSING' } };
    }
    return { status: 404, data: {} };
  };

  try {
    setValidSandboxEnv();
    const result = await lightsparkPayout({
      id: '22222222-2222-2222-2222-222222222222',
      userId: 'user-1',
      currency: 'USD',
      destinationCurrency: 'EUR',
      netPayout: 10000,
      gridExternalAccountId: 'ExternalAccount:e85dcbd6-dced-4ec4-b756-3c3a9ea3d965',
    }, { info() {}, warn() {}, error() {} }, { axiosImpl });
    assert.equal(result.provider, 'lightspark');
    assert.ok(calls.some((url) => url.endsWith('/quotes')));
    assert.ok(calls.some((url) => url.endsWith('/execute')));
    assert.ok(!calls.some((url) => url.endsWith('/transfer-out')));
  } finally {
    gridDb.getGridCustomerByUserId = originalCustomer;
    gridDb.listGridExternalAccounts = originalListExt;
    gridDb.upsertGridExternalAccount = originalUpsertExt;
    gridDb.upsertGridInternalAccount = originalUpsertInt;
    gridDb.upsertGridQuote = originalUpsertQuote;
    gridDb.updateWithdrawalGridRefs = originalUpdateRefs;
    restoreEnv(snap);
  }
});

test('queryLightsparkStatus maps official transaction statuses without leaking secrets', async () => {
  const snap = snapshotEnv();
  try {
    setValidSandboxEnv();
    const paid = await queryLightsparkStatus('Transaction:019542f5-b3e7-1d02-0000-000000000001', {
      axiosImpl: async () => ({ status: 200, data: { id: 'Transaction:019542f5-b3e7-1d02-0000-000000000001', status: 'COMPLETED' } }),
    });
    assert.equal(paid.status, 'paid');
    const failed = await queryLightsparkStatus('Transaction:019542f5-b3e7-1d02-0000-000000000001', {
      axiosImpl: async () => ({ status: 200, data: { status: 'FAILED' } }),
    });
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(JSON.stringify(paid), new RegExp(SECRET_CANARY));
  } finally {
    restoreEnv(snap);
  }
});

test('index.js registers HTTPS Grid webhook on raw body before express.json and mounts /grid', () => {
  const webhookIdx = indexSource.indexOf("app.post('/webhooks/grid'");
  const globalJsonMatch = indexSource.match(/^app\.use\(express\.json\(/m);
  assert.ok(webhookIdx > -1, 'POST /webhooks/grid must exist');
  assert.ok(globalJsonMatch, 'global express.json() must exist');
  assert.ok(webhookIdx < globalJsonMatch.index, 'Grid webhook must be registered before the global JSON parser');
  assert.match(indexSource, /app\.use\('\/grid', createGridRouter\(authMiddleware\)\)/);
  assert.match(indexSource, /x-grid-signature/);
  assert.match(indexSource, /GRID_ONBOARDING_REQUIRED/);
  assert.doesNotMatch(indexSource, /require\('\.\/payout'\)/);
});

test('production Grid environment remains boot-fatal and is never treated as configured', () => {
  const snap = snapshotEnv();
  try {
    process.env.GRID_CLIENT_ID = 'id';
    process.env.GRID_CLIENT_SECRET = SECRET_CANARY;
    process.env.GRID_ENVIRONMENT = 'production';
    process.env.GRID_API_BASE_URL = OFFICIAL_GRID_API_BASE_URL;
    const result = validateGridEnvironment({ requireConfigured: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('GRID_ENVIRONMENT must be sandbox'));
    assert.ok(result.errors.every((msg) => !msg.includes(SECRET_CANARY)));
  } finally {
    restoreEnv(snap);
  }
});
});
