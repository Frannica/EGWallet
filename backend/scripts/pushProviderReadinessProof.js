'use strict';
/**
 * Prove Expo push provider readiness on production (no money movement).
 *   railway run --service EGWalletSimple -- node backend/scripts/pushProviderReadinessProof.js
 *   OR: node backend/scripts/pushProviderReadinessProof.js
 */
const BASE = process.env.PUBLIC_API_BASE || 'https://egwalletsimple-production.up.railway.app';

async function fetchJson(url, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { signal: c.signal });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const health = await fetchJson(`${BASE}/health`);
  const ready = await fetchJson(`${BASE}/push/ready`);
  const report = {
    gitCommit: health.body?.gitCommit || null,
    healthOk: health.status === 200,
    pushFromHealth: health.body?.push || null,
    pushReady: ready,
    providerReady:
      ready.status === 200
      && ready.body?.provider === 'expo'
      && ready.body?.disabled !== true
      && !!ready.body?.pushApi,
    secretsLeaked: JSON.stringify({ health: health.body, ready: ready.body }).includes('Bearer ')
      || JSON.stringify(ready.body || {}).includes('secret'),
    next: 'Physical phone: open production app build with expo-notifications, sign in, grant notification permission, confirm Settings > Push Notifications ON, then call POST /push/test-self with confirm=SEND_TEST_PUSH_TO_ME using your access token.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.providerReady && !report.secretsLeaked ? 0 : 3);
})().catch((e) => { console.error(e); process.exit(1); });
