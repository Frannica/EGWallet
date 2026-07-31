'use strict';
const { Client } = require('pg');
(async () => {
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL : null);
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(
    `SELECT id::text AS id, email FROM users
      WHERE email LIKE '%@egwallet.e2e.test'
      ORDER BY created_at DESC LIMIT 3`
  );
  console.log(JSON.stringify({ ids: r.rows.map((x) => x.id), emails: r.rows.map((x) => x.email) }));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
