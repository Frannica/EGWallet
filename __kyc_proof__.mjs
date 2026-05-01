// ================================================================
//  KYC Camera Security Proof — mirrors KYCVerificationScreen logic
// ================================================================

let PASS = 0, FAIL = 0;
function check(label, result, expected) {
  const ok = result === expected;
  if (ok) { PASS++; console.log('  PASS  ' + label); }
  else    { FAIL++; console.log('  FAIL  ' + label + '  (got: ' + JSON.stringify(result) + ')'); }
}

const ALLOWED_DOC_TYPES = ['id_card', 'passport', 'drivers_license', 'proof_of_address'];
const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

function validateKYCUpload(docType, asset) {
  if (!ALLOWED_DOC_TYPES.includes(docType))
    return { blocked: true, reason: 'Invalid document type: ' + docType };

  const mimeType = asset.mimeType?.toLowerCase() ?? 'image/jpeg';
  if (!ALLOWED_MIME.includes(mimeType))
    return { blocked: true, reason: 'Invalid MIME type: ' + mimeType };

  if (!asset.uri || (!asset.uri.startsWith('file://') && !asset.uri.startsWith('content://')))
    return { blocked: true, reason: 'Invalid URI: ' + asset.uri };

  if (asset.fileSize && asset.fileSize > 10 * 1024 * 1024)
    return { blocked: true, reason: 'File too large: ' + asset.fileSize };

  return { blocked: false, mimeType };
}

const GOOD = { uri: 'file:///data/user/0/photo.jpg', mimeType: 'image/jpeg', fileSize: 2_000_000 };

console.log('\n━━━  DOCUMENT TYPE VALIDATION  ━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 1-4. Valid doc types
for (const t of ['id_card','passport','drivers_license','proof_of_address'])
  check('Accepted doc type: ' + t, validateKYCUpload(t, GOOD).blocked, false);

// 5. Unknown type
check('Unknown doc type blocked',                validateKYCUpload('bank_account', GOOD).blocked,              true);
// 6. Prototype pollution
check('__proto__ doc type blocked',              validateKYCUpload('__proto__', GOOD).blocked,                 true);
// 7. SQL injection
check("SQL injection in type blocked",           validateKYCUpload("'; DROP TABLE users; --", GOOD).blocked,   true);

console.log('\n━━━  MIME TYPE VALIDATION  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 8-13. Valid MIME types
for (const m of ['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif'])
  check('Accepted MIME: ' + m, validateKYCUpload('passport', { ...GOOD, mimeType: m }).blocked, false);

// 14. PDF
check('PDF (application/pdf) blocked',           validateKYCUpload('id_card', { ...GOOD, mimeType: 'application/pdf' }).blocked,          true);
// 15. Executable
check('Executable (octet-stream) blocked',       validateKYCUpload('id_card', { ...GOOD, mimeType: 'application/octet-stream' }).blocked,  true);
// 16. HTML
check('HTML (text/html) blocked',                validateKYCUpload('id_card', { ...GOOD, mimeType: 'text/html' }).blocked,                 true);
// 17. SVG (script injection vector)
check('SVG (image/svg+xml) blocked',             validateKYCUpload('id_card', { ...GOOD, mimeType: 'image/svg+xml' }).blocked,             true);
// 18. GIF
check('GIF (image/gif) blocked',                 validateKYCUpload('id_card', { ...GOOD, mimeType: 'image/gif' }).blocked,                 true);
// 19. Uppercase JPEG — normalised to image/jpeg by .toLowerCase(), should be ACCEPTED
check('IMAGE/JPEG normalised lowercase — accepted',  validateKYCUpload('id_card', { ...GOOD, mimeType: 'IMAGE/JPEG' }).blocked,                false);
// 19b. Uppercase dangerous type — must still be BLOCKED even after normalisation
check('IMAGE/SVG+XML uppercase still blocked',       validateKYCUpload('id_card', { ...GOOD, mimeType: 'IMAGE/SVG+XML' }).blocked,             true);
// 19c. Uppercase executable still blocked
check('APPLICATION/PDF uppercase still blocked',     validateKYCUpload('id_card', { ...GOOD, mimeType: 'APPLICATION/PDF' }).blocked,           true);
// 20. MIME with params
check('image/jpeg;charset=utf-8 blocked',            validateKYCUpload('id_card', { ...GOOD, mimeType: 'image/jpeg; charset=utf-8' }).blocked, true);

console.log('\n━━━  URI VALIDATION  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 21. Local file URI
check('file:// URI accepted',                    validateKYCUpload('id_card', { ...GOOD, uri: 'file:///data/photo.jpg' }).blocked,                    false);
// 22. Android content URI
check('content:// URI accepted',                 validateKYCUpload('id_card', { ...GOOD, uri: 'content://media/external/images/1234' }).blocked,      false);
// 23. Remote HTTP
check('http:// URI blocked',                     validateKYCUpload('id_card', { ...GOOD, uri: 'http://evil.com/malware.jpg' }).blocked,               true);
// 24. Remote HTTPS
check('https:// URI blocked',                    validateKYCUpload('id_card', { ...GOOD, uri: 'https://evil.com/steal.jpg' }).blocked,                true);
// 25. Empty URI
check('Empty URI blocked',                       validateKYCUpload('id_card', { ...GOOD, uri: '' }).blocked,                                          true);
// 26. Null URI
check('Null URI blocked',                        validateKYCUpload('id_card', { ...GOOD, uri: null }).blocked,                                        true);
// 27. data: URI (base64 injection)
check('data: URI blocked',                       validateKYCUpload('id_card', { ...GOOD, uri: 'data:image/jpeg;base64,/9j/abc...' }).blocked,         true);

console.log('\n━━━  FILE SIZE VALIDATION  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 28. Just under limit
check('9,999,999 bytes accepted',                validateKYCUpload('id_card', { ...GOOD, fileSize: 9_999_999 }).blocked,              false);
// 29. Exactly 10 MB
check('10 MB exactly accepted',                  validateKYCUpload('id_card', { ...GOOD, fileSize: 10 * 1024 * 1024 }).blocked,       false);
// 30. 1 byte over
check('10 MB + 1 byte blocked',                  validateKYCUpload('id_card', { ...GOOD, fileSize: 10 * 1024 * 1024 + 1 }).blocked,   true);
// 31. 50 MB bomb
check('50 MB file bomb blocked',                 validateKYCUpload('id_card', { ...GOOD, fileSize: 50_000_000 }).blocked,             true);
// 32. Unknown size (fileSize undefined) — server enforces server-side
check('fileSize undefined (unknown) accepted',   validateKYCUpload('id_card', { ...GOOD, fileSize: undefined }).blocked,              false);

console.log('\n━━━  RESULTS  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Passed: ' + PASS + ' / ' + (PASS + FAIL));
if (FAIL === 0) console.log('  ALL SECURITY CHECKS PASSED ✓');
else            console.log('  FAILURES: ' + FAIL);
console.log();
