'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const ENC_MAGIC = Buffer.from('EGWKYC1');
const DEFAULT_STORAGE_DIR = path.join(__dirname, '.data', 'kyc-documents');

function getStorageDir() {
  return process.env.KYC_STORAGE_DIR || DEFAULT_STORAGE_DIR;
}

function getEncryptionKey() {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('PII_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
  }
  return buf;
}

function ensureStorageDir() {
  const dir = getStorageDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function storagePathForKey(storageKey) {
  return path.join(getStorageDir(), `${storageKey}.enc`);
}

function encryptBuffer(buffer) {
  const key = getEncryptionKey();
  if (!key) return buffer;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, iv, tag, ct]);
}

function decryptBuffer(payload) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const key = getEncryptionKey();
  if (!key) return payload;
  if (payload.length < ENC_MAGIC.length + 12 + 16) {
    throw new Error('Invalid encrypted KYC payload');
  }
  const magic = payload.subarray(0, ENC_MAGIC.length);
  if (!magic.equals(ENC_MAGIC)) return payload;
  const iv = payload.subarray(ENC_MAGIC.length, ENC_MAGIC.length + 12);
  const tag = payload.subarray(ENC_MAGIC.length + 12, ENC_MAGIC.length + 28);
  const ct = payload.subarray(ENC_MAGIC.length + 28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function writeEncryptedDocument(storageKey, buffer) {
  ensureStorageDir();
  const encrypted = encryptBuffer(buffer);
  const filePath = storagePathForKey(storageKey);
  fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
  return filePath;
}

function readEncryptedDocument(storageKey) {
  const filePath = storagePathForKey(storageKey);
  if (!fs.existsSync(filePath)) return null;
  const encrypted = fs.readFileSync(filePath);
  return decryptBuffer(encrypted);
}

function deleteEncryptedDocument(storageKey) {
  const filePath = storagePathForKey(storageKey);
  if (!fs.existsSync(filePath)) return;
  fs.unlinkSync(filePath);
}

module.exports = {
  getStorageDir,
  ensureStorageDir,
  writeEncryptedDocument,
  readEncryptedDocument,
  deleteEncryptedDocument,
  encryptBuffer,
  decryptBuffer,
};
