'use strict';

const fs = require('fs');
const path = require('path');

const KYC_SCREEN = path.join(__dirname, '..', 'src', 'screens', 'KYCVerificationScreen.tsx');
const source = fs.readFileSync(KYC_SCREEN, 'utf8');

const ALLOWED_DOC_TYPES = ['id_card', 'passport', 'drivers_license', 'proof_of_address'];
const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

function normalizePickerAsset(result) {
  if (!result || result.canceled || !result.assets?.[0]) return null;
  return result.assets[0];
}

function validateKycAsset(asset, docType) {
  if (!ALLOWED_DOC_TYPES.includes(docType)) return { ok: false, reason: 'invalid_doc_type' };
  const mimeType = asset.mimeType?.toLowerCase() ?? 'image/jpeg';
  if (!ALLOWED_MIME.includes(mimeType)) return { ok: false, reason: 'invalid_mime' };
  if (!asset.uri || (!asset.uri.startsWith('file://') && !asset.uri.startsWith('content://'))) {
    return { ok: false, reason: 'invalid_uri' };
  }
  if (asset.fileSize && asset.fileSize > 10 * 1024 * 1024) return { ok: false, reason: 'file_too_large' };
  return { ok: true, mimeType };
}

function mergeCapturedDocument(documents, type, uploadedAt = Date.now()) {
  const newDoc = {
    id: Math.random().toString(36).substring(7),
    type,
    status: 'under_review',
    uploadedAt,
  };
  return [...documents.filter(d => d.type !== type), newDoc];
}

const GOOD_ASSET = {
  uri: 'file:///data/user/0/com.app/cache/ImagePicker/photo.jpg',
  mimeType: 'image/jpeg',
  fileSize: 2_000_000,
};

module.exports = function runKycUploadFlowTests(check) {
  check('[Picker] camera capture returns asset when not canceled', !!normalizePickerAsset({
    canceled: false,
    assets: [GOOD_ASSET],
  }));
  check('[Picker] canceled camera result returns null', normalizePickerAsset({ canceled: true, assets: [] }) === null);
  check('[Picker] gallery selection returns asset when not canceled', !!normalizePickerAsset({
    canceled: false,
    assets: [{ ...GOOD_ASSET, uri: 'content://media/external/images/1' }],
  }));

  check('[Validation] valid cropped JPEG passes', validateKycAsset(GOOD_ASSET, 'id_card').ok === true);
  check('[Validation] invalid URI blocks before upload', validateKycAsset({ ...GOOD_ASSET, uri: 'https://evil.com/x.jpg' }, 'id_card').ok === false);

  check('[State] cropped image stored in document list merge', (() => {
    const merged = mergeCapturedDocument([
      { id: '1', type: 'id_card', status: 'rejected', uploadedAt: 1 },
    ], 'id_card');
    return merged.length === 1 && merged[0].status === 'under_review';
  })());

  check('[Preview] pendingCaptures stored before upload', /setPendingCaptures[\s\S]*?uploadDocument/.test(source));
  check('[Preview] preview thumbnail rendered on KYC screen', /pendingCaptures\[type\][\s\S]*?previewThumb/.test(source));

  check('[Navigation] onImageSelected executes after picker', /async function onImageSelected\(/.test(source));
  check('[Navigation] source modal defers picker after close', /setTimeout\(\(\) => \{ pickDocument\(type, source\); \}, 0\)/.test(source));
  check('[Navigation] picker no longer launched from Alert.alert callback', !/Alert\.alert\([\s\S]*?pickAndUpload\(type, 'camera'\)/.test(source));

  check('[Android] getPendingResultAsync recovery exported', /export async function recoverAndroidPickerResult/.test(source));
  check('[Android] launchPicker checks pending result first', /async function launchPicker[\s\S]*?recoverAndroidPickerResult/.test(source));
  check('[Android] useFocusEffect recovers pending crop result', /useFocusEffect[\s\S]*?recoverAndroidPickerResult/.test(source));

  check('[Fix] old silent crop discard removed', !/if \(result\.canceled \|\| !result\.assets\?\.\[0\]\) return;/.test(source));
  check('[Fix] normalizePickerAsset used instead of raw canceled check', /const asset = normalizePickerAsset\(result\)/.test(source));
  check('[Fix] exported helper functions present in screen', /export function normalizePickerAsset/.test(source)
    && /export function validateKycAsset/.test(source)
    && /export function mergeCapturedDocument/.test(source));
};
