'use strict';
/**
 * Upload GOOGLE_SERVICE_ACCOUNT JSON to Expo as Android FCM V1 credentials.
 * Never prints the service-account JSON, private keys, or emails.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/configureExpoAndroidFcmV1FromEnv.js
 *   CONFIRM_EXPO_FCM_UPLOAD=YES required.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = '16aa669e-bf87-4a8b-b24b-6b1c79dcc0f7';
const ANDROID_PACKAGE = 'com.francisco1953.egwalletmobile';

function loadSession() {
  const p = path.join(os.homedir(), '.expo', 'state.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const token = j?.auth?.sessionSecret;
  if (!token) throw new Error('NO_EXPO_SESSION');
  return token;
}

async function gql(session, query, variables) {
  const res = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'expo-session': session },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    const err = new Error(json.errors.map((e) => e.message).join('; '));
    err.graphql = json.errors;
    throw err;
  }
  return json.data;
}

async function main() {
  if (process.env.CONFIRM_EXPO_FCM_UPLOAD !== 'YES') {
    console.error(JSON.stringify({ ok: false, error: 'Set CONFIRM_EXPO_FCM_UPLOAD=YES' }));
    process.exit(2);
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error(JSON.stringify({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT missing' }));
    process.exit(2);
  }
  let sa;
  try { sa = JSON.parse(raw); } catch {
    console.error(JSON.stringify({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT not valid JSON' }));
    process.exit(2);
  }
  if (!sa.private_key || !sa.client_email || !sa.project_id) {
    console.error(JSON.stringify({ ok: false, error: 'service account missing required fields' }));
    process.exit(2);
  }

  const session = loadSession();

  const appData = await gql(session, `query($appId: String!) {
    app {
      byId(appId: $appId) {
        id
        slug
        ownerAccount { id name }
        androidAppCredentials {
          id
          applicationIdentifier
          googleServiceAccountKeyForFcmV1 { id }
          androidFcm { id version }
        }
      }
    }
  }`, { appId: APP_ID });

  const app = appData.app.byId;
  const accountId = app.ownerAccount.id;
  let creds = (app.androidAppCredentials || []).find((c) => c.applicationIdentifier === ANDROID_PACKAGE);
  if (!creds) {
    // create android app credentials for package
    const created = await gql(session, `mutation($appId: ID!, $applicationIdentifier: String!) {
      androidAppCredentials {
        createAndroidAppCredentials(
          androidAppCredentialsInput: {}
          appId: $appId
          applicationIdentifier: $applicationIdentifier
        ) { id applicationIdentifier }
      }
    }`, { appId: app.id, applicationIdentifier: ANDROID_PACKAGE });
    creds = created.androidAppCredentials.createAndroidAppCredentials;
  }

  if (creds.googleServiceAccountKeyForFcmV1?.id) {
    console.log(JSON.stringify({
      ok: true,
      alreadyConfigured: true,
      androidFcmReady: true,
      androidPackage: ANDROID_PACKAGE,
      appSlug: app.slug,
    }, null, 2));
    return;
  }

  // Preferred: createFcmV1Credential (stores + links in one step)
  try {
    const linked = await gql(session, `mutation($accountId: ID!, $androidAppCredentialsId: String!, $credential: String!) {
      androidAppCredentials {
        createFcmV1Credential(
          accountId: $accountId
          androidAppCredentialsId: $androidAppCredentialsId
          credential: $credential
        ) {
          id
          applicationIdentifier
          googleServiceAccountKeyForFcmV1 { id }
        }
      }
    }`, {
      accountId,
      androidAppCredentialsId: creds.id,
      credential: JSON.stringify(sa),
    });
    const row = linked.androidAppCredentials.createFcmV1Credential;
    console.log(JSON.stringify({
      ok: true,
      configured: true,
      method: 'createFcmV1Credential',
      androidFcmReady: !!(row.googleServiceAccountKeyForFcmV1 && row.googleServiceAccountKeyForFcmV1.id),
      androidPackage: ANDROID_PACKAGE,
      appSlug: app.slug,
    }, null, 2));
    return;
  } catch (e1) {
    // Fallback: createGoogleServiceAccountKey then setGoogleServiceAccountKeyForFcmV1
    try {
      const createdKey = await gql(session, `mutation($accountId: ID!, $jsonKey: JSONObject!) {
        googleServiceAccountKey {
          createGoogleServiceAccountKey(accountId: $accountId, jsonKey: $jsonKey) {
            id
          }
        }
      }`, { accountId, jsonKey: sa });
      const keyId = createdKey.googleServiceAccountKey.createGoogleServiceAccountKey.id;
      const set = await gql(session, `mutation($id: ID!, $googleServiceAccountKeyId: ID!) {
        androidAppCredentials {
          setGoogleServiceAccountKeyForFcmV1(id: $id, googleServiceAccountKeyId: $googleServiceAccountKeyId) {
            id
            googleServiceAccountKeyForFcmV1 { id }
          }
        }
      }`, { id: creds.id, googleServiceAccountKeyId: keyId });
      const row = set.androidAppCredentials.setGoogleServiceAccountKeyForFcmV1;
      console.log(JSON.stringify({
        ok: true,
        configured: true,
        method: 'createGoogleServiceAccountKey+set',
        androidFcmReady: !!(row.googleServiceAccountKeyForFcmV1 && row.googleServiceAccountKeyForFcmV1.id),
        androidPackage: ANDROID_PACKAGE,
        appSlug: app.slug,
        firstAttemptError: e1.message,
      }, null, 2));
      return;
    } catch (e2) {
      console.error(JSON.stringify({
        ok: false,
        error: 'FCM_UPLOAD_FAILED',
        firstAttemptError: e1.message,
        secondAttemptError: e2.message,
      }));
      process.exit(3);
    }
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
