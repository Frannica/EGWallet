'use strict';

const { Client } = require('pg');

const FIXTURE_WITHDRAWAL_ID = '44444444-4444-4444-8444-444444444444';
const FIXTURE_USER_ID = '11111111-1111-4111-8111-111111111111';

async function count(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0].count || 0);
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const results = {};
    results.negative_balances = await count(
      client,
      'SELECT COUNT(*)::int AS count FROM wallet_balances WHERE amount < 0'
    );
    results.negative_holds = await count(
      client,
      'SELECT COUNT(*)::int AS count FROM wallet_holds WHERE amount < 0'
    );
    results.orphan_transactions = await count(
      client,
      `SELECT COUNT(*)::int AS count
       FROM transactions t
       LEFT JOIN wallets fw ON fw.id = t.from_wallet_id
       LEFT JOIN wallets tw ON tw.id = t.to_wallet_id
       WHERE (t.from_wallet_id IS NOT NULL AND fw.id IS NULL)
          OR (t.to_wallet_id IS NOT NULL AND tw.id IS NULL)`
    );
    results.orphan_ledger_rows = await count(
      client,
      `SELECT COUNT(*)::int AS count
       FROM ledger l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN wallets w ON w.id = l.wallet_id
       WHERE u.id IS NULL OR w.id IS NULL`
    );
    results.duplicate_idempotency_records = await count(
      client,
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT key, user_id, COUNT(*) c
         FROM idempotency_records
         GROUP BY key, user_id
         HAVING COUNT(*) > 1
       ) x`
    );
    // Exclude known Phase 0 fixture IDs from readiness checks.
    results.stuck_withdrawals_holds = await count(
      client,
      `SELECT COUNT(*)::int AS count
       FROM withdrawals wd
       JOIN wallet_holds h
         ON h.wallet_id = wd.wallet_id
        AND h.currency = wd.currency
       WHERE (
              (wd.status IN ('paid','failed','cancelled') AND h.amount > 0)
           OR (wd.status IN ('pending_review','approved','processing')
               AND wd.created_at < NOW() - INTERVAL '24 hours'
               AND h.amount > 0)
            )
         AND wd.id <> $1
         AND wd.user_id <> $2`,
      [FIXTURE_WITHDRAWAL_ID, FIXTURE_USER_ID]
    );

    const fixtureRecord = (
      await client.query(
        `SELECT wd.id, wd.user_id, u.email, wd.status, h.amount AS hold_amount
         FROM withdrawals wd
         JOIN users u ON u.id = wd.user_id
         JOIN wallet_holds h ON h.wallet_id = wd.wallet_id AND h.currency = wd.currency
         WHERE wd.id = $1`,
        [FIXTURE_WITHDRAWAL_ID]
      )
    ).rows[0] || null;

    console.log(JSON.stringify({ results, fixtureRecord }, null, 2));
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

