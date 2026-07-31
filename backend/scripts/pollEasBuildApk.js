'use strict';
/**
 * Poll one EAS build until finished and print APK URL (no secrets).
 *   node backend/scripts/pollEasBuildApk.js <buildId>
 */
const { spawnSync } = require('child_process');
const buildId = process.argv[2];
if (!buildId) {
  console.error('usage: node backend/scripts/pollEasBuildApk.js <buildId>');
  process.exit(2);
}

function viewBuild() {
  const r = spawnSync('eas', ['build:view', buildId, '--json'], {
    encoding: 'utf8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const text = (r.stdout || '').trim();
  // eas may print warnings before JSON
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

(async () => {
  for (let i = 1; i <= 90; i++) {
    const obj = viewBuild();
    if (!obj) {
      console.error(`[${i}] no_json`);
      await new Promise((r) => setTimeout(r, 20000));
      continue;
    }
    const apk = obj.artifacts?.buildUrl || obj.artifacts?.applicationArchiveUrl || null;
    const status = String(obj.status || '').toLowerCase();
    console.error(`[${i}] status=${obj.status} apkPresent=${!!apk}`);
    if (['finished', 'errored', 'canceled', 'cancelled'].includes(status)) {
      const report = {
        id: obj.id,
        status: obj.status,
        platform: obj.platform,
        profile: obj.buildProfile,
        gitCommit: obj.gitCommitHash || null,
        appVersion: obj.appVersion || null,
        appBuildVersion: obj.appBuildVersion || null,
        isApk: !!(apk && /\.apk(\?|$)/i.test(apk)),
        apkUrl: apk,
        buildPage: `https://expo.dev/accounts/francisco1953/projects/EGWalletSimple/builds/${buildId}`,
      };
      console.log(JSON.stringify(report, null, 2));
      process.exit(status === 'finished' && apk ? 0 : 3);
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.error('TIMEOUT');
  process.exit(1);
})();
