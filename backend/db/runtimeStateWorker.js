'use strict';

const { Client } = require('pg');

function shouldUseSsl() {
  if (!process.env.DATABASE_URL) return false;
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return process.env.NODE_ENV === 'production';
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS runtime_db_state (
      id INT PRIMARY KEY CHECK (id = 1),
      version BIGINT NOT NULL DEFAULT 0,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function writeResult(result) {
  process.stdout.write(JSON.stringify(result));
}

async function run() {
  const command = process.argv[2];
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  await ensureTable(client);

  if (command === 'get') {
    const row = await client.query('SELECT version, data FROM runtime_db_state WHERE id = 1');
    if (row.rowCount === 0) {
      writeResult({ ok: true, missing: true });
    } else {
      writeResult({
        ok: true,
        missing: false,
        version: Number(row.rows[0].version || 0),
        db: row.rows[0].data,
      });
    }
    await client.end();
    return;
  }

  if (command === 'status') {
    const row = await client.query('SELECT 1 FROM runtime_db_state WHERE id = 1');
    writeResult({ ok: true, connected: true, initialized: row.rowCount > 0 });
    await client.end();
    return;
  }

  if (command === 'set') {
    const payloadRaw = await readStdin();
    const payload = payloadRaw ? JSON.parse(payloadRaw) : {};
    const db = payload.db || {};
    const skipVersionCheck = !!payload.skipVersionCheck;

    await client.query('BEGIN');
    try {
      const existing = await client.query(
        'SELECT version FROM runtime_db_state WHERE id = 1 FOR UPDATE'
      );
      const currentVersion = existing.rowCount > 0 ? Number(existing.rows[0].version || 0) : 0;
      const expectedVersion = Number(db._dbVersion || 0);

      if (!skipVersionCheck && existing.rowCount > 0 && currentVersion !== expectedVersion) {
        throw new Error(`DB_VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
      }

      const nextVersion = expectedVersion + 1;
      const dbToSave = { ...db, _dbVersion: nextVersion };

      if (existing.rowCount === 0) {
        await client.query(
          'INSERT INTO runtime_db_state (id, version, data, updated_at) VALUES (1, $1, $2::jsonb, NOW())',
          [nextVersion, JSON.stringify(dbToSave)]
        );
      } else {
        await client.query(
          'UPDATE runtime_db_state SET version = $1, data = $2::jsonb, updated_at = NOW() WHERE id = 1',
          [nextVersion, JSON.stringify(dbToSave)]
        );
      }

      await client.query('COMMIT');
      writeResult({ ok: true, db: dbToSave, version: nextVersion });
    } catch (error) {
      await client.query('ROLLBACK');
      writeResult({ ok: false, error: error.message });
      process.exitCode = 1;
    } finally {
      await client.end();
    }
    return;
  }

  writeResult({ ok: false, error: `Unknown command: ${command}` });
  await client.end();
  process.exitCode = 1;
}

run().catch((error) => {
  writeResult({ ok: false, error: error.message });
  process.exitCode = 1;
});
