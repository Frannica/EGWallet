'use strict';
/**
 * Add Firebase to GCP project (if needed), ensure Android app exists,
 * download google-services.json. Never prints secrets/keys/emails.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE = 'com.francisco1953.egwalletmobile';
const OUT_ROOT = path.join(ROOT, 'google-services.json');
const OUT_ANDROID = path.join(ROOT, 'android', 'app', 'google-services.json');

function loadSa() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'service-account-key.json'), 'utf8'));
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const data = `${header}.${claim}`;
  const s = crypto.createSign('RSA-SHA256');
  s.update(data);
  s.end();
  const jwt = `${data}.${b64url(s.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token_failed ' + res.status);
  return j.access_token;
}
async function api(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 180) }; }
  return { status: res.status, json };
}
async function waitOp(token, opName, tries = 30) {
  if (!opName) return;
  for (let i = 0; i < tries; i++) {
    const r = await api('GET', `https://firebase.googleapis.com/v1beta1/${opName}`, token);
    if (r.json.done) {
      if (r.json.error) throw new Error('op_failed: ' + (r.json.error.message || 'unknown'));
      return r.json.response || r.json;
    }
    await new Promise((x) => setTimeout(x, 2000));
  }
  throw new Error('op_timeout');
}
function decodeConfig(configJson) {
  if (configJson.configFileContents) {
    return JSON.parse(Buffer.from(configJson.configFileContents, 'base64').toString('utf8'));
  }
  if (configJson.project_info || configJson.client) return configJson;
  throw new Error('unexpected_config_shape');
}

(async () => {
  const sa = loadSa();
  const projectId = sa.project_id;
  const token = await getToken(sa);
  const steps = [];

  // 1) Try list — if 404 not a Firebase project, addFirebase
  let listed = await api('GET', `https://firebase.googleapis.com/v1beta1/projects/${projectId}/androidApps`, token);
  steps.push({ step: 'list', status: listed.status, msg: listed.json?.error?.message || null });

  if (listed.status === 404 || /not found/i.test(listed.json?.error?.message || '')) {
    const add = await api('POST', `https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`, token, {});
    steps.push({ step: 'addFirebase', status: add.status, msg: add.json?.error?.message || null, op: !!add.json?.name });
    if (add.status === 200 || add.status === 201 || add.json?.name) {
      if (add.json?.name) await waitOp(token, add.json.name);
    } else if (add.status !== 409 && !/already/i.test(add.json?.error?.message || '')) {
      console.log(JSON.stringify({ ok: false, error: 'addFirebase_failed', steps }, null, 2));
      process.exit(2);
    }
    listed = await api('GET', `https://firebase.googleapis.com/v1beta1/projects/${projectId}/androidApps`, token);
    steps.push({ step: 'list_after_add', status: listed.status, msg: listed.json?.error?.message || null });
  }

  if (listed.status !== 200) {
    console.log(JSON.stringify({ ok: false, error: 'list_failed', steps }, null, 2));
    process.exit(3);
  }

  let apps = listed.json.apps || [];
  let app = apps.find((a) => a.packageName === PACKAGE);

  if (!app) {
    const created = await api(
      'POST',
      `https://firebase.googleapis.com/v1beta1/projects/${projectId}/androidApps`,
      token,
      { packageName: PACKAGE, displayName: 'EGWallet' }
    );
    steps.push({
      step: 'createAndroidApp',
      status: created.status,
      msg: created.json?.error?.message || null,
      op: !!created.json?.name,
    });
    if (created.json?.name) {
      const resp = await waitOp(token, created.json.name);
      // response may include the app
      app = resp;
    } else if (created.status === 200 || created.status === 201) {
      app = created.json;
    } else {
      console.log(JSON.stringify({ ok: false, error: 'create_android_failed', steps }, null, 2));
      process.exit(4);
    }
    listed = await api('GET', `https://firebase.googleapis.com/v1beta1/projects/${projectId}/androidApps`, token);
    apps = listed.json.apps || [];
    app = apps.find((a) => a.packageName === PACKAGE) || app;
  }

  if (!app || !app.name) {
    // app.name required for config; refetch
    listed = await api('GET', `https://firebase.googleapis.com/v1beta1/projects/${projectId}/androidApps`, token);
    app = (listed.json.apps || []).find((a) => a.packageName === PACKAGE);
  }
  if (!app || !app.name) {
    console.log(JSON.stringify({ ok: false, error: 'android_app_missing_after_create', steps, appCount: (listed.json.apps || []).length }, null, 2));
    process.exit(5);
  }

  const cfg = await api('GET', `https://firebase.googleapis.com/v1beta1/${app.name}/config`, token);
  steps.push({ step: 'config', status: cfg.status, msg: cfg.json?.error?.message || null });
  if (cfg.status !== 200) {
    console.log(JSON.stringify({ ok: false, error: 'config_failed', steps }, null, 2));
    process.exit(6);
  }

  const gs = decodeConfig(cfg.json);
  fs.writeFileSync(OUT_ROOT, JSON.stringify(gs, null, 2) + '\n', 'utf8');
  if (fs.existsSync(path.join(ROOT, 'android', 'app'))) {
    fs.writeFileSync(OUT_ANDROID, JSON.stringify(gs, null, 2) + '\n', 'utf8');
  }
  const packages = (gs.client || []).map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
  console.log(JSON.stringify({
    ok: true,
    wroteRoot: fs.existsSync(OUT_ROOT),
    wroteAndroid: fs.existsSync(OUT_ANDROID),
    clientCount: (gs.client || []).length,
    packages,
    matchesPackage: packages.includes(PACKAGE),
    steps: steps.map((s) => ({ step: s.step, status: s.status, ok: !s.msg || /already/i.test(s.msg || '') })),
  }, null, 2));
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 220) }));
  process.exit(1);
});
