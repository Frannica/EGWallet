'use strict';

/**
 * Lightspark Grid HTTP client — official API 2025-10-13 only.
 *
 * Auth: HTTP Basic Auth (GRID_CLIENT_ID / GRID_CLIENT_SECRET).
 * Environment: sandbox only (see gridEnv.js).
 *
 * Paths are allowlisted from docs.lightspark.com. This module never logs
 * credentials or response PII.
 */

const axios = require('axios');
const {
  validateGridEnvironment,
  isGridSandboxConfigured,
  isGridWebhookPublicKeyConfigured,
  getGridBasicAuth,
  OFFICIAL_GRID_API_BASE_URL,
} = require('./gridEnv');

const GRID_RESOURCE_ID = /^(Customer|ExternalAccount|InternalAccount|Quote|Transaction):[A-Za-z0-9-]+$/;

let lastConnectivity = {
  checked: false,
  ok: false,
  httpStatus: null,
  reason: 'not_checked',
};

function getGridHealthFlags() {
  return {
    gridSandboxConfigured: isGridSandboxConfigured(),
    gridConnectivityOk: lastConnectivity.ok === true,
    gridWebhookPublicKeyConfigured: isGridWebhookPublicKeyConfigured(),
  };
}

function getLastGridConnectivity() {
  return { ...lastConnectivity };
}

function resetGridConnectivityCache() {
  lastConnectivity = {
    checked: false,
    ok: false,
    httpStatus: null,
    reason: 'not_checked',
  };
}

function isAllowedPath(method, path) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET') {
    if (path === '/config') return true;
    if (path === '/customers/end-user-terms') return true;
    if (path === '/customers/internal-accounts') return true;
    if (path === '/customers/external-accounts') return true;
    if (path === '/platform/internal-accounts') return true;
    if (path === '/discoveries') return true;
    if (/^\/customers\/Customer:[A-Za-z0-9-]+$/.test(path)) return true;
    if (/^\/customers\/external-accounts\/ExternalAccount:[A-Za-z0-9-]+$/.test(path)) return true;
    if (/^\/quotes\/Quote:[A-Za-z0-9-]+$/.test(path)) return true;
    if (/^\/transactions\/Transaction:[A-Za-z0-9-]+$/.test(path)) return true;
    return false;
  }
  if (m === 'POST') {
    if (path === '/customers') return true;
    if (path === '/customers/external-accounts') return true;
    if (path === '/quotes') return true;
    if (path === '/transfer-out') return true;
    if (path === '/sandbox/webhooks/test') return true;
    if (path === '/webhooks/test') return true;
    if (/^\/customers\/Customer:[A-Za-z0-9-]+\/kyc-link$/.test(path)) return true;
    if (/^\/quotes\/Quote:[A-Za-z0-9-]+\/execute$/.test(path)) return true;
    if (/^\/sandbox\/internal-accounts\/InternalAccount:[A-Za-z0-9-]+\/fund$/.test(path)) return true;
    return false;
  }
  if (m === 'PATCH') {
    return /^\/customers\/Customer:[A-Za-z0-9-]+$/.test(path);
  }
  return false;
}

function assertResourceId(id, prefix) {
  if (!id || typeof id !== 'string' || !id.startsWith(`${prefix}:`) || !GRID_RESOURCE_ID.test(id)) {
    const err = new Error(`Invalid Grid ${prefix} id`);
    err.status = 400;
    throw err;
  }
  return id;
}

/**
 * @param {{ method: string, path: string, body?: object, params?: object, idempotencyKey?: string, axiosImpl?: typeof axios, timeout?: number }} opts
 */
async function gridRequest(opts) {
  const method = String(opts.method || 'GET').toUpperCase();
  const path = opts.path;
  const axiosImpl = opts.axiosImpl || axios;

  const env = validateGridEnvironment({ requireConfigured: true });
  if (!env.ok) {
    return { ok: false, httpStatus: null, reason: 'not_configured', data: null };
  }
  const auth = getGridBasicAuth();
  if (!auth || auth.apiBaseUrl !== OFFICIAL_GRID_API_BASE_URL) {
    return { ok: false, httpStatus: null, reason: 'not_configured', data: null };
  }
  if (!isAllowedPath(method, path)) {
    return { ok: false, httpStatus: null, reason: 'path_not_allowed', data: null };
  }

  const headers = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey);

  try {
    const response = await axiosImpl({
      method,
      url: `${auth.apiBaseUrl}${path}`,
      auth: { username: auth.username, password: auth.password },
      headers,
      params: opts.params || undefined,
      data: opts.body,
      timeout: opts.timeout || 20_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const httpStatus = response && response.status ? response.status : null;
    const data = response && response.data !== undefined ? response.data : null;
    if (httpStatus >= 200 && httpStatus < 300) {
      return { ok: true, httpStatus, reason: 'ok', data };
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return { ok: false, httpStatus, reason: 'unauthorized', data: null };
    }
    return { ok: false, httpStatus, reason: 'unexpected_status', data };
  } catch (_err) {
    return { ok: false, httpStatus: null, reason: 'unreachable', data: null };
  }
}

async function checkGridConnectivity(options = {}) {
  const result = await gridRequest({ method: 'GET', path: '/config', axiosImpl: options.axiosImpl, timeout: 10_000 });
  return {
    ok: result.ok,
    httpStatus: result.httpStatus,
    reason: result.reason,
  };
}

async function probeGridConnectivity(options = {}) {
  const result = await checkGridConnectivity(options);
  lastConnectivity = {
    checked: true,
    ok: result.ok === true,
    httpStatus: result.httpStatus,
    reason: result.reason,
  };
  return { ...lastConnectivity };
}

async function getEndUserTerms(options = {}) {
  return gridRequest({ method: 'GET', path: '/customers/end-user-terms', axiosImpl: options.axiosImpl });
}

async function createCustomer(body, options = {}) {
  return gridRequest({
    method: 'POST',
    path: '/customers',
    body,
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function getCustomer(customerId, options = {}) {
  assertResourceId(customerId, 'Customer');
  return gridRequest({
    method: 'GET',
    path: `/customers/${customerId}`,
    axiosImpl: options.axiosImpl,
  });
}

async function updateCustomer(customerId, body, options = {}) {
  assertResourceId(customerId, 'Customer');
  return gridRequest({
    method: 'PATCH',
    path: `/customers/${customerId}`,
    body,
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function createKycLink(customerId, body, options = {}) {
  assertResourceId(customerId, 'Customer');
  return gridRequest({
    method: 'POST',
    path: `/customers/${customerId}/kyc-link`,
    body: body || {},
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function createExternalAccount(body, options = {}) {
  return gridRequest({
    method: 'POST',
    path: '/customers/external-accounts',
    body,
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function listExternalAccounts(params, options = {}) {
  return gridRequest({
    method: 'GET',
    path: '/customers/external-accounts',
    params,
    axiosImpl: options.axiosImpl,
  });
}

async function listInternalAccounts(params, options = {}) {
  return gridRequest({
    method: 'GET',
    path: '/customers/internal-accounts',
    params,
    axiosImpl: options.axiosImpl,
  });
}

async function listPlatformInternalAccounts(params, options = {}) {
  return gridRequest({
    method: 'GET',
    path: '/platform/internal-accounts',
    params,
    axiosImpl: options.axiosImpl,
  });
}

async function sandboxFundInternalAccount(accountId, amount, options = {}) {
  assertResourceId(accountId, 'InternalAccount');
  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error('Sandbox fund amount must be a positive integer in minor units');
    err.status = 400;
    throw err;
  }
  return gridRequest({
    method: 'POST',
    path: `/sandbox/internal-accounts/${accountId}/fund`,
    body: { amount },
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function createQuote(body, options = {}) {
  return gridRequest({
    method: 'POST',
    path: '/quotes',
    body,
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function getQuote(quoteId, options = {}) {
  assertResourceId(quoteId, 'Quote');
  return gridRequest({
    method: 'GET',
    path: `/quotes/${quoteId}`,
    axiosImpl: options.axiosImpl,
  });
}

async function executeQuote(quoteId, options = {}) {
  assertResourceId(quoteId, 'Quote');
  return gridRequest({
    method: 'POST',
    path: `/quotes/${quoteId}/execute`,
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function createTransferOut(body, options = {}) {
  return gridRequest({
    method: 'POST',
    path: '/transfer-out',
    body,
    idempotencyKey: options.idempotencyKey,
    axiosImpl: options.axiosImpl,
  });
}

async function getTransaction(transactionId, options = {}) {
  assertResourceId(transactionId, 'Transaction');
  return gridRequest({
    method: 'GET',
    path: `/transactions/${transactionId}`,
    axiosImpl: options.axiosImpl,
  });
}

async function listDiscoveries(params, options = {}) {
  return gridRequest({
    method: 'GET',
    path: '/discoveries',
    params,
    axiosImpl: options.axiosImpl,
  });
}

async function sendOfficialTestWebhook(options = {}) {
  return gridRequest({
    method: 'POST',
    path: '/webhooks/test',
    axiosImpl: options.axiosImpl,
    timeout: options.timeout || 30_000,
  });
}

module.exports = {
  isAllowedPath,
  gridRequest,
  checkGridConnectivity,
  probeGridConnectivity,
  getGridHealthFlags,
  getLastGridConnectivity,
  resetGridConnectivityCache,
  getEndUserTerms,
  createCustomer,
  getCustomer,
  updateCustomer,
  createKycLink,
  createExternalAccount,
  listExternalAccounts,
  listInternalAccounts,
  listPlatformInternalAccounts,
  sandboxFundInternalAccount,
  createQuote,
  getQuote,
  executeQuote,
  createTransferOut,
  getTransaction,
  listDiscoveries,
  sendOfficialTestWebhook,
};
