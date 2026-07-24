'use strict';

const { pool } = require('./pool');
const { writeEncryptedDocument, readEncryptedDocument, deleteEncryptedDocument } = require('../kycStorage');

let schemaReady = false;

async function ensureKycDocumentsTable() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kyc_documents (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      document_type TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'under_review',
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS kyc_documents_user_id_idx ON kyc_documents(user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS kyc_documents_status_idx ON kyc_documents(status)
  `);
  await pool.query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS reviewed_by TEXT`);
  await pool.query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
  schemaReady = true;
}

function mapDocumentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    documentType: row.document_type,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).getTime() : Date.now(),
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).getTime() : null,
    rejectionReason: row.rejection_reason || null,
  };
}

function toPublicDocument(doc) {
  return {
    id: doc.id,
    userId: doc.userId,
    type: doc.documentType,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    uploadedAt: doc.uploadedAt,
    reviewedBy: doc.reviewedBy || null,
    reviewedAt: doc.reviewedAt || null,
    rejectionReason: doc.rejectionReason || null,
  };
}

/**
 * Ensures a `users` row exists for `userId` so the kyc_documents FK is
 * satisfiable. This is a shim for callers whose primary user record lives in
 * the JSON-blob app state rather than the relational `users` table.
 *
 * Falls back to a synthetic per-user email (`${userId}@users.local`) when the
 * caller-supplied email collides with a *different* existing user id under
 * `users_email_lower_idx` (e.g. a stale/synthetic fixture, or an app-state
 * email that was since changed for another account). Using a SAVEPOINT keeps
 * this recoverable without aborting the caller's outer transaction.
 */
async function ensureRelationalUser(client, { userId, email, region, role }) {
  const primaryEmail = email || `${userId}@users.local`;
  await client.query('SAVEPOINT ensure_relational_user');
  try {
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at)
       VALUES ($1, $2, 'kyc-upload', $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, primaryEmail, region || 'US', role || 'individual'],
    );
    await client.query('RELEASE SAVEPOINT ensure_relational_user');
  } catch (error) {
    if (error.code !== '23505') throw error;
    await client.query('ROLLBACK TO SAVEPOINT ensure_relational_user');
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at)
       VALUES ($1, $2, 'kyc-upload', $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@users.local`, region || 'US', role || 'individual'],
    );
    await client.query('RELEASE SAVEPOINT ensure_relational_user');
  }
}

async function insertKycDocument({
  id,
  userId,
  documentType,
  storageKey,
  mimeType,
  sizeBytes,
  fileBuffer,
  status = 'under_review',
  userEmail,
  userRegion,
  userRole,
}) {
  await ensureKycDocumentsTable();
  writeEncryptedDocument(storageKey, fileBuffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureRelationalUser(client, {
      userId,
      email: userEmail,
      region: userRegion,
      role: userRole,
    });
    const result = await client.query(
      `INSERT INTO kyc_documents (
        id, user_id, document_type, storage_key, mime_type, size_bytes, status, uploaded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *`,
      [id, userId, documentType, storageKey, mimeType, sizeBytes, status]
    );
    await client.query('COMMIT');
    return mapDocumentRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    deleteEncryptedDocument(storageKey);
    throw error;
  } finally {
    client.release();
  }
}

async function listKycDocuments({ userId, status } = {}) {
  await ensureKycDocumentsTable();
  const clauses = [];
  const params = [];
  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT * FROM kyc_documents ${where} ORDER BY uploaded_at DESC`,
    params
  );
  return result.rows.map(mapDocumentRow);
}

async function getKycDocumentById(documentId) {
  await ensureKycDocumentsTable();
  const result = await pool.query('SELECT * FROM kyc_documents WHERE id = $1 LIMIT 1', [documentId]);
  return mapDocumentRow(result.rows[0]);
}

async function readKycDocumentContent(documentId) {
  const doc = await getKycDocumentById(documentId);
  if (!doc) return null;
  const buffer = readEncryptedDocument(doc.storageKey);
  if (!buffer) return null;
  return { document: doc, buffer };
}

async function deleteKycDocument(documentId) {
  const doc = await getKycDocumentById(documentId);
  if (!doc) return false;
  await pool.query('DELETE FROM kyc_documents WHERE id = $1', [documentId]);
  deleteEncryptedDocument(doc.storageKey);
  return true;
}

async function updateKycDocumentReview(documentId, {
  status,
  reviewedBy,
  rejectionReason = null,
}) {
  await ensureKycDocumentsTable();
  const result = await pool.query(
    `UPDATE kyc_documents
     SET status = $2,
         reviewed_by = $3,
         reviewed_at = NOW(),
         rejection_reason = $4
     WHERE id = $1
     RETURNING *`,
    [documentId, status, reviewedBy, rejectionReason],
  );
  return mapDocumentRow(result.rows[0]);
}

async function updateUserKycFields(userId, { kycStatus, kycTier }) {
  await ensureKycDocumentsTable();
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_tier INT DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_updated_at TIMESTAMPTZ`);
  await pool.query(
    `UPDATE users
     SET kyc_status = $2,
         kyc_tier = $3,
         kyc_updated_at = NOW()
     WHERE id = $1`,
    [userId, kycStatus, kycTier],
  );
}

module.exports = {
  ensureKycDocumentsTable,
  insertKycDocument,
  listKycDocuments,
  getKycDocumentById,
  readKycDocumentContent,
  deleteKycDocument,
  updateKycDocumentReview,
  updateUserKycFields,
  toPublicDocument,
};
