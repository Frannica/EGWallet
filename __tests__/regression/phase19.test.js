'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = fs.readFileSync(path.join(ROOT, 'backend', 'index.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SettingsScreen.tsx'), 'utf8');
const API_ERR = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'apiErrorMessage.ts'), 'utf8');
const I18N = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'translations.ts'), 'utf8');

module.exports = function phase19(check) {
  check(
    '[Username] backend exposes PUT /auth/username',
    BACKEND.includes("app.put('/auth/username', authMiddleware, setUsernameHandler)"),
  );
  check(
    '[Username] backend exposes POST /auth/username fallback',
    BACKEND.includes("app.post('/auth/username', authMiddleware, setUsernameHandler)"),
  );
  check(
    '[Username] backend returns errorCode on username validation failures',
    BACKEND.includes("errorCode: 'error_username_taken'") &&
    BACKEND.includes("errorCode: 'error_username_invalid'"),
  );
  check(
    '[Username] 404 handler returns localized errorCode',
    BACKEND.includes("errorCode: 'error_not_found'") &&
    !BACKEND.includes("error: 'Not found'"),
  );
  check(
    '[Username] Settings uses fetchWithTokenRefresh for username save',
    SETTINGS.includes('fetchWithTokenRefresh(`${API_BASE}/auth/username`'),
  );
  check(
    '[Username] Settings maps API errors through getApiErrorMessage with errorCode',
    SETTINGS.includes('errorCode: data.errorCode') &&
    SETTINGS.includes('getApiErrorMessage({ message: data.error'),
  );
  check(
    '[Username] Settings updates auth profile after success',
    SETTINGS.includes('auth.updateUsername(data.username)'),
  );
  check(
    '[Username] Settings validates username length before API call',
    SETTINGS.includes("t('apiError.usernameInvalid')") &&
    SETTINGS.includes('{3,20}'),
  );
  check(
    '[i18n] getApiErrorMessage maps error_not_found to client translation key',
    API_ERR.includes("error_not_found: 'apiError.notFound'") &&
    API_ERR.includes("return t('apiError.requestFailed')"),
  );
  check(
    '[i18n] Spanish apiError.notFound translation exists',
    I18N.includes("'apiError.notFound': 'No encontrado.'"),
  );
};
