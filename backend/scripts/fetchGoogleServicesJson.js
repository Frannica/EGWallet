'use strict';
/**
 * Fetch google-services.json for the Android app via Firebase Management API.
 * Writes the file only — never prints private keys, emails, or API keys.
 *
 * Sources (first match):
 *   1) GOOGLE_SERVICE_ACCOUNT env (JSON string)
 *   2) ./service-account-key.json (repo root)
 *
 * Usage:
 *   node backend/scripts/fetchGoogleServicesJson.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE = 'com.francisco1953.egwalletmobile';
const OUT_ROOT = path.join(ROOT, 'google-services.json');
const OUT_ANDROID = path.join(ROOT, 'android', 'app', 'google-services.json');

function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  }
  const p = path.join(ROOT, 'service-account-key.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('No GOOGLE_SERVICE_ACCOUNT env or service-account-key.json');
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const data = `${header}.${claim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  sign.end();
  const sig = b64url(sign.sign(sa.private_key));
  const jwt = `${data}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`token_exchange_failed status=${res.status}`);
  }
  return json.access_token;
}

async function apiGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

function decodeConfig(configJson) {
  // Firebase returns { configFileContents: base64 } or raw JSON
  if (configJson.configFileContents) {
    const decoded = Buffer.from(configJson.configFileContents, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
  if (configJson.project_info || configJson.client) return configJson;
  throw new Error('unexpected_config_shape');
}

function safeSummary(gs) {
  const clients = Array.isArray(gs.client) ? gs.client : [];
  const packages = clients
    .map((c) => c?.client_info?.android_client_info?.package_name)
    .filter(Boolean);
  return {
    hasProjectInfo: !!gs.project_info,
    projectNumberPresent: !!(gs.project_info && gs.project_info.project_number),
    projectIdPresent: !!(gs.project_info && gs.project_info.project_id),
    clientCount: clients.length,
    packageNames: packages,
    matchesTargetPackage: packages.includes(PACKAGE),
  };
}

async function main() {
  const sa = loadServiceAccount();
  if (!sa.project_id || !sa.private_key || !sa.client_email) {
    throw new Error('service_account_incomplete');
  }
  const projectId = sa.project_id;
  const token = await getAccessToken(sa);

  const listUrl = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/androidApps`;
  const listed = await apiGet(listUrl, token);
  if (listed.status !== 200) {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'list_android_apps_failed',
        httpStatus: listed.status,
        apiMessage: listed.json?.error?.message || null,
        hint: 'Service account may lack Firebase Admin / Viewer on this project, or project is not a Firebase project.',
      })
    );
    process.exit(2);
  }

  const apps = listed.json.apps || [];
  const app =
    apps.find((a) => a.packageName === PACKAGE) ||
    apps[0] ||
    null;
  if (!app) {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'no_android_apps',
        projectIdPresent: true,
        packageWanted: PACKAGE,
        appCount: 0,
        hint: 'Add an Android app with this package in Firebase Console, then download google-services.json.',
      })
    );
    process.exit(3);
  }

  const appName = app.name; // projects/.../androidApps/...
  const cfg = await apiGet(
    `https://firebase.googleapis.com/v1beta1/${appName}/config`,
    token
  );
  if (cfg.status !== 200) {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'config_download_failed',
        httpStatus: cfg.status,
        apiMessage: cfg.json?.error?.message || null,
        packageName: app.packageName || null,
      })
    );
    process.exit(4);
  }

  const gs = decodeConfig(cfg.json);
  const summary = safeSummary(gs);
  fs.writeFileSync(OUT_ROOT, `${JSON.stringify(gs, null, 2)}\n`, 'utf8');
  const androidDir = path.dirname(OUT_ANDROID);
  if (fs.existsSync(path.join(ROOT, 'android', 'app'))) {
    fs.mkdirSync(androidDir, { recursive: true });
    fs.writeFileSync(OUT_ANDROID, `${JSON.stringify(gs, null, 2)}\n`, 'utf8');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        wroteRoot: fs.existsSync(OUT_ROOT),
        wroteAndroidApp: fs.existsSync(OUT_ANDROID),
        packageName: app.packageName || null,
        matchedWantedPackage: app.packageName === PACKAGE,
        ...summary,
      },
      null,
      2
    )
  );
  if (!summary.matchesTargetPackage && apps.length) {
    console.log(
      JSON.stringify({
        warning: 'package_mismatch',
        wanted: PACKAGE,
        got: app.packageName || null,
        available: apps.map((a) => a.packageName).filter(Boolean),
      })
    );
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
  process.exit(1);
});
