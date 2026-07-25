'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  ensureAdminPlatformTables,
  countAdminUsers,
  createAdminUser,
  findAdminWithPasswordByEmail,
  findAdminById,
  recordAdminLoginSuccess,
  recordAdminLoginFailure,
  storeAdminRefreshToken,
  findAdminRefreshToken,
  deleteAdminRefreshToken,
  deleteAdminRefreshTokensForUser,
} = require('./db/adminPlatformPostgres');
const { logAdminAction } = require('./adminAudit');
const {
  issueCsrfToken,
  revokeCsrfToken,
  touchOnlineAdmin,
  removeOnlineAdmin,
  adminCsrf,
} = require('./adminSessions');
const winston = require('winston');

const adminLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [admin] ${level}: ${message}`),
  ),
  transports: [new winston.transports.Console()],
});

const ADMIN_ROLES = ['super_admin', 'support', 'compliance', 'read_only'];

const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  support: [
    'stats:read', 'health:read', 'audit:read', 'users:read', 'users:write', 'users:export',
    'notes:read', 'notes:write', 'timeline:read', 'kyc:read', 'withdrawals:read', 'refunds:read', 'logs:read', 'search:read',
    'tickets:read', 'tickets:write', 'disputes:read', 'disputes:write', 'notifications:read', 'notifications:write',
    'fraud:read',
  ],
  compliance: [
    'stats:read', 'health:read', 'audit:read', 'users:read', 'timeline:read', 'kyc:read', 'kyc:approve',
    'withdrawals:read', 'withdrawals:write', 'refunds:read', 'refunds:write', 'notes:read', 'search:read',
    'disputes:read', 'disputes:write', 'fraud:read',
  ],
  read_only: [
    'stats:read', 'health:read', 'audit:read', 'users:read', 'timeline:read', 'kyc:read',
    'withdrawals:read', 'refunds:read', 'notes:read', 'logs:read', 'search:read',
    'tickets:read', 'disputes:read', 'notifications:read', 'fraud:read',
  ],
};

const MAX_ADMIN_LOGIN_ATTEMPTS = 5;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_JWT_EXPIRY = process.env.ADMIN_JWT_EXPIRY || '15m';
const ADMIN_REFRESH_EXPIRY = process.env.ADMIN_REFRESH_EXPIRY || '7d';

function getJwtSecret() {
  return process.env.JWT_SECRET || 'dev_secret_change_me';
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes('*') || perms.includes(permission);
}

function getPermissionsForRole(role) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes('*')
    ? Object.values(ROLE_PERMISSIONS).flat().filter((p) => p !== '*').concat([
      '*', 'kyc:download', 'settings:read', 'settings:write',
      'tickets:read', 'tickets:write', 'disputes:read', 'disputes:write',
      'notifications:read', 'notifications:write', 'fraud:read',
    ])
    : perms;
}

function signAdminAccessToken(admin) {
  return jwt.sign(
    {
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
      type: 'admin_access',
      tokenVersion: admin.tokenVersion || 0,
    },
    getJwtSecret(),
    { expiresIn: ADMIN_JWT_EXPIRY },
  );
}

function signAdminRefreshToken(admin) {
  return jwt.sign(
    {
      adminId: admin.id,
      type: 'admin_refresh',
      tokenVersion: admin.tokenVersion || 0,
    },
    getJwtSecret(),
    { expiresIn: ADMIN_REFRESH_EXPIRY },
  );
}

function verifyAdminAccessToken(token) {
  const payload = jwt.verify(token, getJwtSecret());
  if (payload.type !== 'admin_access') throw new Error('Invalid admin token type');
  return payload;
}

async function issueAdminSession(req, admin) {
  const accessToken = signAdminAccessToken(admin);
  const refreshToken = signAdminRefreshToken(admin);
  const csrfToken = issueCsrfToken(admin.id);
  const decoded = jwt.decode(accessToken);
  const refreshDecoded = jwt.decode(refreshToken);

  await storeAdminRefreshToken({
    tokenHash: hashToken(refreshToken),
    adminId: admin.id,
    expiresAt: refreshDecoded.exp * 1000,
  });

  touchOnlineAdmin({ admin, headers: req.headers, connection: req.connection });

  return {
    token: accessToken,
    refreshToken,
    csrfToken,
    expiresAt: decoded.exp * 1000,
    admin: {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      lastLoginAt: admin.lastLoginAt,
      permissions: getPermissionsForRole(admin.role),
      twoFactorEnabled: false,
    },
  };
}

async function bootstrapAdminIfNeeded() {
  if (!process.env.DATABASE_URL) return;
  try {
    await ensureAdminPlatformTables();
    const count = await countAdminUsers();
    if (count > 0) return;
    const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!email || !password) {
      adminLogger.warn('Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD for first super_admin.');
      return;
    }
    await createAdminUser({ email, password, role: 'super_admin' });
    adminLogger.info(`Bootstrapped super_admin for ${email.toLowerCase().trim()}`);
  } catch (error) {
    adminLogger.warn(`Bootstrap skipped: ${error.message}`);
  }
}

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = verifyAdminAccessToken(token);
  } catch (_error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  findAdminById(payload.adminId)
    .then((admin) => {
      if (!admin || admin.status !== 'active') {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if ((admin.tokenVersion || 0) !== (payload.tokenVersion || 0)) {
        return res.status(401).json({ error: 'Session expired' });
      }
      req.admin = admin;
      req.adminPermissions = getPermissionsForRole(admin.role);
      touchOnlineAdmin(req);
      next();
    })
    .catch(() => res.status(401).json({ error: 'Unauthorized' }));
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
    if (!hasPermission(req.admin.role, permission)) {
      return res.status(403).json({ error: 'Forbidden', required: permission });
    }
    next();
  };
}

async function adminLoginHandler(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    await ensureAdminPlatformTables();
    const admin = await findAdminWithPasswordByEmail(email);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (admin.status !== 'active') {
      return res.status(403).json({ error: 'Account disabled' });
    }
    if (admin.lockedUntil && admin.lockedUntil > Date.now()) {
      return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
    }

    if (!bcrypt.compareSync(password, admin.passwordHash)) {
      const attempts = (admin.failedLoginAttempts || 0) + 1;
      const lockedUntil = attempts >= MAX_ADMIN_LOGIN_ATTEMPTS ? Date.now() + ADMIN_LOCK_MS : null;
      await recordAdminLoginFailure(admin.id, attempts, lockedUntil);
      logAdminAction(req, 'ADMIN_LOGIN_FAILED', {
        before: { failedAttempts: admin.failedLoginAttempts || 0 },
        after: { failedAttempts: attempts, lockedUntil },
        email: admin.email,
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await recordAdminLoginSuccess(admin.id);
    const fresh = await findAdminById(admin.id);
    const session = await issueAdminSession(req, fresh);
    logAdminAction(req, 'ADMIN_LOGIN', {
      adminId: fresh.id,
      email: fresh.email,
      role: fresh.role,
      after: { lastLoginAt: Date.now() },
    });
    res.json(session);
  } catch (_error) {
    res.status(500).json({ error: 'Login failed' });
  }
}

async function adminRefreshHandler(req, res) {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  try {
    const payload = jwt.verify(refreshToken, getJwtSecret());
    if (payload.type !== 'admin_refresh') return res.status(401).json({ error: 'Invalid refresh token' });

    const stored = await findAdminRefreshToken(hashToken(refreshToken));
    if (!stored || new Date(stored.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    const admin = await findAdminById(payload.adminId);
    if (!admin || admin.status !== 'active') return res.status(401).json({ error: 'Unauthorized' });
    if ((admin.tokenVersion || 0) !== (payload.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Session expired' });
    }

    await deleteAdminRefreshToken(hashToken(refreshToken));
    const session = await issueAdminSession(req, admin);
    res.json(session);
  } catch (_error) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
}

function adminMeHandler(req, res) {
  res.json({
    admin: {
      id: req.admin.id,
      email: req.admin.email,
      role: req.admin.role,
      lastLoginAt: req.admin.lastLoginAt,
      permissions: req.adminPermissions,
      twoFactorEnabled: false,
    },
  });
}

async function adminLogoutHandler(req, res) {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    await deleteAdminRefreshToken(hashToken(refreshToken)).catch(() => {});
  }
  revokeCsrfToken(req.admin?.id);
  removeOnlineAdmin(req.admin?.id);
  logAdminAction(req, 'ADMIN_LOGOUT', { adminId: req.admin?.id });
  res.json({ ok: true });
}

function adminHeartbeatHandler(req, res) {
  touchOnlineAdmin(req);
  res.json({ ok: true, lastSeen: Date.now() });
}

function getAdminActor(req) {
  if (req.admin) return req.admin.email;
  return req.headers['x-admin-id'] || req.headers['x-admin-name'] || 'admin';
}

module.exports = {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  adminAuth,
  adminCsrf,
  requirePermission,
  hasPermission,
  getPermissionsForRole,
  signAdminAccessToken,
  verifyAdminAccessToken,
  bootstrapAdminIfNeeded,
  adminLoginHandler,
  adminRefreshHandler,
  adminMeHandler,
  adminLogoutHandler,
  adminHeartbeatHandler,
  getAdminActor,
};
