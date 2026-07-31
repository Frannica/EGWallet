'use strict';
/**
 * Read-only Expo/EAS Android FCM credential presence check.
 * Prints booleans only — never secret values, private keys, or emails.
 *
 *   node backend/scripts/verifyExpoAndroidFcmReadOnly.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = '16aa669e-bf87-4a8b-b24b-6b1c79dcc0f7';
const ANDROID_PACKAGE = 'com.francisco1953.egwalletmobile';

function loadSession() {
  const p = path.join(os.homedir(), '.expo', 'state.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const token = j?.auth?.sessionSecret || j?.sessionSecret || null;
    if (token) return { token, stateFile: p.replace(os.homedir(), '~') };
  } catch (_) {}
  return null;
}

async function gql(session, query, variables) {
  const res = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'expo-session': session,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  const session = loadSession();
  if (!session) {
    console.log(JSON.stringify({ ok: false, error: 'NO_EXPO_SESSION', hint: 'Run eas login' }, null, 2));
    process.exit(2);
  }

  // Discover fields related to Android / FCM on App type
  const intro = await gql(session.token, `{
    __type(name: "App") {
      fields { name }
    }
  }`);
  const appFields = (intro.json?.data?.__type?.fields || []).map((f) => f.name);
  const interesting = appFields.filter((n) =>
    /android|fcm|push|credential|google/i.test(n)
  );

  // Try known modern query shapes in order
  const attempts = [
    {
      name: 'AndroidAppCredentials.byAppId',
      query: `query($appId: String!) {
        androidAppCredentials {
          byAppId(appId: $appId) {
            id
            applicationIdentifier
            googleServiceAccountKeyForFcmV1 { id projectIdentifier clientEmail }
          }
        }
      }`,
      variables: { appId: APP_ID },
      extract: (d) => d?.androidAppCredentials?.byAppId || [],
    },
    {
      name: 'app.byId.androidCredentials',
      query: `query($appId: String!) {
        app {
          byId(appId: $appId) {
            id
            slug
            androidCredentials {
              id
              applicationIdentifier
              googleServiceAccountKeyForFcmV1 { id projectIdentifier clientEmail }
            }
          }
        }
      }`,
      variables: { appId: APP_ID },
      extract: (d) => d?.app?.byId?.androidCredentials || [],
    },
    {
      name: 'app.byId.allAndroidCredentials',
      query: `query($appId: String!) {
        app {
          byId(appId: $appId) {
            id
            slug
            allAndroidAppCredentials: androidAppCredentials {
              id
              applicationIdentifier
              googleServiceAccountKeyForFcmV1 { id projectIdentifier clientEmail }
              androidFcm { id version }
            }
          }
        }
      }`,
      variables: { appId: APP_ID },
      extract: (d) => d?.app?.byId?.allAndroidAppCredentials || d?.app?.byId?.androidAppCredentials || [],
    },
  ];

  let used = null;
  let rows = [];
  let slug = null;
  const errors = [];

  for (const attempt of attempts) {
    const { status, json } = await gql(session.token, attempt.query, attempt.variables);
    if (json.errors?.length) {
      errors.push({ attempt: attempt.name, httpStatus: status, messages: json.errors.map((e) => e.message) });
      continue;
    }
    rows = attempt.extract(json.data) || [];
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
    slug = json?.data?.app?.byId?.slug || slug;
    used = attempt.name;
    break;
  }

  // Filter to this package when identifiers present
  const filtered = rows.filter((r) =>
    !r.applicationIdentifier || r.applicationIdentifier === ANDROID_PACKAGE
  );
  const details = filtered.map((c) => ({
    applicationIdentifier: c.applicationIdentifier || null,
    credentialRecordPresent: !!c.id,
    fcmV1Configured: !!(c.googleServiceAccountKeyForFcmV1 && c.googleServiceAccountKeyForFcmV1.id),
    fcmV1ProjectIdPresent: !!(c.googleServiceAccountKeyForFcmV1 && c.googleServiceAccountKeyForFcmV1.projectIdentifier),
    fcmV1ClientEmailPresent: !!(c.googleServiceAccountKeyForFcmV1 && c.googleServiceAccountKeyForFcmV1.clientEmail),
    legacyFcmConfigured: !!(c.androidFcm && c.androidFcm.id),
  }));

  const androidFcmReady = details.some((d) => d.fcmV1Configured || d.legacyFcmConfigured);
  const report = {
    ok: androidFcmReady,
    hasExpoSession: true,
    stateFile: session.stateFile,
    appSlug: slug || 'EGWalletSimple',
    androidPackage: ANDROID_PACKAGE,
    queryUsed: used,
    interestingAppFields: interesting,
    androidCredentialSets: details.length,
    androidFcmReady: used ? androidFcmReady : null,
    details,
    probeErrors: used ? undefined : errors,
    note: 'Booleans only — no private keys, service-account JSON, or emails printed.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(androidFcmReady ? 0 : 3);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
