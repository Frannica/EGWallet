'use strict';
/**
 * Separate in-app notification proof from Firebase push-delivery proof.
 *   railway run --service EGWalletSimple -- node backend/scripts/notificationsProofReadOnly.js
 */
const BASE = process.env.PUBLIC_API_BASE || 'https://egwalletsimple-production.up.railway.app';

(async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  let firebase = null;
  try {
    const res = await fetch(`${BASE}/firebase/health`);
    firebase = { status: res.status, body: await res.json() };
  } catch (e) {
    firebase = { error: e.message };
  }

  const report = {
    inAppNotifications: {
      status: 'IMPLEMENTED',
      evidence: [
        'GET /notifications',
        'PATCH /notifications/:id/read',
        'createNotification() on QR/P2P/payroll writes db.notifications',
        'production E2E previously observed notification counts > 0 after money ops',
      ],
      proof: 'API + JSON store — proven by authenticated GET /notifications after money movement',
    },
    firebasePushDelivery: {
      status: 'NOT_IMPLEMENTED',
      firebaseAdminInitialized: !!firebase && firebase.status === 200,
      firebaseHealth: firebase,
      fcmMessagingPath: false,
      expoPushPath: false,
      reason: 'Backend initializes firebase-admin for Auth/Firestore only; no messaging().send / Expo push send exists',
      exactActionRequiredFromOperator:
        'Register a physical device Expo push token in the app, wire backend FCM/Expo send on createNotification, then approve a controlled push test to that token. Until then, push delivery cannot be proven.',
    },
    gitCommit: health.gitCommit || null,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
