'use strict';

/**
 * Lightspark Grid HTTP client — Phase 0 (read-only).
 *
 * Official authentication: HTTP Basic Auth with GRID_CLIENT_ID / GRID_CLIENT_SECRET.
 * Official connectivity probe: GET /config
 *   https://docs.lightspark.com/api-reference/platform-configuration/get-platform-configuration
 *
 * This client cannot create customers, quotes, transfers, or payouts.
 */

const axios = require('axios');
const {
  validateGridEnvironment,
  isGridSandboxConfigured,
  getGridBasicAuth,
  OFFICIAL_GRID_API_BASE_URL,
} = require('./gridEnv');

const PHASE0_ALLOWED_GET_PATHS = new Set(['/config']);

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
  };
}

function getLastGridConnectivity() {
  return { ...lastConnectivity };
}

/**
 * @param {string} path
 * @param {{ axiosImpl?: typeof axios }} [options]
 */
async function gridGetConfig(options = {}) {
  const axiosImpl = options.axiosImpl || axios;
  const env = validateGridEnvironment({ requireConfigured: true });
  if (!env.ok) {
    return {
      ok: false,
      httpStatus: null,
      reason: 'not_configured',
    };
  }

  const path = '/config';
  if (!PHASE0_ALLOWED_GET_PATHS.has(path)) {
    return { ok: false, httpStatus: null, reason: 'path_not_allowed' };
  }

  const auth = getGridBasicAuth();
  if (!auth) {
    return { ok: false, httpStatus: null, reason: 'not_configured' };
  }
  if (auth.apiBaseUrl !== OFFICIAL_GRID_API_BASE_URL) {
    return { ok: false, httpStatus: null, reason: 'invalid_base_url' };
  }

  try {
    const response = await axiosImpl.get(`${auth.apiBaseUrl}${path}`, {
      auth: { username: auth.username, password: auth.password },
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const httpStatus = response && response.status ? response.status : null;
    if (httpStatus === 200) {
      return { ok: true, httpStatus, reason: 'ok' };
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return { ok: false, httpStatus, reason: 'unauthorized' };
    }
    return { ok: false, httpStatus, reason: 'unexpected_status' };
  } catch (_err) {
    return { ok: false, httpStatus: null, reason: 'unreachable' };
  }
}

/**
 * Safe connectivity check. Never includes secrets or response bodies.
 * @param {{ axiosImpl?: typeof axios }} [options]
 */
async function checkGridConnectivity(options = {}) {
  return gridGetConfig(options);
}

/**
 * Runs the connectivity probe and caches booleans for GET /health.
 * @param {{ axiosImpl?: typeof axios }} [options]
 */
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

function resetGridConnectivityCache() {
  lastConnectivity = {
    checked: false,
    ok: false,
    httpStatus: null,
    reason: 'not_checked',
  };
}

module.exports = {
  PHASE0_ALLOWED_GET_PATHS,
  checkGridConnectivity,
  probeGridConnectivity,
  getGridHealthFlags,
  getLastGridConnectivity,
  resetGridConnectivityCache,
};
