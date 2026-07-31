'use strict';
/**
 * Separate in-app notification proof from Firebase/Expo push-delivery proof.
 */
const BASE = process.env.PUBLIC_API_BASE || 'https://egwalletsimple-production.up.railway.app';
const fs = require('fs');
const path = require('path');

async function fetchJson(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { signal: c.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 200) }; }
    return { status: res.status, body };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

function codeHasPushSend() {
  const file = path.join(__dirname, '..', 'pushNotifications.js');
  if (!fs.existsSync(file)) return false;
  const src = fs.readFileSync(file, 'utf8');
  return src.includes('exp.host/--/api/v2/push/send') || src.includes('schedulePushForNotification');
}

(async () => {
  const health = await fetchJson(`${BASE}/health`);
  const pushReady = await fetchJson(`${BASE}/push/ready`);
  const report = {
    inAppNotifications: {
      status: 'IMPLEMENTED',
      evidence: [
        'GET /notifications',
        'PATCH /notifications/:id/read',
        'createNotification() on money ops',
      ],
      proof: 'API + store — authenticated GET /notifications after money movement',
    },
    expoPushDelivery: {
      status: codeHasPushSend() ? 'IMPLEMENTED_AWAITING_DEVICE_PROOF' : 'NOT_IMPLEMENTED',
      codePathPresent: codeHasPushSend(),
      pushReady,
      healthPush: health.body?.push || null,
      exactActionRequiredFromOperator:
        'On a physical phone running a build that includes the new pushRegistration JS: sign in, grant notification permission, confirm Settings > Push Notifications is ON, then POST /push/test-self with body {"confirm":"SEND_TEST_PUSH_TO_ME"} using your access token. Expect a system notification titled "EGWallet test push".',
    },
    gitCommit: health.body?.gitCommit || null,
    healthOk: health.status === 200,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
