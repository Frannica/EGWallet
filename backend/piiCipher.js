'use strict';
/**
 * piiCipher.js
 * AES-256-GCM field-level encryption for payout PII stored in db.json.
 *
 * Encrypted format:  egwpii1:<base64(JSON { iv, ct, tag })>
 * The "egwpii1:" prefix lets decryptPII distinguish encrypted values from
 * legacy plaintext and from null — so migration is always safe to retry.
 *
 * Key configuration:
 *   PII_ENCRYPTION_KEY  — 32-byte key as 64 hex chars or 44 base64 chars.
 *   In production the server refuses to start if this is missing (index.js).
 *   In development/test the helpers are no-ops (plaintext passthrough) so
 *   the server still runs without any key.
 */

const crypto = require('crypto');

const ALGO       = 'aes-256-gcm';
const ENC_PREFIX = 'egwpii1:';

function _getKey() {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('PII_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
  }
  return buf;
}

/**
 * Encrypt a single PII string field.
 * Returns the encrypted egwpii1: string, or the original value if:
 *   - value is falsy
 *   - PII_ENCRYPTION_KEY is not set (dev passthrough)
 *   - value is already encrypted
 */
function encryptPII(value) {
  if (!value) return value;
  if (isEncrypted(value)) return value; // idempotent
  const key = _getKey();
  if (!key) return value; // dev passthrough — production blocked at startup
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct     = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  const payload = JSON.stringify({
    iv:  iv.toString('base64'),
    ct:  ct.toString('base64'),
    tag: tag.toString('base64'),
  });
  return ENC_PREFIX + Buffer.from(payload, 'utf8').toString('base64');
}

/**
 * Decrypt a PII string encrypted by encryptPII.
 * Returns the original value unchanged if:
 *   - value is falsy
 *   - value does not start with egwpii1: (legacy plaintext — safe passthrough)
 */
function decryptPII(value) {
  if (!value || !isEncrypted(value)) return value;
  const key = _getKey();
  if (!key) throw new Error('PII_ENCRYPTION_KEY is required to decrypt payout PII');
  const payload  = JSON.parse(Buffer.from(value.slice(ENC_PREFIX.length), 'base64').toString('utf8'));
  const iv       = Buffer.from(payload.iv,  'base64');
  const ct       = Buffer.from(payload.ct,  'base64');
  const tag      = Buffer.from(payload.tag, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

/** Returns true when the value was produced by encryptPII. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Compute a safe display mask for an account number.
 * Returns "****<last4>" or "****" when fewer than 4 digits are present.
 */
function maskAccountNumber(accountNumber) {
  if (!accountNumber) return null;
  const digits = String(accountNumber).replace(/\D/g, '');
  const last4  = digits.slice(-4);
  return last4 ? `****${last4}` : '****';
}

module.exports = { encryptPII, decryptPII, isEncrypted, maskAccountNumber };
