'use strict';
/**
 * READ-ONLY: list recent users + funded wallet balances (production verification).
 *   railway run --service Postgres -- node backend/scripts/listFundedWalletsReadOnly.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL
      : null);
  if (!url) {
    console.error('DATABASE_PUBLIC_URL required');
    process.exit(2);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' ORDER BY ordinal_position`
  );
  console.log('USER_COLS', cols.rows.map((r) => r.column_name).join(','));

  const u = await client.query(
    `SELECT id, email, region, created_at
       FROM users ORDER BY created_at DESC LIMIT 20`
  );
  console.log('RECENT_USERS', JSON.stringify(u.rows, null, 2));

  const b = await client.query(
    `SELECT wb.wallet_id, w.user_id, u.email, wb.currency, wb.amount,
            COALESCE(wh.amount, 0) AS hold_amount
       FROM wallet_balances wb
       JOIN wallets w ON w.id = wb.wallet_id
       JOIN users u ON u.id = w.user_id
       LEFT JOIN wallet_holds wh ON wh.wallet_id = wb.wallet_id AND wh.currency = wb.currency
      WHERE wb.amount > 0 OR COALESCE(wh.amount, 0) > 0
      ORDER BY wb.amount DESC
      LIMIT 40`
  );
  console.log('FUNDED', JSON.stringify(b.rows, null, 2));
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
