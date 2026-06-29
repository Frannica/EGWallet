'use strict';

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');

let schemaReady = false;

async function ensureAdminPlatformTables() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'read_only',
      status TEXT NOT NULL DEFAULT 'active',
      failed_login_attempts INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      token_version INT NOT NULL DEFAULT 0,
      totp_secret TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_idx ON admin_users (LOWER(email))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_user_notes (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      admin_id UUID NOT NULL REFERENCES admin_users(id),
      admin_email TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_user_notes_user_id_idx ON admin_user_notes (user_id, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by UUID REFERENCES admin_users(id)
    )
  `);
  schemaReady = true;
}

function mapAdminRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    failedLoginAttempts: row.failed_login_attempts,
    lockedUntil: row.locked_until ? new Date(row.locked_until).getTime() : null,
    tokenVersion: row.token_version,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).getTime() : null,
  };
}

async function countAdminUsers() {
  await ensureAdminPlatformTables();
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  return result.rows[0].count;
}

async function findAdminByEmail(email) {
  await ensureAdminPlatformTables();
  const result = await pool.query(
    'SELECT * FROM admin_users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email],
  );
  return mapAdminRow(result.rows[0]);
}

async function findAdminById(id) {
  await ensureAdminPlatformTables();
  const result = await pool.query('SELECT * FROM admin_users WHERE id = $1 LIMIT 1', [id]);
  return mapAdminRow(result.rows[0]);
}

async function findAdminWithPasswordByEmail(email) {
  await ensureAdminPlatformTables();
  const result = await pool.query(
    'SELECT * FROM admin_users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...mapAdminRow(row), passwordHash: row.password_hash };
}

async function createAdminUser({ email, password, role = 'read_only' }) {
  await ensureAdminPlatformTables();
  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 12);
  await pool.query(
    `INSERT INTO admin_users (id, email, password_hash, role, status, created_at)
     VALUES ($1, $2, $3, $4, 'active', NOW())`,
    [id, email.toLowerCase().trim(), passwordHash, role],
  );
  return findAdminById(id);
}

async function recordAdminLoginSuccess(adminId) {
  await pool.query(
    `UPDATE admin_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
    [adminId],
  );
}

async function recordAdminLoginFailure(adminId, attempts, lockedUntil) {
  await pool.query(
    `UPDATE admin_users SET failed_login_attempts = $2, locked_until = $3 WHERE id = $1`,
    [adminId, attempts, lockedUntil ? new Date(lockedUntil) : null],
  );
}

async function bumpAdminTokenVersion(adminId) {
  const result = await pool.query(
    `UPDATE admin_users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version`,
    [adminId],
  );
  return result.rows[0]?.token_version ?? 0;
}

async function listAdminUserNotes(userId, { limit = 50 } = {}) {
  await ensureAdminPlatformTables();
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const result = await pool.query(
    `SELECT id, user_id, admin_id, admin_email, note, created_at
     FROM admin_user_notes WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, safeLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    adminId: row.admin_id,
    adminEmail: row.admin_email,
    note: row.note,
    createdAt: new Date(row.created_at).getTime(),
  }));
}

async function insertAdminUserNote({ userId, adminId, adminEmail, note }) {
  await ensureAdminPlatformTables();
  const id = uuidv4();
  await pool.query(
    `INSERT INTO admin_user_notes (id, user_id, admin_id, admin_email, note, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [id, userId, adminId, adminEmail, note.trim()],
  );
  return {
    id,
    userId,
    adminId,
    adminEmail,
    note: note.trim(),
    createdAt: Date.now(),
  };
}

async function getAdminSetting(key) {
  await ensureAdminPlatformTables();
  const result = await pool.query('SELECT value FROM admin_settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? null;
}

async function getAllAdminSettings() {
  await ensureAdminPlatformTables();
  const result = await pool.query('SELECT key, value, updated_at FROM admin_settings ORDER BY key');
  const out = {};
  for (const row of result.rows) {
    out[row.key] = {
      value: row.value,
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }
  return out;
}

async function upsertAdminSetting(key, value, adminId) {
  await ensureAdminPlatformTables();
  await pool.query(
    `INSERT INTO admin_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2::jsonb, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), adminId],
  );
  return getAdminSetting(key);
}

module.exports = {
  ensureAdminPlatformTables,
  countAdminUsers,
  findAdminByEmail,
  findAdminById,
  findAdminWithPasswordByEmail,
  createAdminUser,
  recordAdminLoginSuccess,
  recordAdminLoginFailure,
  bumpAdminTokenVersion,
  listAdminUserNotes,
  insertAdminUserNote,
  getAdminSetting,
  getAllAdminSettings,
  upsertAdminSetting,
};
