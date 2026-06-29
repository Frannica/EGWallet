'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const {
  ensureAdminPlatformTables,
  countAdminUsers,
  createAdminUser,
  findAdminWithPasswordByEmail,
  findAdminById,
  recordAdminLoginSuccess,
  recordAdminLoginFailure,
} = require('./db/adminPlatformPostgres');
const { logAdminAction } = require('./adminAudit');

const ADMIN_ROLES = ['super_admin', 'support', 'compliance', 'read_only'];

const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  support: [
    'stats:read', 'users:read', 'users:write', 'notes:read', 'notes:write',
    'timeline:read', 'kyc:read', 'withdrawals:read', 'logs:read', 'search:read',
  ],
  compliance: [
    'stats:read', 'users:read', 'timeline:read', 'kyc:read', 'kyc:approve',
    'withdrawals:read', 'withdrawals:write', 'notes:read', 'search:read',
  ],
  read_only: [
    'stats:read', 'users:read', 'timeline:read', 'kyc:read',
    'withdrawals:read', 'notes:read', 'logs:read', 'search:read',
  ],
};

const MAX_ADMIN_LOGIN_ATTEMPTS = 5;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_JWT_EXPIRY = process.env.ADMIN_JWT_EXPIRY || '8h';

function getJwtSecret() {
  return process.env.JWT_SECRET || 'dev_secret_change_me';
}

function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes('*') || perms.includes(permission);
}

function getPermissionsForRole(role) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes('*') ? Object.values(ROLE_PERMISSIONS).flat().filter((p) => p !== '*').concat(['*']) : perms;
}

function signAdminToken(admin) {
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

function verifyAdminToken(token) {
  const payload = jwt.verify(token, getJwtSecret());
  if (payload.type !== 'admin_access') throw new Error('Invalid admin token type');
  return payload;
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
      console.warn('[admin] No admin users found. Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD to create the first super_admin.');
      return;
    }
    await createAdminUser({ email, password, role: 'super_admin' });
    console.log(`[admin] Bootstrapped super_admin account for ${email.toLowerCase().trim()}`);
  } catch (error) {
    console.warn('[admin] Bootstrap skipped:', error.message);
  }
}

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = verifyAdminToken(token);
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
      logAdminAction(req, 'ADMIN_LOGIN_FAILED', { adminId: admin.id, email: admin.email, attempts });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await recordAdminLoginSuccess(admin.id);
    const fresh = await findAdminById(admin.id);
    const token = signAdminToken(fresh);
    const decoded = jwt.decode(token);
    logAdminAction(req, 'ADMIN_LOGIN', { adminId: fresh.id, email: fresh.email, role: fresh.role });

    res.json({
      token,
      expiresAt: decoded.exp * 1000,
      admin: {
        id: fresh.id,
        email: fresh.email,
        role: fresh.role,
        permissions: getPermissionsForRole(fresh.role),
      },
    });
  } catch (_error) {
    res.status(500).json({ error: 'Login failed' });
  }
}

function adminMeHandler(req, res) {
  res.json({
    admin: {
      id: req.admin.id,
      email: req.admin.email,
      role: req.admin.role,
      permissions: req.adminPermissions,
    },
  });
}

function adminLogoutHandler(req, res) {
  logAdminAction(req, 'ADMIN_LOGOUT', { adminId: req.admin?.id });
  res.json({ ok: true });
}

function getAdminActor(req) {
  if (req.admin) return req.admin.email;
  return req.headers['x-admin-id'] || req.headers['x-admin-name'] || 'admin';
}

module.exports = {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  adminAuth,
  requirePermission,
  hasPermission,
  getPermissionsForRole,
  signAdminToken,
  verifyAdminToken,
  bootstrapAdminIfNeeded,
  adminLoginHandler,
  adminMeHandler,
  adminLogoutHandler,
  getAdminActor,
};
