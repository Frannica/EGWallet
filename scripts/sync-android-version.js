#!/usr/bin/env node
/**
 * Single source of truth: app.json → android/app/build.gradle (+ app.config.js check).
 * EAS ignores app.json when android/ exists and reads build.gradle instead.
 * Run automatically via eas-build-post-install on every EAS Build.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJsonPath = path.join(root, 'app.json');
const buildGradlePath = path.join(root, 'android', 'app', 'build.gradle');
const appConfigPath = path.join(root, 'app.config.js');

function fail(msg) {
  console.error(`[sync-android-version] ERROR: ${msg}`);
  process.exit(1);
}

const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const version = appJson.expo?.version;
const versionCode = appJson.expo?.android?.versionCode;

if (!version || !versionCode) {
  fail('app.json must define expo.version and expo.android.versionCode');
}

if (!fs.existsSync(buildGradlePath)) {
  fail(`Missing ${buildGradlePath}`);
}

// Validate app.config.js matches (best-effort regex — catches stale config)
if (fs.existsSync(appConfigPath)) {
  const cfg = fs.readFileSync(appConfigPath, 'utf8');
  const cfgVersion = cfg.match(/version:\s*["']([^"']+)["']/);
  const cfgCode = cfg.match(/versionCode:\s*(\d+)/);
  if (cfgVersion && cfgVersion[1] !== version) {
    fail(`app.config.js version "${cfgVersion[1]}" != app.json "${version}"`);
  }
  if (cfgCode && Number(cfgCode[1]) !== versionCode) {
    fail(`app.config.js versionCode ${cfgCode[1]} != app.json ${versionCode}`);
  }
}

let gradle = fs.readFileSync(buildGradlePath, 'utf8');
const before = gradle;

gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);

if (gradle === before) {
  console.warn('[sync-android-version] build.gradle already up to date (no pattern matched?)');
}

fs.writeFileSync(buildGradlePath, gradle, 'utf8');
console.log(`[sync-android-version] OK → versionCode ${versionCode}, versionName "${version}"`);
