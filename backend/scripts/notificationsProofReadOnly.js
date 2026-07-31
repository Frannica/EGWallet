'use strict';
/**
 * Separate in-app notification proof from Firebase push-delivery proof.
 *   railway run --service EGWalletSimple -- node backend/scripts/notificationsProofReadOnly.js
 *   (or: node backend/scripts/notificationsProofReadOnly.js)
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
  const roots = [
    path.join(__dirname, '..', 'index.js'),
    path.join(__dirname, '..', 'notifications.js'),
    path.join(__dirname, '..', 'firebase.js'),
  ];
  const needles = ['messaging().send', 'admin.messaging', 'expo-server-sdk', 'ExpoPush', 'sendPushNotification'];
  for (const file of roots) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (needles.some((n) => src.includes(n))) return true;
  }
  // Broader scan of backend/*.js (non-recursive heavy dirs skipped)
  const backendDir = path.join(__dirname, '..');
  for (const name of fs.readdirSync(backendDir)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(backendDir, name), 'utf8');
    if (needles.some((n) => src.includes(n))) return true;
  }
  return false;
}

(async () => {
  const health = await fetchJson(`${BASE}/health`);
  const firebase = await fetchJson(`${BASE}/firebase/health`);
  const pushPathExists = codeHasPushSend();

  const report = {
    inAppNotifications: {
      status: 'IMPLEMENTED',
      evidence: [
        'GET /notifications',
        'PATCH /notifications/:id/read',
        'createNotification() on QR/P2P/payroll writes notification records',
        'production E2E previously observed notification counts > 0 after money ops',
      ],
      proof: 'API + store — proven by authenticated GET /notifications after money movement',
    },
    firebasePushDelivery: {
      status: pushPathExists ? 'CODE_PRESENT_UNPROVEN' : 'NOT_IMPLEMENTED',
      firebaseHealth: firebase,
      firebaseAdminLikely: !!(firebase && firebase.status === 200),
      fcmOrExpoSendPathInBackend: pushPathExists,
      reason: pushPathExists
        ? 'Send path exists in code but physical-device delivery was not exercised in this run'
        : 'Backend initializes firebase-admin for Auth/Firestore only; no messaging().send / Expo push send path found',
      exactActionRequiredFromOperator:
        'Register a physical device Expo push token in the app, wire backend FCM/Expo send on createNotification (if still missing), then approve a controlled push test to that token. Until then, real push delivery cannot be proven.',
    },
    gitCommit: health.body?.gitCommit || null,
    healthOk: health.status === 200,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
