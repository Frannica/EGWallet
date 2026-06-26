'use strict';

const { Pool } = require('pg');

function shouldUseSsl() {
  if (!process.env.DATABASE_URL) return false;
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return process.env.NODE_ENV === 'production';
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
});

module.exports = {
  pool,
};
