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
  };
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
}) {
  await ensureKycDocumentsTable();
  writeEncryptedDocument(storageKey, fileBuffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

module.exports = {
  ensureKycDocumentsTable,
  insertKycDocument,
  listKycDocuments,
  getKycDocumentById,
  readKycDocumentContent,
  deleteKycDocument,
  toPublicDocument,
};
