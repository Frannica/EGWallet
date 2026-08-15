'use strict';

/**
 * Apply ONLY 016_grid_incoming_credits.sql. Never prints credentials.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const VERSION = '016_grid_incoming_credits.sql';

function redact(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted]');
}

function connectionString() {
  const url = process.env.DATABASE_URL;
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (url && !/railway\.internal/i.test(url)) return url;
  if (pub) return pub;
  if (url) return url;
  throw new Error('DATABASE_URL is required');
}

async function main() {
  const pool = new Pool({
    connectionString: connectionString(),
    max: 2,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    const before = await client.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [VERSION]
    );
    if (before.rowCount > 0) {
      console.log('[016] skip apply — already in schema_migrations');
    } else {
      const sql = fs.readFileSync(
        path.join(__dirname, '..', 'db', 'migrations', VERSION),
        'utf8'
      );
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(version, applied_at) VALUES($1, NOW())',
        [VERSION]
      );
      await client.query('COMMIT');
      console.log(`[016] applied ${VERSION} in one transaction`);
    }

    const col = await client.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'transactions'
         AND column_name = 'grid_transaction_id'
    `);
    const idx = await client.query(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'transactions_grid_transaction_idx'
    `);
    if (!col.rowCount || !idx.rowCount) {
      throw new Error('verification failed: grid_transaction_id column or unique index missing');
    }
    console.log('[016] transactions.grid_transaction_id present (text, unique)');
    console.log('[016] schema_migrations contains 016_grid_incoming_credits.sql');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* ignore */ }
    console.error('[016] failed:', redact(err));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
