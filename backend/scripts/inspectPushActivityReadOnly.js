'use strict';
/**
 * Read-only push activity inspection (no full tokens, no secrets).
 *   railway run --service EGWalletSimple -- node backend/scripts/inspectPushActivityReadOnly.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL : null);
  if (!url) {
    console.error('DATABASE_PUBLIC_URL required');
    process.exit(2);
  }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const counts = await c.query(`
    SELECT
      (SELECT COUNT(*)::int FROM push_tokens) AS tokens,
      (SELECT COUNT(*)::int FROM push_tokens WHERE enabled) AS enabled_tokens,
      (SELECT COUNT(*)::int FROM push_delivery_attempts) AS attempts
  `);
  const recentTokens = await c.query(`
    SELECT platform, enabled, app_version,
           CASE WHEN last_error IS NULL THEN NULL ELSE left(last_error, 80) END AS last_error,
           created_at AT TIME ZONE 'UTC' AS created_utc,
           updated_at AT TIME ZONE 'UTC' AS updated_utc,
           last_sent_at AT TIME ZONE 'UTC' AS last_sent_utc
      FROM push_tokens
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 20
  `);
  const recentAttempts = await c.query(`
    SELECT status,
           CASE WHEN error IS NULL THEN NULL ELSE left(error, 100) END AS error,
           provider_ticket IS NOT NULL AS has_ticket,
           created_at AT TIME ZONE 'UTC' AS created_utc
      FROM push_delivery_attempts
     ORDER BY created_at DESC
     LIMIT 30
  `);
  console.log(JSON.stringify({
    counts: counts.rows[0],
    recentTokens: recentTokens.rows,
    recentAttempts: recentAttempts.rows,
  }, null, 2));
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
