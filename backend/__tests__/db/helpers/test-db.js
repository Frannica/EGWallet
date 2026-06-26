'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

const backendRoot = path.resolve(__dirname, '..', '..', '..');

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set to run db phase0 tests');
  }
  return process.env.DATABASE_URL;
}

function runNodeScript(relativeScript, args = [], extraEnv = {}) {
  const scriptPath = path.join(backendRoot, relativeScript);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: backendRoot,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  return result;
}

async function getCount(tableName) {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), ssl: false });
  try {
    const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${tableName}`);
    return Number(result.rows[0].count || 0);
  } finally {
    await pool.end();
  }
}

module.exports = {
  backendRoot,
  getCount,
  requireDatabaseUrl,
  runNodeScript,
};
