'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  isGridSandboxConfigured,
  isGridWebhookPublicKeyConfigured,
  getGridSandboxCountries,
} = require('./gridEnv');
const gridClient = require('./gridClient');
const {
  getGridCustomerByUserId,
  upsertGridCustomer,
  listGridExternalAccounts,
  upsertGridExternalAccount,
  upsertGridInternalAccount,
} = require('../db/gridPostgres');
const { maskAccountNumber } = require('../piiCipher');

function publicCustomer(row) {
  if (!row) return null;
  return {
    gridCustomerId: row.grid_customer_id,
    kycStatus: row.kyc_status,
    termsVersion: row.terms_version,
    termsAcceptedAt: row.terms_accepted_at,
  };
}

function createGridRouter(authMiddleware) {
  const router = express.Router();

  router.get('/status', authMiddleware, async (req, res) => {
    const configured = isGridSandboxConfigured();
    const customer = configured ? await getGridCustomerByUserId(req.user.userId) : null;
    res.json({
      configured,
      webhookPublicKeyConfigured: isGridWebhookPublicKeyConfigured(),
      countries: configured ? [...getGridSandboxCountries()].sort() : [],
      customer: publicCustomer(customer),
    });
  });

  router.get('/end-user-terms', authMiddleware, async (req, res) => {
    if (!isGridSandboxConfigured()) {
      return res.status(503).json({ error: 'Lightspark Grid sandbox is not configured', errorCode: 'GRID_NOT_CONFIGURED' });
    }
    const result = await gridClient.getEndUserTerms();
    if (!result.ok) {
      return res.status(result.httpStatus || 502).json({ error: 'Unable to load Grid End User Terms', errorCode: 'GRID_TERMS_UNAVAILABLE' });
    }
    res.json({ version: result.data.version, url: result.data.url });
  });

  router.get('/customers/me', authMiddleware, async (req, res) => {
    const row = await getGridCustomerByUserId(req.user.userId);
    if (!row) return res.status(404).json({ error: 'Grid customer not found', errorCode: 'GRID_CUSTOMER_NOT_FOUND' });
    res.json({ customer: publicCustomer(row) });
  });

  router.post('/customers', authMiddleware, async (req, res) => {
    if (!isGridSandboxConfigured()) {
      return res.status(503).json({ error: 'Lightspark Grid sandbox is not configured', errorCode: 'GRID_NOT_CONFIGURED' });
    }
    const existing = await getGridCustomerByUserId(req.user.userId);
    if (existing) return res.json({ customer: publicCustomer(existing), replay: true });

    const {
      fullName, birthDate, nationality, region, phoneNumber, address,
      acceptanceMethod, currencies,
    } = req.body || {};
    if (!fullName || !acceptanceMethod) {
      return res.status(400).json({ error: 'fullName and acceptanceMethod are required', errorCode: 'GRID_TERMS_REQUIRED' });
    }
    if (acceptanceMethod !== 'CHECKBOX' && acceptanceMethod !== 'CLICK_TO_ACCEPT') {
      return res.status(400).json({ error: 'acceptanceMethod must be CHECKBOX or CLICK_TO_ACCEPT' });
    }

    const terms = await gridClient.getEndUserTerms();
    if (!terms.ok || !terms.data || !terms.data.version) {
      return res.status(502).json({ error: 'Unable to load Grid End User Terms', errorCode: 'GRID_TERMS_UNAVAILABLE' });
    }

    const platformCustomerId = req.user.userId;
    const body = {
      customerType: 'INDIVIDUAL',
      platformCustomerId,
      region: region || 'US',
      currencies: Array.isArray(currencies) && currencies.length ? currencies : ['USD'],
      fullName,
      email: req.user.email || undefined,
      endUserTermsConsent: {
        acceptedAt: new Date().toISOString(),
        ipAddress: req.ip || req.headers['x-forwarded-for'] || '0.0.0.0',
        termsVersion: terms.data.version,
        acceptanceMethod,
      },
    };
    if (birthDate) body.birthDate = birthDate;
    if (nationality) body.nationality = nationality;
    if (phoneNumber) body.phoneNumber = phoneNumber;
    if (address && typeof address === 'object') body.address = address;

    const created = await gridClient.createCustomer(body, {
      idempotencyKey: req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || `egw-cust-${req.user.userId}`,
    });
    if (!created.ok || !created.data || !created.data.id) {
      return res.status(created.httpStatus || 502).json({
        error: 'Grid customer creation failed',
        errorCode: created.reason === 'unauthorized' ? 'GRID_UNAUTHORIZED' : 'GRID_CUSTOMER_CREATE_FAILED',
      });
    }

    const row = await upsertGridCustomer({
      userId: req.user.userId,
      gridCustomerId: created.data.id,
      platformCustomerId,
      kycStatus: created.data.kycStatus || 'UNVERIFIED',
      customerType: 'INDIVIDUAL',
      termsVersion: terms.data.version,
      termsAcceptedAt: body.endUserTermsConsent.acceptedAt,
      termsAcceptanceMethod: acceptanceMethod,
    });

    const internals = created.data.internalAccounts
      || (await gridClient.listInternalAccounts({ customerId: created.data.id })).data;
    const list = internals && (internals.data || internals);
    if (Array.isArray(list)) {
      for (const account of list) {
        if (account && account.id) {
          await upsertGridInternalAccount({
            userId: req.user.userId,
            gridCustomerId: created.data.id,
            gridInternalAccountId: account.id,
            currency: account.currency?.code || account.currency || 'USD',
            status: account.status || 'ACTIVE',
          });
        }
      }
    }

    res.status(201).json({ customer: publicCustomer(row) });
  });

  router.post('/customers/kyc-link', authMiddleware, async (req, res) => {
    if (!isGridSandboxConfigured()) {
      return res.status(503).json({ error: 'Lightspark Grid sandbox is not configured', errorCode: 'GRID_NOT_CONFIGURED' });
    }
    const customer = await getGridCustomerByUserId(req.user.userId);
    if (!customer) {
      return res.status(400).json({ error: 'Create a Grid customer before requesting a KYC link', errorCode: 'GRID_CUSTOMER_REQUIRED' });
    }
    const redirectUri = req.body && req.body.redirectUri;
    const result = await gridClient.createKycLink(
      customer.grid_customer_id,
      redirectUri ? { redirectUri } : {},
      { idempotencyKey: req.headers['idempotency-key'] || `egw-kyc-${req.user.userId}-${uuidv4()}` }
    );
    if (!result.ok || !result.data) {
      return res.status(result.httpStatus || 502).json({
        error: 'Grid hosted KYC link is unavailable. In sandbox, official docs require POST /customers instead of the KYC link flow.',
        errorCode: 'GRID_KYC_LINK_UNAVAILABLE',
      });
    }
    res.json({
      kycUrl: result.data.kycUrl,
      expiresAt: result.data.expiresAt,
      provider: result.data.provider,
    });
  });

  router.get('/external-accounts', authMiddleware, async (req, res) => {
    const rows = await listGridExternalAccounts(req.user.userId);
    res.json({
      accounts: rows.map((a) => ({
        id: a.grid_external_account_id,
        currency: a.currency,
        status: a.status,
        accountMask: a.account_mask,
        bankName: a.bank_name_display,
      })),
    });
  });

  router.post('/external-accounts', authMiddleware, async (req, res) => {
    if (!isGridSandboxConfigured()) {
      return res.status(503).json({ error: 'Lightspark Grid sandbox is not configured', errorCode: 'GRID_NOT_CONFIGURED' });
    }
    const customer = await getGridCustomerByUserId(req.user.userId);
    if (!customer) {
      return res.status(400).json({ error: 'Create a Grid customer before adding a bank account', errorCode: 'GRID_CUSTOMER_REQUIRED' });
    }
    const { currency, accountInfo, platformAccountId } = req.body || {};
    if (!currency || !accountInfo || !accountInfo.accountType) {
      return res.status(400).json({ error: 'currency and accountInfo.accountType are required' });
    }
    const body = {
      customerId: customer.grid_customer_id,
      currency: String(currency).toUpperCase(),
      platformAccountId: platformAccountId || `egw-${req.user.userId}-${Date.now()}`,
      accountInfo,
    };
    const created = await gridClient.createExternalAccount(body, {
      idempotencyKey: req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || `egw-ext-${req.user.userId}-${uuidv4()}`,
    });
    if (!created.ok || !created.data || !created.data.id) {
      return res.status(created.httpStatus || 502).json({ error: 'Grid external account creation failed', errorCode: 'GRID_EXTERNAL_ACCOUNT_FAILED' });
    }
    const row = await upsertGridExternalAccount({
      userId: req.user.userId,
      gridCustomerId: customer.grid_customer_id,
      gridExternalAccountId: created.data.id,
      currency: body.currency,
      status: created.data.status || 'ACTIVE',
      accountMask: maskAccountNumber(
        accountInfo.accountNumber || accountInfo.iban || accountInfo.sortCode || ''
      ),
      bankNameDisplay: accountInfo.bankName || null,
    });
    res.status(201).json({
      account: {
        id: row.grid_external_account_id,
        currency: row.currency,
        status: row.status,
        accountMask: row.account_mask,
        bankName: row.bank_name_display,
      },
    });
  });

  router.post('/quotes', authMiddleware, async (req, res) => {
    if (!isGridSandboxConfigured()) {
      return res.status(503).json({ error: 'Lightspark Grid sandbox is not configured', errorCode: 'GRID_NOT_CONFIGURED' });
    }
    const { source, destination, lockedCurrencySide, lockedCurrencyAmount, description } = req.body || {};
    if (!source || !destination || !lockedCurrencySide || !lockedCurrencyAmount) {
      return res.status(400).json({ error: 'source, destination, lockedCurrencySide, and lockedCurrencyAmount are required' });
    }
    const result = await gridClient.createQuote({
      source,
      destination,
      lockedCurrencySide,
      lockedCurrencyAmount,
      description,
    }, {
      idempotencyKey: req.headers['idempotency-key'] || `egw-quote-${req.user.userId}-${uuidv4()}`,
    });
    if (!result.ok || !result.data) {
      return res.status(result.httpStatus || 502).json({ error: 'Grid quote creation failed', errorCode: 'GRID_QUOTE_FAILED' });
    }
    res.status(201).json({
      quote: {
        id: result.data.id,
        status: result.data.status,
        expiresAt: result.data.expiresAt,
        totalSendingAmount: result.data.totalSendingAmount,
        totalReceivingAmount: result.data.totalReceivingAmount,
        exchangeRate: result.data.exchangeRate,
        sendingCurrency: result.data.sendingCurrency,
        receivingCurrency: result.data.receivingCurrency,
      },
    });
  });

  return router;
}

module.exports = { createGridRouter, publicCustomer };
