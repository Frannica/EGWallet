'use strict';

const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const {
  insertKycDocument,
  toPublicDocument,
} = require('./db/kycUploadPostgres');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOC_TYPES = new Set(['id_card', 'passport', 'drivers_license', 'proof_of_address']);
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const kycMulter = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      cb(new Error('INVALID_MIME'));
      return;
    }
    cb(null, true);
  },
});

function detectMimeFromBuffer(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const brand = buffer.slice(4, 12).toString('ascii').toLowerCase();
  if (brand.includes('heic') || brand.includes('heif') || brand.includes('mif1')) {
    return 'image/heic';
  }
  return null;
}

function validateUploadedFile(file) {
  if (!file || !file.buffer || !file.buffer.length) {
    return { ok: false, status: 400, error: 'Document file is required', errorCode: 'missing_file' };
  }
  const declaredMime = String(file.mimetype || '').toLowerCase();
  if (!ALLOWED_MIME.has(declaredMime)) {
    return { ok: false, status: 400, error: 'Invalid file type', errorCode: 'invalid_mime' };
  }
  const detectedMime = detectMimeFromBuffer(file.buffer);
  if (!detectedMime) {
    return { ok: false, status: 400, error: 'Invalid file type', errorCode: 'invalid_mime' };
  }
  const mimeFamily = (mime) => {
    if (mime === 'image/jpg' || mime === 'image/jpeg') return 'jpeg';
    if (mime === 'image/heif' || mime === 'image/heic') return 'heic';
    return mime;
  };
  if (mimeFamily(declaredMime) !== mimeFamily(detectedMime)) {
    return { ok: false, status: 400, error: 'Invalid file type', errorCode: 'invalid_mime' };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, status: 400, error: 'File too large', errorCode: 'file_too_large' };
  }
  return { ok: true, mimeType: detectedMime === 'image/jpeg' ? declaredMime : detectedMime };
}

function syncAppStateKyc(userId, documentType, documentMeta) {
  const db = loadAppState();
  if (!db.kyc) db.kyc = [];
  let userKyc = db.kyc.find((entry) => entry.userId === userId);
  if (!userKyc) {
    userKyc = { userId, status: 'under_review', documents: [] };
    db.kyc.push(userKyc);
  }
  userKyc.documents = [
    ...(userKyc.documents || []).filter((doc) => doc.type !== documentType),
    {
      id: documentMeta.id,
      type: documentType,
      status: documentMeta.status,
      uploadedAt: documentMeta.uploadedAt,
    },
  ];
  userKyc.status = 'under_review';
  saveAppState(db);
}

function kycUploadMiddleware(req, res, next) {
  kycMulter.single('document')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large', errorCode: 'file_too_large' });
    }
    if (err.message === 'INVALID_MIME') {
      return res.status(400).json({ error: 'Invalid file type', errorCode: 'invalid_mime' });
    }
    return res.status(400).json({ error: 'Upload failed', errorCode: 'upload_failed' });
  });
}

async function handleKycUpload(req, res) {
  const documentType = String(req.body?.documentType || '').trim();
  if (!documentType || !ALLOWED_DOC_TYPES.has(documentType)) {
    return res.status(400).json({ error: 'Missing or invalid documentType', errorCode: 'missing_fields' });
  }

  const validation = validateUploadedFile(req.file);
  if (!validation.ok) {
    return res.status(validation.status).json({
      error: validation.error,
      errorCode: validation.errorCode,
    });
  }

  const documentId = uuidv4();
  const storageKey = uuidv4();
  const sizeBytes = req.file.buffer.length;

  try {
    const saved = await insertKycDocument({
      id: documentId,
      userId: req.user.userId,
      documentType,
      storageKey,
      mimeType: validation.mimeType,
      sizeBytes,
      fileBuffer: req.file.buffer,
      status: 'under_review',
    });

    const responseDoc = {
      id: saved.id,
      type: documentType,
      status: saved.status,
      uploadedAt: saved.uploadedAt,
    };
    syncAppStateKyc(req.user.userId, documentType, responseDoc);
    return res.json({ success: true, document: responseDoc });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to store KYC document', errorCode: 'storage_failed' });
  }
}

module.exports = {
  ALLOWED_DOC_TYPES,
  ALLOWED_MIME,
  MAX_FILE_BYTES,
  detectMimeFromBuffer,
  validateUploadedFile,
  kycUploadMiddleware,
  handleKycUpload,
  toPublicDocument,
};
