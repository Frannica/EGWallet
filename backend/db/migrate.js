'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

function getMigrationFiles() {
  const dir = path.join(__dirname, 'migrations');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      version: name,
      fullPath: path.join(dir, name),
    }));
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function hasMigration(version) {
  const result = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1 LIMIT 1',
    [version]
  );
  return result.rowCount > 0;
}

async function applyMigration(file) {
  const sql = fs.readFileSync(file.fullPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(version, applied_at) VALUES($1, NOW())',
      [file.version]
    );
    await client.query('COMMIT');
    console.log(`[db:migrate] applied ${file.version}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[db:migrate] failed ${file.version}:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  await ensureMigrationsTable();
  const files = getMigrationFiles();
  for (const file of files) {
    const exists = await hasMigration(file.version);
    if (exists) {
      console.log(`[db:migrate] skip ${file.version}`);
      continue;
    }
    await applyMigration(file);
  }
}

run()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error('[db:migrate] fatal:', error && error.stack ? error.stack : error);
    await pool.end();
    process.exit(1);
  });
