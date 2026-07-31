'use strict';

const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');

const EXPO_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

function normalizePlatform(raw) {
  const p = String(raw || '').toLowerCase();
  if (p === 'ios' || p === 'android' || p === 'web') return p;
  return 'unknown';
}

function isValidExpoPushToken(token) {
  return typeof token === 'string' && EXPO_TOKEN_RE.test(token.trim());
}

/**
 * Auth users often exist in JSON app_state before their first Postgres money touch.
 * push_tokens.user_id FK requires a users row — create a placeholder if missing.
 */
async function ensureUserRowForPush(client, userId, email) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, push_enabled, created_at)
     VALUES ($1, $2, 'push-placeholder', 'US', 'individual', TRUE, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId, email || `push-user-${userId}@egwallet.internal`]
  );
}

/**
 * Upsert a push token for the authenticated user only.
 * If the same token was previously owned by another user, steal it
 * (device changed accounts) so the previous user stops receiving pushes.
 */
async function registerPushToken({ userId, deviceId, token, platform, appVersion, email }) {
  if (!userId) throw Object.assign(new Error('userId required'), { code: 'USER_REQUIRED' });
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 128) {
    throw Object.assign(new Error('deviceId invalid'), { code: 'DEVICE_ID_INVALID' });
  }
  const cleanToken = String(token || '').trim();
  if (!isValidExpoPushToken(cleanToken)) {
    throw Object.assign(new Error('token invalid'), { code: 'TOKEN_INVALID' });
  }
  const plat = normalizePlatform(platform);
  const id = uuidv4();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureUserRowForPush(client, userId, email);
    // Free UNIQUE(token): remove other owners / other device rows for this token.
    await client.query(
      `DELETE FROM push_tokens WHERE token = $1 AND (user_id <> $2 OR device_id <> $3)`,
      [cleanToken, userId, deviceId]
    );
    const upsert = await client.query(
      `INSERT INTO push_tokens (id, user_id, device_id, token, platform, enabled, app_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,NOW(),NOW())
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         token = EXCLUDED.token,
         platform = EXCLUDED.platform,
         enabled = TRUE,
         app_version = EXCLUDED.app_version,
         updated_at = NOW(),
         last_error = NULL
       RETURNING id, user_id, device_id, platform, enabled, updated_at`,
      [id, userId, deviceId, cleanToken, plat, appVersion || null]
    );
    await client.query('COMMIT');
    return upsert.rows[0];
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (e.code === '23505') {
      // Race on token unique — take ownership of the existing token row
      const row = await pool.query(
        `UPDATE push_tokens
            SET user_id = $1, device_id = $2, platform = $3, enabled = TRUE,
                app_version = $4, updated_at = NOW(), last_error = NULL
          WHERE token = $5
          RETURNING id, user_id, device_id, platform, enabled, updated_at`,
        [userId, deviceId, plat, appVersion || null, cleanToken]
      );
      if (row.rowCount) return row.rows[0];
    }
    throw e;
  } finally {
    client.release();
  }
}

async function unregisterPushToken({ userId, deviceId, token }) {
  if (!userId) throw Object.assign(new Error('userId required'), { code: 'USER_REQUIRED' });
  if (token) {
    const r = await pool.query(
      `UPDATE push_tokens SET enabled = FALSE, updated_at = NOW(), last_error = 'unregistered'
        WHERE user_id = $1 AND token = $2
        RETURNING id`,
      [userId, String(token).trim()]
    );
    return { disabled: r.rowCount };
  }
  if (deviceId) {
    const r = await pool.query(
      `UPDATE push_tokens SET enabled = FALSE, updated_at = NOW(), last_error = 'unregistered'
        WHERE user_id = $1 AND device_id = $2
        RETURNING id`,
      [userId, deviceId]
    );
    return { disabled: r.rowCount };
  }
  const r = await pool.query(
    `UPDATE push_tokens SET enabled = FALSE, updated_at = NOW(), last_error = 'unregistered_all'
      WHERE user_id = $1 AND enabled = TRUE
      RETURNING id`,
    [userId]
  );
  return { disabled: r.rowCount };
}

async function setUserPushEnabled(userId, enabled, email) {
  const client = await pool.connect();
  try {
    await ensureUserRowForPush(client, userId, email);
  } finally {
    client.release();
  }
  await pool.query(
    `UPDATE users SET push_enabled = $2 WHERE id = $1`,
    [userId, !!enabled]
  );
  if (!enabled) {
    await pool.query(
      `UPDATE push_tokens SET enabled = FALSE, updated_at = NOW(), last_error = 'opt_out'
        WHERE user_id = $1 AND enabled = TRUE`,
      [userId]
    );
  }
  return { pushEnabled: !!enabled };
}

async function isUserPushEnabled(userId) {
  const r = await pool.query(
    `SELECT COALESCE(push_enabled, TRUE) AS push_enabled FROM users WHERE id = $1`,
    [userId]
  );
  if (r.rowCount === 0) return true;
  return r.rows[0].push_enabled !== false;
}

async function listEnabledTokensForUser(userId) {
  const r = await pool.query(
    `SELECT id, token, platform, device_id
       FROM push_tokens
      WHERE user_id = $1 AND enabled = TRUE`,
    [userId]
  );
  return r.rows;
}

async function disableToken(token, reason) {
  await pool.query(
    `UPDATE push_tokens
        SET enabled = FALSE, updated_at = NOW(), last_error = $2
      WHERE token = $1`,
    [token, String(reason || 'invalid').slice(0, 200)]
  );
}

async function markTokenSent(token) {
  await pool.query(
    `UPDATE push_tokens SET last_sent_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE token = $1 AND enabled = TRUE`,
    [token]
  );
}

/**
 * Insert delivery attempt; returns false if duplicate (already sent for this notification+token).
 */
async function reserveDeliveryAttempt({ notificationId, userId, token }) {
  try {
    await pool.query(
      `INSERT INTO push_delivery_attempts (id, notification_id, user_id, token, status, created_at)
       VALUES ($1,$2,$3,$4,'queued',NOW())`,
      [uuidv4(), notificationId, userId, token]
    );
    return true;
  } catch (e) {
    if (e.code === '23505') return false;
    throw e;
  }
}

async function completeDeliveryAttempt({ notificationId, token, status, providerTicket, error }) {
  await pool.query(
    `UPDATE push_delivery_attempts
        SET status = $3, provider_ticket = $4, error = $5
      WHERE notification_id = $1 AND token = $2`,
    [notificationId, token, status, providerTicket || null, error ? String(error).slice(0, 500) : null]
  );
}

module.exports = {
  EXPO_TOKEN_RE,
  isValidExpoPushToken,
  normalizePlatform,
  registerPushToken,
  unregisterPushToken,
  setUserPushEnabled,
  isUserPushEnabled,
  listEnabledTokensForUser,
  disableToken,
  markTokenSent,
  reserveDeliveryAttempt,
  completeDeliveryAttempt,
};
