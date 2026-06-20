require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { encryptPII, decryptPII, isEncrypted, maskAccountNumber } = require('./piiCipher');

/**
 * One-way hash for refresh token storage.
 * Raw JWTs are never persisted — only the SHA-256 digest.
 * Comparison: hashToken(incomingRaw) === storedRecord.tokenHash
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Evict oldest refresh-token records for a user beyond the session cap.
 * Prevents an unbounded list of valid sessions accumulating over time.
 * Caller is responsible for calling saveDB after this returns.
 */
function enforceSessionCap(db, userId, maxSessions = 5) {
  if (!db.refreshTokens) return;
  const userTokens = db.refreshTokens.filter(t => t.userId === userId);
  if (userTokens.length <= maxSessions) return;
  userTokens.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const toEvict = new Set(
    userTokens.slice(maxSessions).map(t => t.tokenHash).filter(Boolean)
  );
  db.refreshTokens = db.refreshTokens.filter(
    t => t.userId !== userId || !toEvict.has(t.tokenHash)
  );
}
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const axios = require('axios');
const winston = require('winston');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { createWithdrawal, advanceToProcessing, markWithdrawalFailed, markWithdrawalPaid } = require('./withdrawalEngine');
const { router: adminWithdrawalsRouter, adminLoginHandler, adminLogoutHandler } = require('./adminWithdrawals');
const { executePayout, payoutRouter } = require('./payoutProviders');
const nodemailer = require('nodemailer');

// Stripe — only initialise when secret key is present
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
if (!stripeClient) {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set — deposit endpoints will run in test/demo mode');
}
// Closed-testing only: allow demo deposits in production when Stripe is not configured.
const ALLOW_DEMO_DEPOSITS = process.env.ALLOW_DEMO_DEPOSITS === 'true';

// ==================== FIREBASE ADMIN SDK ====================
// Initialise once; all modules import { firebaseAdmin, firebaseAuth, firestore } from here.
// Credentials are loaded ONLY from the GOOGLE_SERVICE_ACCOUNT env var (full JSON string)

let firebaseAdmin = null;
let firebaseAuth  = null;
let firestore     = null;

(function initFirebase() {
  try {
    const admin = require('firebase-admin');
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT env var is not set. Firebase will be disabled.');
    }
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        ...(process.env.FIREBASE_DATABASE_URL && { databaseURL: process.env.FIREBASE_DATABASE_URL }),
      });
      console.log('Firebase Admin initialized');
    }
    firebaseAdmin = admin;
    firebaseAuth  = admin.auth();
    firestore     = admin.firestore();
  } catch (err) {
    console.warn('[Firebase] Initialisation failed:', err.message);
    console.warn('[Firebase] The backend will continue without Firebase. Set GOOGLE_SERVICE_ACCOUNT to enable it.');
  }
})();

// Environment Configuration
const DB_FILE = process.env.DB_FILE_PATH || path.join(__dirname, 'db.json');
const DB_BACKUP = process.env.DB_BACKUP_PATH || path.join(__dirname, 'db.json.bak');
if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set. All tokens would be forgeable. Set JWT_SECRET in your environment.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
console.log('PORT from Railway:', process.env.PORT);
const PORT = Number(process.env.PORT);
if (!process.env.PORT || isNaN(PORT) || PORT <= 0) {
  console.error('❌ FATAL: PORT is not defined or invalid. Got:', process.env.PORT);
  process.exit(1);
}
const NODE_ENV = process.env.NODE_ENV || 'development';
if (ALLOW_DEMO_DEPOSITS && NODE_ENV === 'production' && !stripeClient) {
  console.warn('[Stripe] ALLOW_DEMO_DEPOSITS=true — demo deposit intents enabled in production (closed testing only)');
}

// Freshdesk Configuration
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

// Security Configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];

// Fraud Detection Configuration
const FRAUD_VELOCITY_THRESHOLD = parseInt(process.env.FRAUD_VELOCITY_THRESHOLD) || 5;
const FRAUD_TIME_WINDOW = parseInt(process.env.FRAUD_TIME_WINDOW_MS) || 3600000;

// Validate critical environment variables
if (NODE_ENV === 'production') {
  if (!JWT_SECRET || JWT_SECRET === 'dev_secret_change_me' || JWT_SECRET.length < 32) {
    console.error('❌ FATAL: JWT_SECRET is missing, set to the default value, or shorter than 32 characters. All tokens would be forgeable. Set a strong secret in your Railway environment variables.');
    process.exit(1);
  }

  const _adminSecret = process.env.ADMIN_SECRET;
  if (!_adminSecret || _adminSecret.length < 32) {
    console.error(
      '❌ FATAL: ADMIN_SECRET is missing or shorter than 32 characters. ' +
      'Without a strong ADMIN_SECRET, admin login is impossible and any pending_review ' +
      'withdrawals cannot be approved or refunded, permanently locking user funds. ' +
      'Set a strong ADMIN_SECRET in your Railway environment variables.'
    );
    process.exit(1);
  }

  // PII encryption key guard — without it payout PII is stored plaintext.
  if (!process.env.PII_ENCRYPTION_KEY) {
    console.error(
      '❌ FATAL: PII_ENCRYPTION_KEY is missing. Bank account numbers, IBANs, and holder ' +
      'names would be stored in plaintext in db.json. Generate a 32-byte key (openssl rand -hex 32) ' +
      'and set it in your Railway environment variables.'
    );
    process.exit(1);
  }

  // CORS wildcard guard — credentials: true + '*' allows any site to read API responses.
  if (ALLOWED_ORIGINS.includes('*')) {
    console.error(
      '❌ FATAL: ALLOWED_ORIGINS must be an explicit allowlist in production. ' +
      'Wildcard (*) combined with credentials: true lets any origin read wallet API responses. ' +
      'Set ALLOWED_ORIGINS=https://app.egwallet.com (comma-separated) in your environment.'
    );
    process.exit(1);
  }

  // Smile Identity sandbox guard — prevents sandbox test IDs from auto-approving
  // real production accounts, which would grant elevated KYC tier limits to attackers.
  if (process.env.SMILE_PARTNER_ID && process.env.SMILE_API_KEY) {
    const _smileBase = process.env.SMILE_API_BASE || '';
    if (!_smileBase || _smileBase.includes('testapi')) {
      console.error(
        '❌ FATAL: SMILE_PARTNER_ID and SMILE_API_KEY are set but SMILE_API_BASE is missing ' +
        'or still points to the Smile Identity sandbox (testapi.smileidentity.com). ' +
        'Sandbox test IDs would be accepted as valid production KYC, granting elevated limits. ' +
        'Set SMILE_API_BASE to the Smile production endpoint (e.g. https://api.smileidentity.com/v1) ' +
        'in your Railway environment variables.'
      );
      process.exit(1);
    }
  }

  // C6: Single-instance guard — db.json is not safe for concurrent multi-process writes.
  // Set WEB_CONCURRENCY=1 and RAILWAY_REPLICAS=1 in your deployment environment.
  const _webConcurrency   = parseInt(process.env.WEB_CONCURRENCY   || '1', 10);
  const _railwayReplicas  = parseInt(process.env.RAILWAY_REPLICAS   || '1', 10);
  if (_webConcurrency > 1 || _railwayReplicas > 1) {
    console.error(
      `❌ FATAL: Multi-instance deployment detected ` +
      `(WEB_CONCURRENCY=${_webConcurrency}, RAILWAY_REPLICAS=${_railwayReplicas}). ` +
      `EGWallet uses a single-file database (db.json) that is not safe for concurrent ` +
      `writes across processes. Set WEB_CONCURRENCY=1 and RAILWAY_REPLICAS=1 before deploying.`
    );
    process.exit(1);
  }

  // Webhook secrets guard — without these, provider settlement events are silently dropped,
  // leaving holdBalance permanently locked on real payouts.
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error(
      '❌ FATAL: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing. ' +
      'Stripe settlement webhooks will be silently dropped, permanently locking user holdBalance. ' +
      'Set STRIPE_WEBHOOK_SECRET from your Stripe dashboard (Developers → Webhooks).'
    );
    process.exit(1);
  }
  if (process.env.KORA_API_KEY && !process.env.KORA_WEBHOOK_SECRET) {
    console.error(
      '❌ FATAL: KORA_API_KEY is set but KORA_WEBHOOK_SECRET is missing. ' +
      'Kora settlement webhooks will be silently dropped, permanently locking user holdBalance. ' +
      'Set KORA_WEBHOOK_SECRET from your Kora dashboard webhook settings.'
    );
    process.exit(1);
  }

  // Stripe test-key guard — test keys allow fake card charges that credit real wallets,
  // enabling attackers to fund Kora (or other live-rail) withdrawals with no real money.
  if ((process.env.STRIPE_SECRET_KEY      || '').startsWith('sk_test_')) {
    console.error(
      '❌ FATAL: STRIPE_SECRET_KEY starts with sk_test_ in a production environment. ' +
      'Test-mode Stripe charges are free — an attacker can deposit unlimited test funds and ' +
      'withdraw real money via a live payout rail (e.g. Kora). ' +
      'Set a live Stripe key (sk_live_…) or unset STRIPE_SECRET_KEY to disable Stripe deposits.'
    );
    process.exit(1);
  }
  if ((process.env.STRIPE_PUBLISHABLE_KEY || '').startsWith('pk_test_')) {
    console.error(
      '❌ FATAL: STRIPE_PUBLISHABLE_KEY starts with pk_test_ in a production environment. ' +
      'Mismatched test/live Stripe keys will cause PaymentSheet failures and indicate a ' +
      'misconfigured environment. Set a live publishable key (pk_live_…) or unset it.'
    );
    process.exit(1);
  }

  if (!FRESHDESK_DOMAIN || !FRESHDESK_API_KEY) {
    console.warn('⚠️  WARNING: Freshdesk not configured. Tickets will be stored locally only.');
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    console.warn('⚠️  WARNING: GOOGLE_SERVICE_ACCOUNT is not set. Firebase Auth and Firestore will be unavailable.');
    console.warn('   Set this variable on Railway: paste the entire contents of your service account key JSON as its value.');
  }
}

// ==================== WINSTON LOGGER CONFIGURATION ====================

const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'egwallet-backend' },
  transports: [
    new winston.transports.File({ 
      filename: process.env.ERROR_LOG_PATH || path.join(logDir, 'error.log'), 
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: process.env.LOG_FILE_PATH || path.join(logDir, 'app.log'),
      maxsize: 10485760,
      maxFiles: 10
    })
  ]
});

// Always log to console — essential for Railway log visibility
logger.add(new winston.transports.Console({
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${extra}`;
    })
  )
}));

// Global crash handlers — catch anything that could silently kill the process
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — process will exit:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// Audit logger with separate file
const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: process.env.AUDIT_LOG_PATH || path.join(logDir, 'audit.log'),
      maxsize: 52428800, // 50MB
      maxFiles: 20
    })
  ]
});

// Idempotency store: { key: { response, timestamp } }
// Clean up keys older than 24 hours
const idempotencyStore = new Map();
const IDEMPOTENCY_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// ── Durable idempotency helpers ───────────────────────────────────────────────
// The in-memory Map is a fast-path cache. These helpers persist records to
// db.json so that retries after a process restart cannot double-charge.
// Both helpers must be called inside withBalanceMutex on a freshly-loaded db.

/**
 * Returns the cached response if a non-expired record exists AND was created by
 * the same authenticated user.  userId binding prevents IDOR: a different user
 * who happens to know the idempotency key cannot receive another user's response.
 */
function checkDurableIdempotency(db, clientKey, userId) {
  if (!clientKey || !userId) return null;
  const record = (db.idempotencyRecords || []).find(
    r => r.key === clientKey
      && r.userId === userId
      && Date.now() - r.timestamp < IDEMPOTENCY_EXPIRY
  );
  return record ? record.response : null;
}

/**
 * Persists the response for a completed financial operation, bound to the userId
 * who made the request.  Call this BEFORE saveDB() so the record is written
 * atomically with the balance mutation.  Also prunes expired records inline.
 */
function saveDurableIdempotency(db, clientKey, response, userId) {
  if (!clientKey || !userId) return;
  if (!db.idempotencyRecords) db.idempotencyRecords = [];
  db.idempotencyRecords = db.idempotencyRecords.filter(
    r => (r.key !== clientKey || r.userId !== userId) && Date.now() - r.timestamp < IDEMPOTENCY_EXPIRY
  );
  db.idempotencyRecords.push({ key: clientKey, userId, response, timestamp: Date.now() });
}

/** Coerce wallet amounts to integer minor units (guards against string amounts in db.json). */
function coerceMinorAmount(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Return a balance entry that lives inside wallet.balances (never a detached object). */
function getWalletBalanceEntry(wallet, currency, { create = false } = {}) {
  if (!wallet.balances) wallet.balances = [];
  let entry = wallet.balances.find(b => b.currency === currency);
  if (!entry && create) {
    entry = { currency, amount: 0 };
    wallet.balances.push(entry);
  }
  if (entry) entry.amount = coerceMinorAmount(entry.amount);
  return entry || null;
}

function normalizeWalletBalances(wallet) {
  if (!wallet?.balances) return;
  for (const b of wallet.balances) b.amount = coerceMinorAmount(b.amount);
}
// Global write serializer — replaces legacy per-wallet balanceInFlight Sets.
//
// Promise-chain pattern: every call to withBalanceMutex() is appended to
// _dbMutex so only one balance-mutating handler runs at a time inside this
// process, regardless of whether the handler contains an await.
// loadDB() is called INSIDE each callback so it always reads the freshest
// committed state after the previous mutation has been flushed to disk.
//
// What this protects:
//   ✓ Single-process async races (e.g. deposits/confirm awaiting Stripe)
//   ✓ Single-process sync races (two rapid requests)
//   ⚠ Multi-instance (two Railway pods) — detected and logged via _dbVersion;
//     full prevention requires a distributed lock (Redis) when scaling to >1 pod.
let _dbMutex = Promise.resolve();
function withBalanceMutex(fn) {
  const result = _dbMutex.then(() => fn());
  // Errors must not break the chain — subsequent requests must still get a turn.
  _dbMutex = result.catch(() => {});
  return result;
}

// Per-user mutex for refresh-token rotation.
// Serialises concurrent requests presenting the same refresh JWT so only the
// first one passes findIndex(); the second reads the DB after the first write
// and sees the token already consumed, returning 401 instead of issuing a
// second valid session (classic TOCTOU / token-multiplication attack).
const _refreshMutexMap = new Map();
function withRefreshMutex(userId, fn) {
  const prev = _refreshMutexMap.get(userId) || Promise.resolve();
  const next = prev.then(() => fn());
  // Errors must not break the per-user chain.
  _refreshMutexMap.set(userId, next.catch(() => {}));
  return next;
}

// Dedicated mutex for KYC verification — kept separate from withBalanceMutex so
// the 30-second Smile Identity API call never blocks unrelated balance mutations.
// Serialises the read-check-write cycle for kycIdHash reservation.
let _kycMutex = Promise.resolve();
function withKycMutex(fn) {
  const result = _kycMutex.then(() => fn());
  _kycMutex = result.catch(() => {});
  return result;
}

// ==================== DEVICE BINDING ABUSE PROTECTION ====================
// Persistent tracker: stored in db.device_signup_tracker (array of records)
// Enforces max 3 signups per unique device ID per 24 hours.
// Schema: { deviceId: string, timestamps: number[], updatedAt: number }
const DEVICE_SIGNUP_LIMIT = 3;
const DEVICE_SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Prune stale device_signup_tracker records from the DB every 6 hours
setInterval(() => {
  const db = loadDB();
  if (!db.device_signup_tracker) return;
  const cutoff = Date.now() - DEVICE_SIGNUP_WINDOW_MS;
  db.device_signup_tracker = db.device_signup_tracker
    .map(rec => ({ ...rec, timestamps: rec.timestamps.filter(ts => ts > cutoff) }))
    .filter(rec => rec.timestamps.length > 0);
  saveDB(db);
}, 6 * 60 * 60 * 1000);

// ==================== FEE SCHEDULE (single source of truth) ====================
const FEES = {
  TOPUP_FREE_LIMIT:    6,      // first N deposits are free per user
  TOPUP_FEE_RATE:      0.005,  // 0.5% after the free limit
  WITHDRAW_LOCAL_RATE: 0.0128, // 1.28% local withdrawal (bank / mobile money)
  WITHDRAW_INTL_RATE:  0.0175, // 1.75% international withdrawal
  FX_RATE:             0.0115, // 1.15% FX conversion markup
  SEND_RATE:           0,      // peer-to-peer sends are free
};

/**
 * Count completed deposits for a user (across all their wallets).
 * Used to determine whether the free top-up tier still applies.
 */
function getUserDepositCount(db, userId) {
  const userWalletIds = (db.wallets || [])
    .filter(w => w.userId === userId)
    .map(w => w.id);
  return (db.transactions || []).filter(t =>
    t.type === 'deposit' &&
    userWalletIds.includes(t.toWalletId) &&
    t.status === 'completed'
  ).length;
}

/** Calculate top-up fee. Returns feeAmount (minor units) and net credited. */
function calcTopupFee(amountMinor, depositCount) {
  const rate = depositCount >= FEES.TOPUP_FREE_LIMIT ? FEES.TOPUP_FEE_RATE : 0;
  const feeAmount = Math.round(amountMinor * rate);
  return {
    feeAmount,
    netCredited: amountMinor - feeAmount,
    rate,
    isFree: rate === 0,
    depositCount,
  };
}

/** Calculate withdrawal fee (local vs international). */
function calcWithdrawFee(amountMinor, isInternational) {
  const rate = isInternational ? FEES.WITHDRAW_INTL_RATE : FEES.WITHDRAW_LOCAL_RATE;
  const feeAmount = Math.round(amountMinor * rate);
  return {
    feeAmount,
    netPayout: amountMinor - feeAmount,
    rate,
    isInternational,
  };
}

/** Calculate FX conversion fee on the converted (received) amount. */
function calcFxFee(receivedAmountMinor) {
  const feeAmount = Math.round(receivedAmountMinor * FEES.FX_RATE);
  return {
    feeAmount,
    netReceived: receivedAmountMinor - feeAmount,
    rate: FEES.FX_RATE,
  };
}

function cleanExpiredIdempotencyKeys() {
  const now = Date.now();
  for (const [key, value] of idempotencyStore.entries()) {
    if (now - value.timestamp > IDEMPOTENCY_EXPIRY) {
      idempotencyStore.delete(key);
    }
  }
}

// Clean expired keys every hour
setInterval(cleanExpiredIdempotencyKeys, 60 * 60 * 1000);

// ==================== SUPPORT API UTILITIES ====================

// Audit log store (in-memory for quick access + persistent logging)
const aiAuditLogs = [];

function logAIInteraction(userId, action, dataAccessed, ticketCreated = null, req = null) {
  const ipAddress = req ? getClientIP(req) : 'system';
  const userAgent = req ? req.headers['user-agent'] || 'unknown' : 'system';
  
  const log = {
    id: uuidv4(),
    userId,
    action,
    dataAccessed,
    ticketCreated,
    timestamp: Date.now(),
    ipAddress,
    userAgent,
    environment: NODE_ENV
  };
  
  // Add to memory (for quick access)
  aiAuditLogs.push(log);
  
  const maxLogs = parseInt(process.env.MAX_AUDIT_LOGS_MEMORY) || 10000;
  if (aiAuditLogs.length > maxLogs) {
    aiAuditLogs.shift();
  }
  
  // Persistent audit logging (Winston)
  if (process.env.ENABLE_AUDIT_LOGS !== 'false') {
    auditLogger.info('AI_INTERACTION', log);
  }
  
  // Console in development
  if (NODE_ENV !== 'production') {
    logger.info('[AI AUDIT]', log);
  }
}

// Get client IP address (handles proxies)
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.connection.remoteAddress || 'unknown';
}

// Data masking utilities
function maskEmail(email) {
  if (!email) return 'unknown';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const maskedLocal = local.length > 2 
    ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1]
    : local[0] + '*';
  return `${maskedLocal}@${domain}`;
}

function maskCardNumber(cardNumber) {
  if (!cardNumber || cardNumber.length < 4) return '****';
  return `****${cardNumber.slice(-4)}`;
}

function sanitizeCard(card) {
  if (!card) return card;
  // Strip full PAN/CVV. New cards never have these fields in the DB;
  // legacy cards in db.json still have them and must be masked here.
  const { cvv, cardNumber, ...rest } = card;
  // Prefer stored last4; fall back to computing it from a legacy cardNumber
  const last4 = rest.last4 || (cardNumber ? cardNumber.slice(-4) : '****');
  return { ...rest, last4, maskedNumber: `****${last4}` };
}

function maskTransactionId(id) {
  if (!id || id.length < 8) return id;
  return id.substring(0, 8) + '...';
}

function maskAmount(amount) {
  // For privacy, show rounded amounts in support context
  return Math.round(amount / 100) * 100;
}

// ==================== FRESHDESK INTEGRATION ====================

async function createFreshdeskTicket(ticket, userData) {
  // If Freshdesk not configured, store locally only
  if (!FRESHDESK_DOMAIN || !FRESHDESK_API_KEY) {
    logger.warn('Freshdesk not configured. Ticket stored locally only.', { ticketId: ticket.id });
    return { local: true, ticketId: ticket.id };
  }
  
  try {
    const freshdeskPriority = {
      'urgent': 4,
      'high': 3,
      'normal': 2,
      'low': 1
    }[ticket.priority] || 2;
    
    const freshdeskPayload = {
      subject: ticket.subject,
      description: ticket.description,
      email: userData.email || 'SUPPORT@EGWALLETFINANCE.COM',
      priority: freshdeskPriority,
      status: 2, // Open
      tags: ticket.tags,
      custom_fields: {
        cf_user_id: ticket.userId,
        cf_escalation_type: ticket.category,
        cf_ai_detected: ticket.escalated ? true : false,
        cf_sentiment: ticket.sentiment,
        cf_sla: ticket.sla,
        cf_local_ticket_id: ticket.id
      },
      group_id: ticket.category === 'fraud_security' ? 1 : undefined // Route to fraud team
    };
    
    const auth = Buffer.from(`${FRESHDESK_API_KEY}:X`).toString('base64');
    
    const response = await axios.post(
      `https://${FRESHDESK_DOMAIN}/api/v2/tickets`,
      freshdeskPayload,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      }
    );
    
    logger.info('Freshdesk ticket created', { 
      localId: ticket.id, 
      freshdeskId: response.data.id 
    });
    
    return {
      success: true,
      freshdeskId: response.data.id,
      localId: ticket.id
    };
    
  } catch (error) {
    logger.error('Freshdesk ticket creation failed', { 
      error: error.message, 
      ticketId: ticket.id 
    });
    
    // Fallback: store locally if Freshdesk fails
    return {
      success: false,
      error: error.message,
      localId: ticket.id,
      fallback: true
    };
  }
}

// ==================== VELOCITY-BASED FRAUD DETECTION ====================

const fraudVelocityTracker = new Map(); // userId -> array of timestamps

function checkFraudVelocity(userId) {
  const now = Date.now();
  const userActivity = fraudVelocityTracker.get(userId) || [];
  
  // Clean old activity (outside time window)
  const recentActivity = userActivity.filter(ts => now - ts < FRAUD_TIME_WINDOW);
  
  // Update tracker
  recentActivity.push(now);
  fraudVelocityTracker.set(userId, recentActivity);
  
  // Check if velocity exceeds threshold
  if (recentActivity.length >= FRAUD_VELOCITY_THRESHOLD) {
    logger.warn('Fraud velocity threshold exceeded', { 
      userId, 
      activityCount: recentActivity.length,
      threshold: FRAUD_VELOCITY_THRESHOLD,
      timeWindow: FRAUD_TIME_WINDOW
    });
    return {
      suspicious: true,
      activityCount: recentActivity.length,
      reason: 'High frequency of fraud-related queries'
    };
  }
  
  return { suspicious: false };
}

// Clean up old velocity data every hour
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of fraudVelocityTracker.entries()) {
    const recent = timestamps.filter(ts => now - ts < FRAUD_TIME_WINDOW);
    if (recent.length === 0) {
      fraudVelocityTracker.delete(userId);
    } else {
      fraudVelocityTracker.set(userId, recent);
    }
  }
}, 3600000); // 1 hour

// Sentiment detection
function detectSentiment(message) {
  const lowerMessage = message.toLowerCase();
  
  const angryKeywords = ['angry', 'furious', 'terrible', 'worst', 'disgusting', 'ridiculous', 'unacceptable', 'awful', 'hate'];
  const threateningKeywords = ['lawyer', 'legal action', 'sue', 'court', 'attorney', 'lawsuit', 'report you', 'regulator', 'complaint to', 'bbb'];
  const urgentKeywords = ['urgent', 'asap', 'immediately', 'emergency', 'critical', 'important'];
  const frustratedKeywords = ['frustrated', 'disappointed', 'upset', 'concerned', 'worried', 'confused'];
  
  let sentiment = 'neutral';
  let urgencyBoost = false;
  
  if (threateningKeywords.some(kw => lowerMessage.includes(kw))) {
    sentiment = 'threatening';
    urgencyBoost = true;
  } else if (angryKeywords.some(kw => lowerMessage.includes(kw))) {
    sentiment = 'angry';
    urgencyBoost = true;
  } else if (urgentKeywords.some(kw => lowerMessage.includes(kw))) {
    sentiment = 'urgent';
    urgencyBoost = true;
  } else if (frustratedKeywords.some(kw => lowerMessage.includes(kw))) {
    sentiment = 'frustrated';
  }
  
  return { sentiment, urgencyBoost };
}

// Escalation detection with sentiment awareness
function detectEscalation(message) {
  const lowerMessage = message.toLowerCase();
  const { sentiment, urgencyBoost } = detectSentiment(message);
  
  // Enhanced fraud keywords with theft-specific language
  const fraudKeywords = ['fraud', 'unauthorized', 'hacked', 'stolen', 'scam', 'chargeback', 'money missing', 'theft', 'someone used my card', 'someone stole', 'money taken', 'didn\'t authorize', 'didn\'t make this', 'not me', 'fraudulent'];
  const accountTakeoverKeywords = ['can\'t login', 'changed password', 'someone accessed', 'suspicious activity', 'i was hacked', 'locked out', 'unknown device', 'strange login'];
  const kycKeywords = ['kyc dispute', 'verification rejected', 'identity theft', 'wrong person'];
  const legalKeywords = ['lawyer', 'legal action', 'sue', 'court', 'attorney', 'lawsuit'];
  
  let category = null;
  let priority = 'normal';
  let sla = '48h';
  let escalate = false;
  let isFraudTheft = false; // New flag for theft scenarios
  
  if (fraudKeywords.some(kw => lowerMessage.includes(kw))) {
    escalate = true;
    category = 'fraud_security';
    priority = 'urgent';
    sla = '12h';
    isFraudTheft = true; // Mark as theft/fraud
  } else if (accountTakeoverKeywords.some(kw => lowerMessage.includes(kw))) {
    escalate = true;
    category = 'account_security';
    priority = 'urgent';
    sla = '12h';
  } else if (kycKeywords.some(kw => lowerMessage.includes(kw))) {
    escalate = true;
    category = 'kyc_dispute';
    priority = 'high';
    sla = '24h';
  } else if (legalKeywords.some(kw => lowerMessage.includes(kw))) {
    escalate = true;
    category = 'legal';
    priority = 'urgent';
    sla = '12h';
  }
  
  // Sentiment-based escalation boost
  if (urgencyBoost && !escalate) {
    escalate = true;
    category = 'general_urgent';
    priority = 'high';
    sla = '24h';
  } else if (urgencyBoost && priority === 'high') {
    priority = 'urgent'; // Upgrade to urgent if already escalating
  }
  
  return { escalate, priority, category, sla, sentiment, isFraudTheft };
}

// Check if message needs structured data collection
function needsStructuredData(message) {
  const lowerMessage = message.toLowerCase();
  
  const transactionIssues = ['unauthorized', 'wrong amount', 'failed', 'declined', 'missing', 'didn\'t receive', 'double charged'];
  const needsTxId = transactionIssues.some(kw => lowerMessage.includes(kw));
  
  return {
    needsTransactionId: needsTxId && !message.match(/[A-Z0-9]{8,}/), // Check if TX ID not provided
    needsAmount: needsTxId && !message.match(/\$?\d+/),
    needsDate: needsTxId && !message.match(/\d{1,2}[\/\-]\d{1,2}|yesterday|today|last week/i)
  };
}

// Get account-aware context for personalized responses
function getUserContext(userId, db) {
  const user = db.users.find(u => u.id === userId);
  const kyc = (db.kyc || []).find(k => k.userId === userId);
  const userCards = (db.virtualCards || []).filter(c => c.userId === userId && c.status === 'active');
  const userTransactions = (db.transactions || []).filter(t => t.userId === userId).slice(-10);

  // Wallet & balance context
  const wallet = (db.wallets || []).find(w => w.userId === userId);
  const walletBalances = wallet?.balances || [];
  const primaryBal = walletBalances[0];
  const failedTxs = userTransactions.filter(t => t.status === 'failed');
  const pendingTxs = userTransactions.filter(t => t.status === 'pending');

  const kycTier = kyc?.status === 'approved' ? 'verified' : (kyc?.status === 'under_review' ? 'pending' : 'unverified');
  const dailyLimit = kycTier === 'verified' ? 50000 : (kycTier === 'pending' ? 5000 : 2000);
  
  // Calculate today's spending
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const todaySpent = userTransactions
    .filter(t => t.timestamp >= todayStart && t.type === 'send')
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  
  return {
    email: maskEmail(user?.email),
    username: user?.username || (user?.email ? user.email.split('@')[0] : 'User'),
    walletId: wallet?.id ? wallet.id.slice(-8).toUpperCase() : 'N/A',
    balance: primaryBal ? minorToMajor(primaryBal.amount, primaryBal.currency).toFixed(decimalsFor(primaryBal.currency)) : '0.00',
    currency: primaryBal?.currency || 'USD',
    kycTier,
    dailyLimit,
    dailySpent: todaySpent,
    dailyRemaining: dailyLimit - todaySpent,
    cardCount: userCards.length,
    recentTxCount: userTransactions.length,
    failedTxCount: failedTxs.length,
    lastFailedReason: failedTxs[0]?.failureReason || null,
    pendingTxCount: pendingTxs.length,
    accountStatus: user?.status || 'active',
    language: user?.language || 'en' // Default to English
  };
}

// ==================== MULTI-LANGUAGE SUPPORT ====================

/**
 * Simple keyword/script-based language detector.
 * Returns a language code if the message contains strong signals,
 * or null if the language cannot be determined.
 */
function detectLanguageFromMessage(message) {
  if (!message || message.length < 3) return null;
  // Unambiguous non-Latin scripts
  if (/[\u4e00-\u9fff]/.test(message)) return 'zh';
  if (/[\u3040-\u30ff]/.test(message)) return 'ja';
  if (/[\u0400-\u04ff]/.test(message)) return 'ru';
  // Latin-script detection via characteristic chars + common words
  const frenchScore = (message.match(/[çàâêèéûùœæ]/gi) || []).length
    + (message.toLowerCase().match(/\b(je|vous|nous|bonjour|merci|comment|votre|pour|dans|avec|mais)\b/g) || []).length;
  const spanishScore = (message.match(/[áéíóúñ¡¿]/g) || []).length
    + (message.toLowerCase().match(/\b(hola|gracias|buenos|como|para|este|muy|también|dónde|cuándo|qué)\b/g) || []).length;
  const portugueseScore = (message.match(/[ãõâêôçáéíóú]/gi) || []).length
    + (message.toLowerCase().match(/\b(olá|obrigado|bom|dia|como|muito|também|onde|quando|você)\b/g) || []).length;
  const germanScore = (message.match(/[äöüß]/gi) || []).length
    + (message.toLowerCase().match(/\b(hallo|danke|bitte|ich|sie|wir|nicht|haben|oder|einen)\b/g) || []).length;
  const scores = { fr: frenchScore, es: spanishScore, pt: portugueseScore, de: germanScore };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return (best && best[1] >= 2) ? best[0] : null;
}

const translations = {
  en: {
    greeting: "Hello! 👋 My name is Felisa, your EGWallet assistant. I can help you with:\n\n- Transaction questions\n- Account information\n- Feature guides\n- Support tickets\n\nWhat can I help you with today?",
    greeting_return: "Hi again! 👋 How can I help you today?",
    escalated_fraud: "I understand this is very important. I've created an URGENT priority ticket ({ticketId}) for our fraud security team.",
    escalated_security: "I understand this is urgent. I've created an URGENT priority ticket ({ticketId}) for our account security team.",
    escalated_legal: "I understand this is very important. I've created an URGENT priority ticket ({ticketId}) for our legal team.",
    escalated_general: "I understand this is important. I've created a HIGH priority ticket ({ticketId}) for our support team.",
    sla_urgent: "⚡ PRIORITY RESPONSE: We will investigate this matter within 12 hours.",
    sla_high: "🔍 HIGH PRIORITY: Our team will respond within 24 hours.",
    sla_normal: "Expected response time: 24-48 hours",
    email_updates: "✓ You'll receive email updates about your ticket",
    track_status: "✓ Track status anytime in the Support section",
    security_email: "🛡 For immediate security assistance, also email: SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 Your Account Limits:\n- Daily limit: ${dailyLimit}\n- Used today: ${dailySpent}\n- Remaining: ${dailyRemaining}",
    get_verified: "💡 Get verified to unlock $50,000+ daily limits!",
    verification_pending: "⏳ Your verification is under review. Higher limits coming soon!",
    data_collection_reason: "To investigate this issue thoroughly, I need a few more details:",
    data_collection_help: "This helps us investigate faster and saves back-and-forth messages.",
    check_ticket: "Check ticket status",
    view_ticket: "View ticket details",
    contact_support: "Contact support",
    provide_details: "Provide details",
    skip_ticket: "Skip and create ticket",
    verified_status: "✓ Your identity is verified!\n\nYou have access to:\n- $50,000+ daily transaction limits\n- Instant withdrawals\n- International transfers\n- Premium features",
    fraud_theft_alert: "I'm really sorry this happened — this could be an unauthorized transaction. I've created an urgent security case now (Ticket #{ticketId}).",
    security_lockdown_title: "🔒 IMMEDIATE SECURITY STEPS:",
    security_step_password: "1. Change your password NOW",
    security_step_2fa: "2. Enable two-factor authentication",
    security_step_logout: "3. Log out of all devices",
    security_step_bank: "4. Contact your bank if you linked a card",
    security_step_otp: "5. NEVER share OTP or verification codes",
    fraud_investigation_help: "To investigate quickly, please answer these questions:",
    fraud_q1: "Which transaction looks unauthorized?",
    fraud_q2: "Approximate date/time?",
    fraud_q3: "Did you lose your phone or receive suspicious OTP prompts?",
    fraud_sla: "🛡 Fraud/Security cases: We respond within 12-24 hours.",
    fraud_ticket_id: "Your security ticket: #{ticketId}",
    transaction_pending_stop: "⚠️ This transaction is PENDING — we may be able to stop it.",
    transaction_completed: "This transaction was completed. We'll investigate for potential reversal.",
    multiple_suspicious: "⚠️ ALERT: Multiple suspicious transactions detected — possible account takeover.",
    tx_latest: "I can help you check your recent transactions. View your transaction history in the app, or I can create a support ticket if you need detailed investigation of a specific transaction.",
    tx_latest_s1: "View transactions", tx_latest_s2: "Report transaction issue", tx_latest_s3: "Check status",
    tx_issue: "For transaction issues, I can help you:\n\n- Check transaction status\n- File a dispute\n- Create a support ticket for investigation\n",
    tx_issue_note: "Note: I cannot process refunds or reversals directly, but our team can investigate within {sla}.",
    tx_issue_s1: "File dispute", tx_issue_s2: "Create ticket", tx_issue_s3: "Transaction history",
    tx_general: "You can view all your transactions in the Transaction History screen. I can help you:\n\n- Understand transaction statuses\n- Download receipts\n- Report issues",
    tx_general_s1: "View transactions", tx_general_s2: "Download receipt", tx_general_s3: "Report issue",
    balance_general: "You can check your balance on the Wallet screen in real-time.",
    balance_incorrect: "If you believe your balance is incorrect, I can create a support ticket for investigation.",
    balance_s1: "View balance", balance_s2: "Report discrepancy", balance_s3: "Add money",
    balance_limit_s1: "Get verified", balance_limit_s2: "View balance", balance_limit_s3: "Learn about limits", balance_limit_s4: "Check verification",
    card_create: "To create a virtual card:\n\n1. Go to the Cards tab\n2. Tap \"Create New Card\"\n3. Set your spending limit\n4. Card is ready instantly!\n\nVirtual cards are free and you can create up to 5 cards.",
    card_create_s1: "Create card", card_create_s2: "Card benefits", card_create_s3: "Card limits",
    card_frozen: "If your card is frozen, you can unfreeze it in the Cards screen. If you suspect fraud, I recommend creating a security ticket.",
    card_frozen_s1: "Create security ticket", card_frozen_s2: "View cards", card_frozen_s3: "Freeze/unfreeze help",
    card_general: "Virtual cards help you:\n\n- Shop online securely\n- Control spending per merchant\n- Cancel anytime without affecting your main wallet\n\nEach card has its own limit for better budgeting.",
    card_general_s1: "Create card", card_general_s2: "View cards", card_general_s3: "Card security",
    kyc_pending_response: "⏳ Your documents are under review.\n\nWe'll notify you within 1-2 business days. Thank you for your patience!\n\nCurrent limit: ${currentLimit}/day",
    kyc_pending_s1: "Check status", kyc_pending_s2: "Upload additional documents", kyc_pending_s3: "Contact support",
    kyc_unverified: "Get verified to unlock higher limits!\n\nBenefits:\n- $50,000+ transaction limits\n- Instant withdrawals\n- International transfers\n",
    kyc_unverified_current: "Currently: ${currentLimit}/day\nAfter verification: $50,000+/day\n\nVerification takes ~5 minutes. You'll need a government-issued ID.",
    kyc_unverified_s1: "Start verification", kyc_unverified_s2: "Required documents", kyc_unverified_s3: "Learn more",
    security_response: "Your security is our priority! EGWallet protects you with:\n\n- Biometric authentication\n- Device tracking\n- End-to-end encryption\n- Transaction confirmations\n- 24/7 fraud monitoring\n\nEnable biometric lock in Settings for extra protection!",
    security_s1: "Enable biometric", security_s2: "Trusted devices", security_s3: "Security tips",
    refund_response: "I understand you need help with this transaction. I can create a support ticket for our payments team to investigate.\n\nPlease note:\n- Investigation timeline: 2-3 business days\n- Refunds depend on transaction type and our policies\n- You'll receive email updates\n\nI cannot process refunds directly, but our team will review your case.",
    refund_s1: "Create ticket", refund_s2: "File dispute", refund_s3: "Contact support",
    help_response: "I'm here to help! You can:\n\n- Ask about features\n- Get transaction info\n- Report issues\n- Create support tickets\n\nOur Help Center has detailed guides, or I can connect you with our support team.",
    help_s1: "Browse FAQs", help_s2: "Create ticket", help_s3: "Feature guides",
    fees_response: "EGWallet fee structure:\n\n✓ Add Money — first 6 top-ups: FREE, then 0.5%\n✓ Send / Receive: FREE\n- FX Conversion: 1.15% (cross-currency sends)\n- Local Withdrawal: 1.28%\n- International Withdrawal: 1.75%\n✓ Virtual Card: FREE\n✓ Monthly subscription: FREE\n\nAll fees are shown before you confirm. No hidden charges.",
    fees_s1: "How is the fee calculated?", fees_s2: "International transfers", fees_s3: "Save on fees",
    dispute_response: "I can help you file a formal dispute or create a support ticket. Our team will:\n\n1. Review your case within 2-3 business days\n2. Contact relevant parties\n3. Investigate thoroughly\n4. Provide regular updates\n\nNote: Investigation timelines vary by case complexity.",
    dispute_s1: "File dispute", dispute_s2: "Create ticket", dispute_s3: "View dispute process",
    default_response: "I can help you with:\n\n- Transaction questions & history\n- Account & balance info\n- Virtual cards\n- Identity verification\n- Security settings\n- Creating support tickets\n\nFor complex issues, I can create a support ticket for our team to investigate.",
    default_s1: "Create ticket", default_s2: "Browse FAQs", default_s3: "View account",
    typing_indicator: "Felisa is typing...",
    init_s1: "Check my transaction", init_s2: "Report a problem", init_s3: "Account limits", init_s4: "How to send money",
    qa_track: "Track Transaction", qa_track_q: "Check my latest transaction status",
    qa_issue: "Report Issue", qa_issue_q: "I want to report a problem",
    qa_card: "Virtual Cards", qa_card_q: "How do I create a virtual card?",
    qa_verify: "Verify Identity", qa_verify_q: "Help me verify my identity",
    limit_daily_reached: "You've reached your daily limit of {limit}. Complete verification to increase your limits.",
    limit_weekly_reached: "You've reached your weekly limit of {limit}. Complete verification to increase your limits.",
    limit_monthly_reached: "You've reached your monthly limit of {limit}. Complete verification to increase your limits.",
    limit_upgrade: "",
    error_user_not_found: "User not found.",
    error_invalid_credentials: "Invalid email or password.",
    error_user_exists: "User already exists.",
    error_username_invalid: "Username must be 3-20 characters (letters, numbers, underscores only).",
    error_username_taken: "Username already taken.",
    error_username_required: "Username is required.",
    error_missing_token: "Missing token.",
    error_invalid_token: "Invalid token.",
    error_invalid_refresh_token: "Invalid or expired refresh token.",
    error_missing_fields: "Missing required fields.",
    error_cannot_send_to_self: "You cannot send money to yourself.",
    error_source_wallet_not_found: "Source wallet not found.",
    error_destination_wallet_not_found: "Destination wallet not found.",
    error_insufficient_funds: "Insufficient funds.",
    error_sender_not_found: "Sender account not found.",
    error_wallet_capacity_exceeded: "Destination wallet would exceed maximum capacity.",
    error_transaction_persist: "Transaction could not be completed. Please try again.",
    error_wallet_not_found: "Wallet not found.",
    error_recipient_not_found: "Recipient not found.",
    error_qr_not_found: "QR code not found.",
    error_qr_expired: "QR code has expired.",
    error_qr_used: "QR code has already been used.",
    error_qr_fraud: "Invalid signature - possible fraud.",
    error_invalid_qr_format: "Invalid QR format.",
    error_request_not_found: "Request not found.",
    error_request_processed: "Request has already been processed.",
    error_card_not_found: "Card not found.",
    error_card_deleted: "This card has been deleted.",
    error_max_cards: "Maximum 5 cards allowed.",
    error_budget_not_found: "Budget not found.",
    error_employer_not_found: "Employer account not found.",
    error_employer_exists: "Employer account already exists.",
    error_employer_not_verified: "Employer account is not verified.",
    error_insufficient_kyc: "Insufficient KYC tier for this operation.",
    error_no_file_uploaded: "No file uploaded.",
    error_csv_empty: "CSV file is empty.",
    error_invalid_csv: "Invalid CSV format.",
    error_insufficient_funds_payroll: "Insufficient funds — no money was sent.",
    error_payroll_validation: "Payroll validation failed — no money was sent.",
    error_employee_added: "Employee already added.",
    error_worker_not_found: "Worker not found. They must register first.",
    error_not_linked_employer: "You are not linked to this employer.",
    error_not_authorized_employer: "Not authorized to receive payments from this employer.",
    error_employer_unverified: "This employer account has not been verified yet.",
    error_employer_insufficient_balance: "Employer has insufficient balance for this request.",
    error_request_exceeds_limit: "Request amount exceeds your limit of {limit} {currency}.",
    error_duplicate_request: "Duplicate request. You already have a pending request for this amount.",
    error_internal: "An unexpected error occurred. Please try again.",
    error_unauthorized: "Unauthorized.",
    error_access_denied: "Access denied.",
    error_currency_required: "Currency preference is required.",
    error_too_many_accounts: "Too many accounts created from this device. Please try again in 24 hours.",
    error_too_many_kyc: "Too many verification attempts. Please try again in 1 hour.",
    error_email_confirm_mismatch: "Email confirmation does not match.",
    error_password_confirm_invalid: "Password confirmation is invalid.",
    error_not_found: "Not found.",
    error_withdrawal_in_progress: "A withdrawal for this currency is already being processed. Please wait."
  },
  es: {
    greeting: "¡Hola! 👋 Me llamo Felisa, tu asistente de EGWallet. Puedo ayudarte con:\n\n- Preguntas sobre transacciones\n- Información de cuenta\n- Guías de funciones\n- Tickets de soporte\n\n¿En qué puedo ayudarte hoy?",
    greeting_return: "¡Hola de nuevo! 👋 ¿En qué puedo ayudarte hoy?",
    escalated_fraud: "Entiendo que esto es muy importante. He creado un ticket de prioridad URGENTE ({ticketId}) para nuestro equipo de seguridad contra fraudes.",
    escalated_security: "Entiendo que esto es urgente. He creado un ticket de prioridad URGENTE ({ticketId}) para nuestro equipo de seguridad de cuentas.",
    escalated_legal: "Entiendo que esto es muy importante. He creado un ticket de prioridad URGENTE ({ticketId}) para nuestro equipo legal.",
    escalated_general: "Entiendo que esto es importante. He creado un ticket de prioridad ALTA ({ticketId}) para nuestro equipo de soporte.",
    sla_urgent: "⚡ RESPUESTA PRIORITARIA: Investigaremos este asunto en 12 horas.",
    sla_high: "🔍 ALTA PRIORIDAD: Nuestro equipo responderá en 24 horas.",
    sla_normal: "Tiempo de respuesta esperado: 24-48 horas",
    email_updates: "✓ Recibirás actualizaciones por correo sobre tu ticket",
    track_status: "✓ Rastrea el estado en cualquier momento en la sección de Soporte",
    security_email: "🛡 Para asistencia de seguridad inmediata, también envía correo a: SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 Límites de tu Cuenta:\n- Límite diario: ${dailyLimit}\n- Usado hoy: ${dailySpent}\n- Restante: ${dailyRemaining}",
    get_verified: "💡 ¡Verifica tu cuenta para desbloquear límites diarios de $50,000+!",
    verification_pending: "⏳ Tu verificación está en revisión. ¡Límites más altos próximamente!",
    data_collection_reason: "Para investigar este problema a fondo, necesito algunos detalles más:",
    data_collection_help: "Esto nos ayuda a investigar más rápido y ahorra mensajes de ida y vuelta.",
    check_ticket: "Verificar estado del ticket",
    view_ticket: "Ver detalles del ticket",
    contact_support: "Contactar soporte",
    provide_details: "Proporcionar detalles",
    skip_ticket: "Omitir y crear ticket",
    verified_status: "✓ ¡Tu identidad está verificada!\n\nTienes acceso a:\n- Límites de transacción diarios de $50,000+\n- Retiros instantáneos\n- Transferencias internacionales\n- Funciones premium",
    fraud_theft_alert: "Lamento mucho que esto haya sucedido — esto podría ser una transacción no autorizada. He creado un caso de seguridad urgente ahora (Ticket #{ticketId}).",
    security_lockdown_title: "🔒 PASOS DE SEGURIDAD INMEDIATOS:",
    security_step_password: "1. Cambia tu contraseña AHORA",
    security_step_2fa: "2. Activa la autenticación de dos factores",
    security_step_logout: "3. Cierra sesión en todos los dispositivos",
    security_step_bank: "4. Contacta a tu banco si vinculaste una tarjeta",
    security_step_otp: "5. NUNCA compartas códigos OTP o de verificación",
    fraud_investigation_help: "Para investigar rápidamente, responde estas preguntas:",
    fraud_q1: "¿Qué transacción parece no autorizada?",
    fraud_q2: "¿Fecha/hora aproximada?",
    fraud_q3: "¿Perdiste tu teléfono o recibiste solicitudes de OTP sospechosas?",
    fraud_sla: "🛡 Casos de fraude/seguridad: Respondemos en 12-24 horas.",
    fraud_ticket_id: "Tu ticket de seguridad: #{ticketId}",
    transaction_pending_stop: "⚠️ Esta transacción está PENDIENTE — es posible que podamos detenerla.",
    transaction_completed: "Esta transacción se completó. Investigaremos para una posible reversión.",
    multiple_suspicious: "⚠️ ALERTA: Múltiples transacciones sospechosas detectadas — posible toma de control de cuenta.",
    tx_latest: "Puedo ayudarte a revisar tus transacciones recientes. Consulta el historial de transacciones en la app, o puedo crear un ticket de soporte si necesitas una investigación detallada de una transacción específica.",
    tx_latest_s1: "Ver transacciones", tx_latest_s2: "Reportar problema de transacción", tx_latest_s3: "Verificar estado",
    tx_issue: "Para problemas con transacciones, puedo ayudarte con:\n\n- Verificar el estado de la transacción\n- Presentar una disputa\n- Crear un ticket de soporte para investigación\n",
    tx_issue_note: "Nota: No puedo procesar reembolsos ni reversiones directamente, pero nuestro equipo puede investigar en {sla}.",
    tx_issue_s1: "Presentar disputa", tx_issue_s2: "Crear ticket", tx_issue_s3: "Historial de transacciones",
    tx_general: "Puedes ver todas tus transacciones en la pantalla de Historial de Transacciones. Puedo ayudarte con:\n\n- Entender los estados de las transacciones\n- Descargar recibos\n- Reportar problemas",
    tx_general_s1: "Ver transacciones", tx_general_s2: "Descargar recibo", tx_general_s3: "Reportar problema",
    balance_general: "Puedes verificar tu saldo en la pantalla de Billetera en tiempo real.",
    balance_incorrect: "Si crees que tu saldo es incorrecto, puedo crear un ticket de soporte para investigación.",
    balance_s1: "Ver saldo", balance_s2: "Reportar discrepancia", balance_s3: "Agregar dinero",
    balance_limit_s1: "Verificarme", balance_limit_s2: "Ver saldo", balance_limit_s3: "Conocer los límites", balance_limit_s4: "Verificar estado",
    card_create: "Para crear una tarjeta virtual:\n\n1. Ve a la pestaña de Tarjetas\n2. Toca \"Crear Nueva Tarjeta\"\n3. Establece tu límite de gasto\n4. ¡La tarjeta estará lista al instante!\n\nLas tarjetas virtuales son gratuitas y puedes crear hasta 5 tarjetas.",
    card_create_s1: "Crear tarjeta", card_create_s2: "Beneficios de la tarjeta", card_create_s3: "Límites de la tarjeta",
    card_frozen: "Si tu tarjeta está congelada, puedes descongelarla en la pantalla de Tarjetas. Si sospechas fraude, te recomiendo crear un ticket de seguridad.",
    card_frozen_s1: "Crear ticket de seguridad", card_frozen_s2: "Ver tarjetas", card_frozen_s3: "Ayuda para congelar/descongelar",
    card_general: "Las tarjetas virtuales te ayudan a:\n\n- Comprar en línea de forma segura\n- Controlar el gasto por comerciante\n- Cancelar en cualquier momento sin afectar tu billetera principal\n\nCada tarjeta tiene su propio límite para un mejor presupuesto.",
    card_general_s1: "Crear tarjeta", card_general_s2: "Ver tarjetas", card_general_s3: "Seguridad de la tarjeta",
    kyc_pending_response: "⏳ Tus documentos están siendo revisados.\n\nTe notificaremos en 1-2 días hábiles. ¡Gracias por tu paciencia!\n\nLímite actual: ${currentLimit}/día",
    kyc_pending_s1: "Verificar estado", kyc_pending_s2: "Subir documentos adicionales", kyc_pending_s3: "Contactar soporte",
    kyc_unverified: "¡Verifica tu identidad para desbloquear límites más altos!\n\nBeneficios:\n- Límites de transacción de $50,000+\n- Retiros instantáneos\n- Transferencias internacionales\n",
    kyc_unverified_current: "Actualmente: ${currentLimit}/día\nTras la verificación: $50,000+/día\n\nLa verificación tarda ~5 minutos. Necesitarás un documento de identidad oficial.",
    kyc_unverified_s1: "Iniciar verificación", kyc_unverified_s2: "Documentos requeridos", kyc_unverified_s3: "Saber más",
    security_response: "¡Tu seguridad es nuestra prioridad! EGWallet te protege con:\n\n- Autenticación biométrica\n- Rastreo de dispositivos\n- Cifrado de extremo a extremo\n- Confirmaciones de transacciones\n- Monitoreo de fraude 24/7\n\n¡Activa el bloqueo biométrico en Configuración para mayor protección!",
    security_s1: "Activar biométrico", security_s2: "Dispositivos de confianza", security_s3: "Consejos de seguridad",
    refund_response: "Entiendo que necesitas ayuda con esta transacción. Puedo crear un ticket de soporte para que nuestro equipo de pagos lo investigue.\n\nTen en cuenta:\n- Tiempo de investigación: 2-3 días hábiles\n- Los reembolsos dependen del tipo de transacción y nuestras políticas\n- Recibirás actualizaciones por correo\n\nNo puedo procesar reembolsos directamente, pero nuestro equipo revisará tu caso.",
    refund_s1: "Crear ticket", refund_s2: "Presentar disputa", refund_s3: "Contactar soporte",
    help_response: "¡Estoy aquí para ayudarte! Puedes:\n\n- Preguntar sobre funciones\n- Obtener información de transacciones\n- Reportar problemas\n- Crear tickets de soporte\n\nNuestro Centro de Ayuda tiene guías detalladas, o puedo conectarte con nuestro equipo de soporte.",
    help_s1: "Ver preguntas frecuentes", help_s2: "Crear ticket", help_s3: "Guías de funciones",
    fees_response: "Estructura de tarifas de EGWallet:\n\n✓ Agregar dinero — primeras 6 recargas: GRATIS, luego 0.5%\n✓ Enviar / Recibir: GRATIS\n- Conversión de divisas: 1.15% (envíos entre monedas)\n- Retiro local: 1.28%\n- Retiro internacional: 1.75%\n✓ Tarjeta virtual: GRATIS\n✓ Suscripción mensual: GRATIS\n\nTodas las tarifas se muestran antes de confirmar. Sin cargos ocultos.",
    fees_s1: "¿Cómo se calcula la tarifa?", fees_s2: "Transferencias internacionales", fees_s3: "Ahorrar en tarifas",
    dispute_response: "Puedo ayudarte a presentar una disputa formal o crear un ticket de soporte. Nuestro equipo:\n\n1. Revisará tu caso en 2-3 días hábiles\n2. Contactará a las partes relevantes\n3. Investigará a fondo\n4. Proporcionará actualizaciones regulares\n\nNota: Los plazos de investigación varían según la complejidad del caso.",
    dispute_s1: "Presentar disputa", dispute_s2: "Crear ticket", dispute_s3: "Ver proceso de disputa",
    default_response: "Puedo ayudarte con:\n\n- Preguntas sobre transacciones e historial\n- Información de cuenta y saldo\n- Tarjetas virtuales\n- Verificación de identidad\n- Configuración de seguridad\n- Creación de tickets de soporte\n\nPara problemas complejos, puedo crear un ticket de soporte para que nuestro equipo lo investigue.",
    default_s1: "Crear ticket", default_s2: "Ver preguntas frecuentes", default_s3: "Ver cuenta",
    typing_indicator: "Felisa está escribiendo...",
    init_s1: "Revisar mi transacción", init_s2: "Reportar un problema", init_s3: "Límites de cuenta", init_s4: "Cómo enviar dinero",
    qa_track: "Rastrear Transacción", qa_track_q: "Verificar el estado de mi última transacción",
    qa_issue: "Reportar Problema", qa_issue_q: "Quiero reportar un problema",
    qa_card: "Tarjetas Virtuales", qa_card_q: "¿Cómo creo una tarjeta virtual?",
    qa_verify: "Verificar Identidad", qa_verify_q: "Ayúdame a verificar mi identidad",
    limit_daily_reached: "Has alcanzado tu límite diario de {limit}. Completa tu verificación para aumentar tus límites.",
    limit_weekly_reached: "Has alcanzado tu límite semanal de {limit}. Completa tu verificación para aumentar tus límites.",
    limit_monthly_reached: "Has alcanzado tu límite mensual de {limit}. Completa tu verificación para aumentar tus límites.",
    limit_upgrade: "",
    error_user_not_found: "Usuario no encontrado.",
    error_invalid_credentials: "Correo o contraseña incorrectos.",
    error_user_exists: "El usuario ya existe.",
    error_username_invalid: "El nombre de usuario debe tener entre 3 y 20 caracteres (letras, números y guiones bajos).",
    error_username_taken: "El nombre de usuario ya está en uso.",
    error_username_required: "El nombre de usuario es obligatorio.",
    error_missing_token: "Token faltante.",
    error_invalid_token: "Token inválido.",
    error_invalid_refresh_token: "Token de actualización inválido o expirado.",
    error_missing_fields: "Faltan campos requeridos.",
    error_cannot_send_to_self: "No puedes enviarte dinero a ti mismo.",
    error_source_wallet_not_found: "Billetera de origen no encontrada.",
    error_destination_wallet_not_found: "Billetera de destino no encontrada.",
    error_insufficient_funds: "Fondos insuficientes.",
    error_sender_not_found: "Cuenta del remitente no encontrada.",
    error_wallet_capacity_exceeded: "La billetera de destino superaría la capacidad máxima.",
    error_transaction_persist: "La transacción no pudo completarse. Por favor intenta de nuevo.",
    error_wallet_not_found: "Billetera no encontrada.",
    error_recipient_not_found: "Destinatario no encontrado.",
    error_qr_not_found: "Código QR no encontrado.",
    error_qr_expired: "El código QR ha expirado.",
    error_qr_used: "El código QR ya fue utilizado.",
    error_qr_fraud: "Firma inválida - posible fraude.",
    error_invalid_qr_format: "Formato QR inválido.",
    error_request_not_found: "Solicitud no encontrada.",
    error_request_processed: "La solicitud ya fue procesada.",
    error_card_not_found: "Tarjeta no encontrada.",
    error_card_deleted: "Esta tarjeta ha sido eliminada.",
    error_max_cards: "Se permiten un máximo de 5 tarjetas.",
    error_budget_not_found: "Presupuesto no encontrado.",
    error_employer_not_found: "Cuenta de empleador no encontrada.",
    error_employer_exists: "La cuenta de empleador ya existe.",
    error_employer_not_verified: "La cuenta de empleador no está verificada.",
    error_insufficient_kyc: "Nivel KYC insuficiente para esta operación.",
    error_no_file_uploaded: "No se subió ningún archivo.",
    error_csv_empty: "El archivo CSV está vacío.",
    error_invalid_csv: "Formato CSV inválido.",
    error_insufficient_funds_payroll: "Fondos insuficientes — no se envió dinero.",
    error_payroll_validation: "Error de validación de nómina — no se envió dinero.",
    error_employee_added: "Empleado ya agregado.",
    error_worker_not_found: "Trabajador no encontrado. Primero debe registrarse.",
    error_not_linked_employer: "No estás vinculado a este empleador.",
    error_not_authorized_employer: "No estás autorizado a recibir pagos de este empleador.",
    error_employer_unverified: "Esta cuenta de empleador aún no ha sido verificada.",
    error_employer_insufficient_balance: "El empleador no tiene saldo suficiente para esta solicitud.",
    error_request_exceeds_limit: "El monto de la solicitud supera tu límite de {limit} {currency}.",
    error_duplicate_request: "Solicitud duplicada. Ya tienes una solicitud pendiente por este monto.",
    error_internal: "Ocurrió un error inesperado. Por favor intenta de nuevo.",
    error_unauthorized: "No autorizado.",
    error_access_denied: "Acceso denegado.",
    error_currency_required: "La preferencia de moneda es obligatoria.",
    error_too_many_accounts: "Demasiadas cuentas creadas desde este dispositivo. Por favor intenta en 24 horas.",
    error_too_many_kyc: "Demasiados intentos de verificación. Por favor intenta en 1 hora.",
    error_email_confirm_mismatch: "La confirmación del correo no coincide.",
    error_password_confirm_invalid: "La confirmación de contraseña es inválida.",
    error_not_found: "No encontrado.",
    error_withdrawal_in_progress: "Ya hay un retiro en proceso para esta moneda. Por favor espera."
  },
  fr: {
    greeting: "Bonjour ! 👋 Je m'appelle Felisa, votre assistante EGWallet. Je peux vous aider avec :\n\n- Questions sur les transactions\n- Informations sur le compte\n- Guides des fonctionnalités\n- Tickets de support\n\nComment puis-je vous aider aujourd'hui ?",
    greeting_return: "Bonjour de nouveau ! 👋 Comment puis-je vous aider aujourd'hui ?",
    escalated_fraud: "Je comprends que c'est très important. J'ai créé un ticket de priorité URGENT ({ticketId}) pour notre équipe de sécurité contre la fraude.",
    escalated_security: "Je comprends que c'est urgent. J'ai créé un ticket de priorité URGENT ({ticketId}) pour notre équipe de sécurité des comptes.",
    escalated_legal: "Je comprends que c'est très important. J'ai créé un ticket de priorité URGENT ({ticketId}) pour notre équipe juridique.",
    escalated_general: "Je comprends que c'est important. J'ai créé un ticket de priorité HAUTE ({ticketId}) pour notre équipe de support.",
    sla_urgent: "⚡ RÉPONSE PRIORITAIRE : Nous enquêterons sur cette affaire dans les 12 heures.",
    sla_high: "🔍 HAUTE PRIORITÉ : Notre équipe répondra dans les 24 heures.",
    sla_normal: "Temps de réponse attendu : 24-48 heures",
    email_updates: "✓ Vous recevrez des mises à jour par e-mail sur votre ticket",
    track_status: "✓ Suivez l'état à tout moment dans la section Support",
    security_email: "🛡 Pour une assistance de sécurité immédiate, envoyez également un e-mail à : SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 Limites de votre compte :\n- Limite quotidienne : ${dailyLimit}\n- Utilisé aujourd'hui : ${dailySpent}\n- Restant : ${dailyRemaining}",
    get_verified: "💡 Vérifiez-vous pour débloquer des limites quotidiennes de $50,000+ !",
    verification_pending: "⏳ Votre vérification est en cours de révision. Des limites plus élevées bientôt !",
    data_collection_reason: "Pour enquêter sur ce problème en profondeur, j'ai besoin de quelques détails supplémentaires :",
    data_collection_help: "Cela nous aide à enquêter plus rapidement et évite les messages aller-retour.",
    check_ticket: "Vérifier l'état du ticket",
    view_ticket: "Voir les détails du ticket",
    contact_support: "Contacter le support",
    provide_details: "Fournir les détails",
    skip_ticket: "Passer et créer un ticket",
    verified_status: "✓ Votre identité est vérifiée !\n\nVous avez accès à :\n- Limites de transaction quotidiennes de $50,000+\n- Retraits instantanés\n- Virements internationaux\n- Fonctionnalités premium",
    fraud_theft_alert: "Je suis vraiment désolé que cela se soit produit — il pourrait s'agir d'une transaction non autorisée. J'ai créé un cas de sécurité urgent maintenant (Ticket #{ticketId}).",
    security_lockdown_title: "🔒 ÉTAPES DE SÉCURITÉ IMMÉDIATES :",
    security_step_password: "1. Changez votre mot de passe MAINTENANT",
    security_step_2fa: "2. Activez l'authentification à deux facteurs",
    security_step_logout: "3. Déconnectez-vous de tous les appareils",
    security_step_bank: "4. Contactez votre banque si vous avez lié une carte",
    security_step_otp: "5. NE JAMAIS partager les codes OTP ou de vérification",
    fraud_investigation_help: "Pour enquêter rapidement, veuillez répondre à ces questions :",
    fraud_q1: "Quelle transaction semble non autorisée ?",
    fraud_q2: "Date/heure approximative ?",
    fraud_q3: "Avez-vous perdu votre téléphone ou reçu des invites OTP suspectes ?",
    fraud_sla: "🛡 Cas de fraude/sécurité : Nous répondons dans les 12-24 heures.",
    fraud_ticket_id: "Votre ticket de sécurité : #{ticketId}",
    transaction_pending_stop: "⚠️ Cette transaction est EN ATTENTE — nous pourrions l'arrêter.",
    transaction_completed: "Cette transaction a été complétée. Nous enquêterons pour un éventuel renversement.",
    multiple_suspicious: "⚠️ ALERTE : Plusieurs transactions suspectes détectées — prise de contrôle de compte possible.",
    tx_latest: "Je peux vous aider à consulter vos transactions récentes. Consultez l'historique des transactions dans l'application, ou je peux créer un ticket de support si vous avez besoin d'une investigation détaillée.",
    tx_latest_s1: "Voir les transactions", tx_latest_s2: "Signaler un problème de transaction", tx_latest_s3: "Vérifier le statut",
    tx_issue: "Pour les problèmes de transactions, je peux vous aider à :\n\n- Vérifier le statut de la transaction\n- Déposer une contestation\n- Créer un ticket de support pour investigation\n",
    tx_issue_note: "Remarque : Je ne peux pas traiter les remboursements directement, mais notre équipe peut enquêter dans {sla}.",
    tx_issue_s1: "Déposer une contestation", tx_issue_s2: "Créer un ticket", tx_issue_s3: "Historique des transactions",
    tx_general: "Vous pouvez voir toutes vos transactions dans l'écran Historique des transactions. Je peux vous aider à :\n\n- Comprendre les statuts des transactions\n- Télécharger les reçus\n- Signaler des problèmes",
    tx_general_s1: "Voir les transactions", tx_general_s2: "Télécharger le reçu", tx_general_s3: "Signaler un problème",
    balance_general: "Vous pouvez vérifier votre solde sur l'écran Portefeuille en temps réel.",
    balance_incorrect: "Si vous pensez que votre solde est incorrect, je peux créer un ticket de support pour investigation.",
    balance_s1: "Voir le solde", balance_s2: "Signaler une divergence", balance_s3: "Ajouter de l'argent",
    balance_limit_s1: "Se faire vérifier", balance_limit_s2: "Voir le solde", balance_limit_s3: "En savoir plus sur les limites", balance_limit_s4: "Vérifier le statut",
    card_create: "Pour créer une carte virtuelle :\n\n1. Allez dans l'onglet Cartes\n2. Appuyez sur \"Créer une nouvelle carte\"\n3. Définissez votre limite de dépenses\n4. La carte est prête instantanément !\n\nLes cartes virtuelles sont gratuites, vous pouvez en créer jusqu'à 5.",
    card_create_s1: "Créer une carte", card_create_s2: "Avantages de la carte", card_create_s3: "Limites de la carte",
    card_frozen: "Si votre carte est gelée, vous pouvez la dégeler dans l'écran Cartes. Si vous suspectez une fraude, je recommande de créer un ticket de sécurité.",
    card_frozen_s1: "Créer un ticket de sécurité", card_frozen_s2: "Voir les cartes", card_frozen_s3: "Aide pour geler/dégeler",
    card_general: "Les cartes virtuelles vous aident à :\n\n- Faire des achats en ligne en toute sécurité\n- Contrôler les dépenses par marchand\n- Annuler à tout moment sans affecter votre portefeuille\n\nChaque carte a sa propre limite pour un meilleur budget.",
    card_general_s1: "Créer une carte", card_general_s2: "Voir les cartes", card_general_s3: "Sécurité des cartes",
    kyc_pending_response: "⏳ Vos documents sont en cours d'examen.\n\nNous vous notifierons dans 1-2 jours ouvrables. Merci de votre patience !\n\nLimite actuelle : ${currentLimit}/jour",
    kyc_pending_s1: "Vérifier le statut", kyc_pending_s2: "Télécharger des documents supplémentaires", kyc_pending_s3: "Contacter le support",
    kyc_unverified: "Faites vérifier votre identité pour débloquer des limites plus élevées !\n\nAvantages :\n- Limites de transaction de 50 000 $+\n- Retraits instantanés\n- Transferts internationaux\n",
    kyc_unverified_current: "Actuellement : ${currentLimit}/jour\nAprès vérification : 50 000 $+/jour\n\nLa vérification prend ~5 minutes. Vous aurez besoin d'une pièce d'identité officielle.",
    kyc_unverified_s1: "Commencer la vérification", kyc_unverified_s2: "Documents requis", kyc_unverified_s3: "En savoir plus",
    security_response: "Votre sécurité est notre priorité ! EGWallet vous protège avec :\n\n- Authentification biométrique\n- Suivi des appareils\n- Chiffrement de bout en bout\n- Confirmations de transactions\n- Surveillance des fraudes 24/7\n\nActivez le verrouillage biométrique dans Paramètres pour une protection supplémentaire !",
    security_s1: "Activer la biométrie", security_s2: "Appareils de confiance", security_s3: "Conseils de sécurité",
    refund_response: "Je comprends que vous avez besoin d'aide avec cette transaction. Je peux créer un ticket de support pour que notre équipe de paiements l'examine.\n\nVeuillez noter :\n- Délai d'enquête : 2-3 jours ouvrables\n- Les remboursements dépendent du type de transaction et de nos politiques\n- Vous recevrez des mises à jour par e-mail\n\nJe ne peux pas traiter les remboursements directement, mais notre équipe examinera votre cas.",
    refund_s1: "Créer un ticket", refund_s2: "Déposer une contestation", refund_s3: "Contacter le support",
    help_response: "Je suis là pour vous aider ! Vous pouvez :\n\n- Poser des questions sur les fonctionnalités\n- Obtenir des informations sur les transactions\n- Signaler des problèmes\n- Créer des tickets de support\n\nNotre Centre d'aide dispose de guides détaillés, ou je peux vous connecter avec notre équipe.",
    help_s1: "Parcourir les FAQs", help_s2: "Créer un ticket", help_s3: "Guides des fonctionnalités",
    fees_response: "Structure des frais EGWallet :\n\n✓ Ajouter de l'argent — 6 premiers rechargements : GRATUITS, puis 0,5%\n✓ Envoyer / Recevoir : GRATUIT\n- Conversion de devises : 1,15% (envois entre devises)\n- Retrait local : 1,28%\n- Retrait international : 1,75%\n✓ Carte virtuelle : GRATUITE\n✓ Abonnement mensuel : GRATUIT\n\nTous les frais sont affichés avant confirmation. Aucun frais caché.",
    fees_s1: "Comment les frais sont-ils calculés ?", fees_s2: "Transferts internationaux", fees_s3: "Économiser sur les frais",
    dispute_response: "Je peux vous aider à déposer une contestation formelle ou créer un ticket de support. Notre équipe va :\n\n1. Examiner votre dossier dans 2-3 jours ouvrables\n2. Contacter les parties concernées\n3. Enquêter en profondeur\n4. Fournir des mises à jour régulières\n\nRemarque : Les délais d'investigation varient selon la complexité du dossier.",
    dispute_s1: "Déposer une contestation", dispute_s2: "Créer un ticket", dispute_s3: "Voir le processus de contestation",
    default_response: "Je peux vous aider avec :\n\n- Questions sur les transactions et l'historique\n- Informations sur le compte et le solde\n- Cartes virtuelles\n- Vérification d'identité\n- Paramètres de sécurité\n- Création de tickets de support\n\nPour les problèmes complexes, je peux créer un ticket de support pour que notre équipe enquête.",
    default_s1: "Créer un ticket", default_s2: "Parcourir les FAQs", default_s3: "Voir le compte",
    typing_indicator: "Felisa est en train d'écrire...",
    init_s1: "Vérifier ma transaction", init_s2: "Signaler un problème", init_s3: "Limites du compte", init_s4: "Comment envoyer de l'argent",
    qa_track: "Suivre Transaction", qa_track_q: "Vérifier le statut de ma dernière transaction",
    qa_issue: "Signaler Problème", qa_issue_q: "Je veux signaler un problème",
    qa_card: "Cartes Virtuelles", qa_card_q: "Comment créer une carte virtuelle ?",
    qa_verify: "Vérifier Identité", qa_verify_q: "Aidez-moi à vérifier mon identité",
    limit_daily_reached: "Vous avez atteint votre plafond journalier de {limit}. Finalisez votre vérification pour augmenter vos limites.",
    limit_weekly_reached: "Vous avez atteint votre plafond hebdomadaire de {limit}. Finalisez votre vérification pour augmenter vos limites.",
    limit_monthly_reached: "Vous avez atteint votre plafond mensuel de {limit}. Finalisez votre vérification pour augmenter vos limites.",
    limit_upgrade: "",
    error_user_not_found: "Utilisateur introuvable.",
    error_invalid_credentials: "Email ou mot de passe incorrect.",
    error_user_exists: "Cet utilisateur existe déjà.",
    error_username_invalid: "Le nom d'utilisateur doit comporter entre 3 et 20 caractères (lettres, chiffres, tirets bas uniquement).",
    error_username_taken: "Ce nom d'utilisateur est déjà pris.",
    error_username_required: "Le nom d'utilisateur est obligatoire.",
    error_missing_token: "Jeton manquant.",
    error_invalid_token: "Jeton invalide.",
    error_invalid_refresh_token: "Jeton de rafraîchissement invalide ou expiré.",
    error_missing_fields: "Champs obligatoires manquants.",
    error_cannot_send_to_self: "Vous ne pouvez pas vous envoyer de l'argent à vous-même.",
    error_source_wallet_not_found: "Portefeuille source introuvable.",
    error_destination_wallet_not_found: "Portefeuille de destination introuvable.",
    error_insufficient_funds: "Fonds insuffisants.",
    error_sender_not_found: "Compte de l'expéditeur introuvable.",
    error_wallet_capacity_exceeded: "Le portefeuille de destination dépasserait la capacité maximale.",
    error_transaction_persist: "La transaction n'a pas pu être complétée. Veuillez réessayer.",
    error_wallet_not_found: "Portefeuille introuvable.",
    error_recipient_not_found: "Destinataire introuvable.",
    error_qr_not_found: "Code QR introuvable.",
    error_qr_expired: "Le code QR a expiré.",
    error_qr_used: "Le code QR a déjà été utilisé.",
    error_qr_fraud: "Signature invalide - fraude possible.",
    error_invalid_qr_format: "Format QR invalide.",
    error_request_not_found: "Demande introuvable.",
    error_request_processed: "La demande a déjà été traitée.",
    error_card_not_found: "Carte introuvable.",
    error_card_deleted: "Cette carte a été supprimée.",
    error_max_cards: "Maximum 5 cartes autorisées.",
    error_budget_not_found: "Budget introuvable.",
    error_employer_not_found: "Compte employeur introuvable.",
    error_employer_exists: "Le compte employeur existe déjà.",
    error_employer_not_verified: "Le compte employeur n'est pas vérifié.",
    error_insufficient_kyc: "Niveau KYC insuffisant pour cette opération.",
    error_no_file_uploaded: "Aucun fichier téléchargé.",
    error_csv_empty: "Le fichier CSV est vide.",
    error_invalid_csv: "Format CSV invalide.",
    error_insufficient_funds_payroll: "Fonds insuffisants — aucun argent n'a été envoyé.",
    error_payroll_validation: "Échec de la validation de la paie — aucun argent n'a été envoyé.",
    error_employee_added: "Employé déjà ajouté.",
    error_worker_not_found: "Travailleur introuvable. Il doit d'abord s'inscrire.",
    error_not_linked_employer: "Vous n'êtes pas lié à cet employeur.",
    error_not_authorized_employer: "Non autorisé à recevoir des paiements de cet employeur.",
    error_employer_unverified: "Ce compte employeur n'a pas encore été vérifié.",
    error_employer_insufficient_balance: "L'employeur n'a pas assez de solde pour cette demande.",
    error_request_exceeds_limit: "Le montant de la demande dépasse votre limite de {limit} {currency}.",
    error_duplicate_request: "Demande dupliquée. Vous avez déjà une demande en attente pour ce montant.",
    error_internal: "Une erreur inattendue s'est produite. Veuillez réessayer.",
    error_unauthorized: "Non autorisé.",
    error_access_denied: "Accès refusé.",
    error_currency_required: "La préférence de devise est obligatoire.",
    error_too_many_accounts: "Trop de comptes créés depuis cet appareil. Veuillez réessayer dans 24 heures.",
    error_too_many_kyc: "Trop de tentatives de vérification. Veuillez réessayer dans 1 heure.",
    error_email_confirm_mismatch: "La confirmation d'email ne correspond pas.",
    error_password_confirm_invalid: "La confirmation du mot de passe est invalide.",
    error_not_found: "Introuvable.",
    error_withdrawal_in_progress: "Un retrait dans cette devise est déjà en cours. Veuillez patienter."
  },
  pt: {
    greeting: "Olá! 👋 Meu nome é Felisa, sua assistente da EGWallet. Posso ajudá-lo com:\n\n- Perguntas sobre transações\n- Informações da conta\n- Guias de recursos\n- Tickets de suporte\n\nComo posso ajudá-lo hoje?",
    greeting_return: "Olá de novo! 👋 Como posso ajudá-lo hoje?",
    escalated_fraud: "Entendo que isso é muito importante. Criei um ticket de prioridade URGENTE ({ticketId}) para nossa equipe de segurança contra fraudes.",
    escalated_security: "Entendo que isso é urgente. Criei um ticket de prioridade URGENTE ({ticketId}) para nossa equipe de segurança de contas.",
    escalated_legal: "Entendo que isso é muito importante. Criei um ticket de prioridade URGENTE ({ticketId}) para nossa equipe jurídica.",
    escalated_general: "Entendo que isso é importante. Criei um ticket de prioridade ALTA ({ticketId}) para nossa equipe de suporte.",
    sla_urgent: "⚡ RESPOSTA PRIORITÁRIA: Investigaremos este assunto em 12 horas.",
    sla_high: "🔍 ALTA PRIORIDADE: Nossa equipe responderá em 24 horas.",
    sla_normal: "Tempo de resposta esperado: 24-48 horas",
    email_updates: "✓ Você receberá atualizações por e-mail sobre seu ticket",
    track_status: "✓ Acompanhe o status a qualquer momento na seção de Suporte",
    security_email: "🛡 Para assistência de segurança imediata, envie também um e-mail para: SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 Limites da sua Conta:\n- Limite diário: ${dailyLimit}\n- Usado hoje: ${dailySpent}\n- Restante: ${dailyRemaining}",
    get_verified: "💡 Verifique-se para desbloquear limites diários de $50,000+!",
    verification_pending: "⏳ Sua verificação está em revisão. Limites mais altos em breve!",
    data_collection_reason: "Para investigar este problema minuciosamente, preciso de mais alguns detalhes:",
    data_collection_help: "Isso nos ajuda a investigar mais rápido e economiza mensagens de ida e volta.",
    check_ticket: "Verificar status do ticket",
    view_ticket: "Ver detalhes do ticket",
    contact_support: "Contatar suporte",
    provide_details: "Fornecer detalhes",
    skip_ticket: "Pular e criar ticket",
    verified_status: "✓ Sua identidade está verificada!\n\nVocê tem acesso a:\n- Limites de transação diários de $50,000+\n- Saques instantâneos\n- Transferências internacionais\n- Recursos premium",
    fraud_theft_alert: "Sinto muito que isso tenha acontecido — isso pode ser uma transação não autorizada. Criei um caso de segurança urgente agora (Ticket #{ticketId}).",
    security_lockdown_title: "🔒 PASSOS DE SEGURANÇA IMEDIATOS:",
    security_step_password: "1. Altere sua senha AGORA",
    security_step_2fa: "2. Ative a autenticação de dois fatores",
    security_step_logout: "3. Saia de todos os dispositivos",
    security_step_bank: "4. Contate seu banco se você vinculou um cartão",
    security_step_otp: "5. NUNCA compartilhe códigos OTP ou de verificação",
    fraud_investigation_help: "Para investigar rapidamente, responda a estas perguntas:",
    fraud_q1: "Qual transação parece não autorizada?",
    fraud_q2: "Data/hora aproximada?",
    fraud_q3: "Você perdeu seu telefone ou recebeu prompts de OTP suspeitos?",
    fraud_sla: "🛡 Casos de fraude/segurança: Respondemos em 12-24 horas.",
    fraud_ticket_id: "Seu ticket de segurança: #{ticketId}",
    transaction_pending_stop: "⚠️ Esta transação está PENDENTE — podemos conseguir pará-la.",
    transaction_completed: "Esta transação foi concluída. Investigaremos para possível reversão.",
    multiple_suspicious: "⚠️ ALERTA: Múltiplas transações suspeitas detectadas — possível tomada de conta.",
    tx_latest: "Posso te ajudar a verificar suas transações recentes. Veja o histórico de transações no app, ou posso criar um ticket de suporte se precisar de investigação detalhada de uma transação específica.",
    tx_latest_s1: "Ver transações", tx_latest_s2: "Reportar problema de transação", tx_latest_s3: "Verificar status",
    tx_issue: "Para problemas com transações, posso te ajudar com:\n\n- Verificar o status da transação\n- Registrar uma contestação\n- Criar um ticket de suporte para investigação\n",
    tx_issue_note: "Nota: Não posso processar reembolsos diretamente, mas nossa equipe pode investigar em {sla}.",
    tx_issue_s1: "Registrar contestação", tx_issue_s2: "Criar ticket", tx_issue_s3: "Histórico de transações",
    tx_general: "Você pode ver todas as transações na tela de Histórico de Transações. Posso te ajudar a:\n\n- Entender os status das transações\n- Baixar recibos\n- Reportar problemas",
    tx_general_s1: "Ver transações", tx_general_s2: "Baixar recibo", tx_general_s3: "Reportar problema",
    balance_general: "Você pode verificar seu saldo na tela de Carteira em tempo real.",
    balance_incorrect: "Se você acha que seu saldo está incorreto, posso criar um ticket de suporte para investigação.",
    balance_s1: "Ver saldo", balance_s2: "Reportar discrepância", balance_s3: "Adicionar dinheiro",
    balance_limit_s1: "Verificar identidade", balance_limit_s2: "Ver saldo", balance_limit_s3: "Aprender sobre limites", balance_limit_s4: "Verificar status",
    card_create: "Para criar um cartão virtual:\n\n1. Vá para a aba de Cartões\n2. Toque em \"Criar Novo Cartão\"\n3. Defina seu limite de gastos\n4. Cartão pronto na hora!\n\nCartões virtuais são gratuitos, você pode criar até 5 cartões.",
    card_create_s1: "Criar cartão", card_create_s2: "Benefícios do cartão", card_create_s3: "Limites do cartão",
    card_frozen: "Se seu cartão estiver congelado, você pode descongelá-lo na tela de Cartões. Se suspeita de fraude, recomendo criar um ticket de segurança.",
    card_frozen_s1: "Criar ticket de segurança", card_frozen_s2: "Ver cartões", card_frozen_s3: "Ajuda para congelar/descongelar",
    card_general: "Cartões virtuais te ajudam a:\n\n- Fazer compras online com segurança\n- Controlar gastos por comerciante\n- Cancelar a qualquer momento sem afetar sua carteira principal\n\nCada cartão tem seu próprio limite para melhor controle do orçamento.",
    card_general_s1: "Criar cartão", card_general_s2: "Ver cartões", card_general_s3: "Segurança do cartão",
    kyc_pending_response: "⏳ Seus documentos estão sendo analisados.\n\nVamos te notificar em 1-2 dias úteis. Obrigado pela sua paciência!\n\nLimite atual: ${currentLimit}/dia",
    kyc_pending_s1: "Verificar status", kyc_pending_s2: "Enviar documentos adicionais", kyc_pending_s3: "Contatar suporte",
    kyc_unverified: "Verifique sua identidade para desbloquear limites maiores!\n\nBenefícios:\n- Limites de transação de $50.000+\n- Saques instantâneos\n- Transferências internacionais\n",
    kyc_unverified_current: "Atualmente: ${currentLimit}/dia\nApós verificação: $50.000+/dia\n\nA verificação leva ~5 minutos. Você precisará de um documento de identidade oficial.",
    kyc_unverified_s1: "Iniciar verificação", kyc_unverified_s2: "Documentos necessários", kyc_unverified_s3: "Saber mais",
    security_response: "Sua segurança é nossa prioridade! EGWallet te protege com:\n\n- Autenticação biométrica\n- Rastreamento de dispositivos\n- Criptografia de ponta a ponta\n- Confirmações de transações\n- Monitoramento de fraudes 24/7\n\nAtive o bloqueio biométrico nas Configurações para proteção extra!",
    security_s1: "Ativar biometria", security_s2: "Dispositivos confiáveis", security_s3: "Dicas de segurança",
    refund_response: "Entendo que você precisa de ajuda com esta transação. Posso criar um ticket de suporte para nossa equipe de pagamentos investigar.\n\nNote que:\n- Prazo de investigação: 2-3 dias úteis\n- Reembolsos dependem do tipo de transação e nossas políticas\n- Você receberá atualizações por e-mail\n\nNão posso processar reembolsos diretamente, mas nossa equipe revisará seu caso.",
    refund_s1: "Criar ticket", refund_s2: "Registrar contestação", refund_s3: "Contatar suporte",
    help_response: "Estou aqui para ajudar! Você pode:\n\n- Perguntar sobre funcionalidades\n- Obter informações sobre transações\n- Reportar problemas\n- Criar tickets de suporte\n\nNosso Centro de Ajuda tem guias detalhados, ou posso te conectar com nossa equipe de suporte.",
    help_s1: "Ver FAQs", help_s2: "Criar ticket", help_s3: "Guias de funcionalidades",
    fees_response: "Estrutura de taxas da EGWallet:\n\n✓ Adicionar dinheiro — primeiras 6 recargas: GRÁTIS, depois 0,5%\n✓ Enviar / Receber: GRÁTIS\n- Conversão de moeda: 1,15% (envios entre moedas)\n- Saque local: 1,28%\n- Saque internacional: 1,75%\n✓ Cartão virtual: GRÁTIS\n✓ Assinatura mensal: GRÁTIS\n\nTodas as taxas são exibidas antes de confirmar. Sem cobranças ocultas.",
    fees_s1: "Como a taxa é calculada?", fees_s2: "Transferências internacionais", fees_s3: "Economizar em taxas",
    dispute_response: "Posso te ajudar a registrar uma contestação formal ou criar um ticket de suporte. Nossa equipe vai:\n\n1. Analisar seu caso em 2-3 dias úteis\n2. Contatar as partes relevantes\n3. Investigar minuciosamente\n4. Fornecer atualizações regulares\n\nNota: Os prazos de investigação variam de acordo com a complexidade do caso.",
    dispute_s1: "Registrar contestação", dispute_s2: "Criar ticket", dispute_s3: "Ver processo de contestação",
    default_response: "Posso te ajudar com:\n\n- Perguntas sobre transações e histórico\n- Informações de conta e saldo\n- Cartões virtuais\n- Verificação de identidade\n- Configurações de segurança\n- Criação de tickets de suporte\n\nPara problemas complexos, posso criar um ticket de suporte para nossa equipe investigar.",
    default_s1: "Criar ticket", default_s2: "Ver FAQs", default_s3: "Ver conta",
    typing_indicator: "Felisa está digitando...",
    init_s1: "Verificar minha transação", init_s2: "Reportar um problema", init_s3: "Limites da conta", init_s4: "Como enviar dinheiro",
    qa_track: "Rastrear Transação", qa_track_q: "Verificar o status da minha última transação",
    qa_issue: "Reportar Problema", qa_issue_q: "Quero reportar um problema",
    qa_card: "Cartões Virtuais", qa_card_q: "Como crio um cartão virtual?",
    qa_verify: "Verificar Identidade", qa_verify_q: "Me ajude a verificar minha identidade",
    limit_daily_reached: "Você atingiu o seu limite diário de {limit}. Conclua a verificação para aumentar os seus limites.",
    limit_weekly_reached: "Você atingiu o seu limite semanal de {limit}. Conclua a verificação para aumentar os seus limites.",
    limit_monthly_reached: "Você atingiu o seu limite mensal de {limit}. Conclua a verificação para aumentar os seus limites.",
    limit_upgrade: "",
    error_user_not_found: "Utilizador não encontrado.",
    error_invalid_credentials: "Email ou palavra-passe incorretos.",
    error_user_exists: "O utilizador já existe.",
    error_username_invalid: "O nome de utilizador deve ter entre 3 e 20 caracteres (letras, números e underscores).",
    error_username_taken: "O nome de utilizador já está em uso.",
    error_username_required: "O nome de utilizador é obrigatório.",
    error_missing_token: "Token em falta.",
    error_invalid_token: "Token inválido.",
    error_invalid_refresh_token: "Token de atualização inválido ou expirado.",
    error_missing_fields: "Campos obrigatórios em falta.",
    error_cannot_send_to_self: "Não pode enviar dinheiro para si mesmo.",
    error_source_wallet_not_found: "Carteira de origem não encontrada.",
    error_destination_wallet_not_found: "Carteira de destino não encontrada.",
    error_insufficient_funds: "Fundos insuficientes.",
    error_sender_not_found: "Conta do remetente não encontrada.",
    error_wallet_capacity_exceeded: "A carteira de destino excederia a capacidade máxima.",
    error_transaction_persist: "A transação não pôde ser concluída. Por favor tente novamente.",
    error_wallet_not_found: "Carteira não encontrada.",
    error_recipient_not_found: "Destinatário não encontrado.",
    error_qr_not_found: "Código QR não encontrado.",
    error_qr_expired: "O código QR expirou.",
    error_qr_used: "O código QR já foi utilizado.",
    error_qr_fraud: "Assinatura inválida - possível fraude.",
    error_invalid_qr_format: "Formato QR inválido.",
    error_request_not_found: "Pedido não encontrado.",
    error_request_processed: "O pedido já foi processado.",
    error_card_not_found: "Cartão não encontrado.",
    error_card_deleted: "Este cartão foi eliminado.",
    error_max_cards: "Máximo de 5 cartões permitidos.",
    error_budget_not_found: "Orçamento não encontrado.",
    error_employer_not_found: "Conta de empregador não encontrada.",
    error_employer_exists: "A conta de empregador já existe.",
    error_employer_not_verified: "A conta de empregador não está verificada.",
    error_insufficient_kyc: "Nível KYC insuficiente para esta operação.",
    error_no_file_uploaded: "Nenhum ficheiro enviado.",
    error_csv_empty: "O ficheiro CSV está vazio.",
    error_invalid_csv: "Formato CSV inválido.",
    error_insufficient_funds_payroll: "Fundos insuficientes — nenhum dinheiro foi enviado.",
    error_payroll_validation: "Falha na validação da folha de pagamento — nenhum dinheiro foi enviado.",
    error_employee_added: "Funcionário já adicionado.",
    error_worker_not_found: "Trabalhador não encontrado. Deve registar-se primeiro.",
    error_not_linked_employer: "Não está vinculado a este empregador.",
    error_not_authorized_employer: "Não está autorizado a receber pagamentos deste empregador.",
    error_employer_unverified: "Esta conta de empregador ainda não foi verificada.",
    error_employer_insufficient_balance: "O empregador não tem saldo suficiente para este pedido.",
    error_request_exceeds_limit: "O montante do pedido excede o seu limite de {limit} {currency}.",
    error_duplicate_request: "Pedido duplicado. Já tem um pedido pendente para este montante.",
    error_internal: "Ocorreu um erro inesperado. Por favor tente novamente.",
    error_unauthorized: "Não autorizado.",
    error_access_denied: "Acesso negado.",
    error_currency_required: "A preferência de moeda é obrigatória.",
    error_too_many_accounts: "Demasiadas contas criadas a partir deste dispositivo. Por favor tente em 24 horas.",
    error_too_many_kyc: "Demasiadas tentativas de verificação. Por favor tente em 1 hora.",
    error_email_confirm_mismatch: "A confirmação de email não corresponde.",
    error_password_confirm_invalid: "A confirmação de palavra-passe é inválida.",
    error_not_found: "Não encontrado.",
    error_withdrawal_in_progress: "Já existe um levantamento em processamento nesta moeda. Por favor aguarde."
  },
  zh: {
    greeting: "您好！👋 我叫 Felisa，是您的 EGWallet 助手。我可以帮助您：\n\n- 交易问题\n- 账户信息\n- 功能指南\n- 支持工单\n\n今天我能帮您什么？",
    greeting_return: "您好！👋 今天我能帮您什么？",
    escalated_fraud: "我理解这非常重要。我已为我们的反欺诈安全团队创建了紧急优先工单 ({ticketId})。",
    escalated_security: "我理解这很紧急。我已为我们的账户安全团队创建了紧急优先工单 ({ticketId})。",
    escalated_legal: "我理解这非常重要。我已为我们的法律团队创建了紧急优先工单 ({ticketId})。",
    escalated_general: "我理解这很重要。我已为我们的支持团队创建了高优先级工单 ({ticketId})。",
    sla_urgent: "⚡ 优先响应：我们将在 12 小时内调查此事。",
    sla_high: "🔍 高优先级：我们的团队将在 24 小时内回复。",
    sla_normal: "预期响应时间：24-48 小时",
    email_updates: "✓ 您将收到有关工单的电子邮件更新",
    track_status: "✓ 随时在支持部分跟踪状态",
    security_email: "🛡 如需立即获得安全协助，请发送电子邮件至：SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 您的账户限额：\n- 每日限额：${dailyLimit}\n- 今日已用：${dailySpent}\n- 剩余：${dailyRemaining}",
    get_verified: "💡 验证身份以解锁 $50,000+ 每日限额！",
    verification_pending: "⏳ 您的验证正在审核中。更高限额即将到来！",
    data_collection_reason: "为了彻底调查此问题，我需要更多详细信息：",
    data_collection_help: "这有助于我们更快地调查并节省来回消息。",
    check_ticket: "检查工单状态",
    view_ticket: "查看工单详情",
    contact_support: "联系支持",
    provide_details: "提供详细信息",
    skip_ticket: "跳过并创建工单",
    verified_status: "✓ 您的身份已验证！\n\n您可以访问：\n- $50,000+ 每日交易限额\n- 即时提款\n- 国际转账\n- 高级功能",
    fraud_theft_alert: "很抱歉发生这种情况 — 这可能是未经授权的交易。我现在已创建紧急安全案例（工单 #{ticketId}）。",
    security_lockdown_title: "🔒 立即安全步骤：",
    security_step_password: "1. 立即更改您的密码",
    security_step_2fa: "2. 启用双因素身份验证",
    security_step_logout: "3. 从所有设备注销",
    security_step_bank: "4. 如果您绑定了卡，请联系您的银行",
    security_step_otp: "5. 永远不要分享 OTP 或验证码",
    fraud_investigation_help: "为了快速调查，请回答这些问题：",
    fraud_q1: "哪笔交易看起来未经授权？",
    fraud_q2: "大约日期/时间？",
    fraud_q3: "您是否丢失了手机或收到可疑的 OTP 提示？",
    fraud_sla: "🛡 欺诈/安全案例：我们在 12-24 小时内响应。",
    fraud_ticket_id: "您的安全工单：#{ticketId}",
    transaction_pending_stop: "⚠️ 此交易处于待处理状态 — 我们可能能够阻止它。",
    transaction_completed: "此交易已完成。我们将调查是否可以撤销。",
    multiple_suspicious: "⚠️ 警报：检测到多笔可疑交易 — 可能的账户接管。",
    tx_latest: "我可以帮您查看最近的交易。在应用中查看交易记录，或如果您需要对特定交易进行详细调查，我可以创建支持工单。",
    tx_latest_s1: "查看交易", tx_latest_s2: "报告交易问题", tx_latest_s3: "检查状态",
    tx_issue: "对于交易问题，我可以帮您：\n\n- 检查交易状态\n- 提交争议\n- 创建支持工单进行调查\n",
    tx_issue_note: "注意：我不能直接处理退款或撤销，但我们的团队可以在 {sla} 内进行调查。",
    tx_issue_s1: "提交争议", tx_issue_s2: "创建工单", tx_issue_s3: "交易历史",
    tx_general: "您可以在交易历史界面查看所有交易。我可以帮您：\n\n- 了解交易状态\n- 下载收据\n- 报告问题",
    tx_general_s1: "查看交易", tx_general_s2: "下载收据", tx_general_s3: "报告问题",
    balance_general: "您可以在钱包界面实时查看您的余额。",
    balance_incorrect: "如果您认为余额有误，我可以创建支持工单进行调查。",
    balance_s1: "查看余额", balance_s2: "报告差异", balance_s3: "充值",
    balance_limit_s1: "完成认证", balance_limit_s2: "查看余额", balance_limit_s3: "了解限额", balance_limit_s4: "查看认证状态",
    card_create: "创建虚拟卡：\n\n1. 进入卡片标签\n2. 点击\"创建新卡\"\n3. 设置消费限额\n4. 卡片立即可用！\n\n虚拟卡免费，最多可创建5张。",
    card_create_s1: "创建卡片", card_create_s2: "卡片优势", card_create_s3: "卡片限额",
    card_frozen: "如果您的卡被冻结，可以在卡片界面解冻。如果怀疑欺诈，建议创建安全工单。",
    card_frozen_s1: "创建安全工单", card_frozen_s2: "查看卡片", card_frozen_s3: "冻结/解冻帮助",
    card_general: "虚拟卡帮助您：\n\n- 安全在线购物\n- 按商户控制消费\n- 随时取消，不影响主钱包\n\n每张卡都有独立限额，更好管理预算。",
    card_general_s1: "创建卡片", card_general_s2: "查看卡片", card_general_s3: "卡片安全",
    kyc_pending_response: "⏳ 您的文件正在审核中。\n\n我们将在1-2个工作日内通知您。感谢您的耐心！\n\n当前限额：${currentLimit}/天",
    kyc_pending_s1: "检查状态", kyc_pending_s2: "上传补充文件", kyc_pending_s3: "联系客服",
    kyc_unverified: "完成身份认证以解锁更高限额！\n\n优势：\n- 每日交易限额$50,000+\n- 即时提款\n- 国际转账\n",
    kyc_unverified_current: "目前：${currentLimit}/天\n认证后：$50,000+/天\n\n认证仅需约5分钟，需要一张政府颁发的证件。",
    kyc_unverified_s1: "开始认证", kyc_unverified_s2: "所需文件", kyc_unverified_s3: "了解更多",
    security_response: "您的安全是我们的首要任务！EGWallet通过以下方式保护您：\n\n- 生物特征认证\n- 设备追踪\n- 端到端加密\n- 交易确认\n- 24/7欺诈监控\n\n在设置中启用生物锁定以获得额外保护！",
    security_s1: "启用生物识别", security_s2: "信任设备", security_s3: "安全提示",
    refund_response: "我理解您需要帮助处理此交易。我可以创建支持工单，由我们的支付团队进行调查。\n\n请注意：\n- 调查时间：2-3个工作日\n- 退款取决于交易类型和我们的政策\n- 您将收到电子邮件更新\n\n我无法直接处理退款，但我们的团队将审查您的案例。",
    refund_s1: "创建工单", refund_s2: "提交争议", refund_s3: "联系客服",
    help_response: "我在这里为您提供帮助！您可以：\n\n- 询问功能相关问题\n- 获取交易信息\n- 报告问题\n- 创建支持工单\n\n我们的帮助中心有详细指南，或我可以为您联系支持团队。",
    help_s1: "浏览常见问题", help_s2: "创建工单", help_s3: "功能指南",
    fees_response: "EGWallet费率结构：\n\n✓ 充值 — 前6次：免费，之后0.5%\n✓ 发送/接收：免费\n- 外汇转换：1.15%（跨货币发送）\n- 本地提款：1.28%\n- 国际提款：1.75%\n✓ 虚拟卡：免费\n✓ 月度订阅：免费\n\n所有费用在确认前均会显示，没有隐藏收费。",
    fees_s1: "费用如何计算？", fees_s2: "国际转账", fees_s3: "节省费用",
    dispute_response: "我可以帮您提交正式争议或创建支持工单。我们的团队将：\n\n1. 在2-3个工作日内审查您的案例\n2. 联系相关方\n3. 进行彻底调查\n4. 定期提供更新\n\n注意：调查时间因案例复杂性而异。",
    dispute_s1: "提交争议", dispute_s2: "创建工单", dispute_s3: "查看争议流程",
    default_response: "我可以帮您处理：\n\n- 交易问题和历史记录\n- 账户和余额信息\n- 虚拟卡\n- 身份验证\n- 安全设置\n- 创建支持工单\n\n对于复杂问题，我可以创建支持工单让我们的团队进行调查。",
    default_s1: "创建工单", default_s2: "浏览常见问题", default_s3: "查看账户",
    typing_indicator: "Felisa 正在输入...",
    init_s1: "查看我的交易", init_s2: "报告问题", init_s3: "账户限额", init_s4: "如何汇款",
    qa_track: "追踪交易", qa_track_q: "查看我最近的交易状态",
    qa_issue: "报告问题", qa_issue_q: "我想报告一个问题",
    qa_card: "虚拟卡", qa_card_q: "如何创建虚拟卡？",
    qa_verify: "验证身份", qa_verify_q: "帮我验证我的身份",
    limit_daily_reached: "您已达到每日限额 {limit}，请完成身份认证以提升限额。",
    limit_weekly_reached: "您已达到每周限额 {limit}，请完成身份认证以提升限额。",
    limit_monthly_reached: "您已达到每月限额 {limit}，请完成身份认证以提升限额。",
    limit_upgrade: "",
    error_user_not_found: "用户不存在。",
    error_invalid_credentials: "邮箱或密码错误。",
    error_user_exists: "用户已存在。",
    error_username_invalid: "用户名必须为3-20个字符（仅限字母、数字和下划线）。",
    error_username_taken: "用户名已被使用。",
    error_username_required: "用户名为必填项。",
    error_missing_token: "缺少令牌。",
    error_invalid_token: "令牌无效。",
    error_invalid_refresh_token: "刷新令牌无效或已过期。",
    error_missing_fields: "缺少必填字段。",
    error_cannot_send_to_self: "您不能给自己转账。",
    error_source_wallet_not_found: "来源钱包不存在。",
    error_destination_wallet_not_found: "目标钱包不存在。",
    error_insufficient_funds: "余额不足。",
    error_sender_not_found: "发送方账户不存在。",
    error_wallet_capacity_exceeded: "目标钱包将超过最大容量。",
    error_transaction_persist: "交易无法完成，请重试。",
    error_wallet_not_found: "钱包不存在。",
    error_recipient_not_found: "收款方不存在。",
    error_qr_not_found: "二维码不存在。",
    error_qr_expired: "二维码已过期。",
    error_qr_used: "二维码已被使用。",
    error_qr_fraud: "签名无效 - 可能存在欺诈。",
    error_invalid_qr_format: "二维码格式无效。",
    error_request_not_found: "请求不存在。",
    error_request_processed: "请求已被处理。",
    error_card_not_found: "卡片不存在。",
    error_card_deleted: "该卡片已被删除。",
    error_max_cards: "最多允许5张卡片。",
    error_budget_not_found: "预算不存在。",
    error_employer_not_found: "雇主账户不存在。",
    error_employer_exists: "雇主账户已存在。",
    error_employer_not_verified: "雇主账户未经验证。",
    error_insufficient_kyc: "此操作的KYC级别不足。",
    error_no_file_uploaded: "未上传文件。",
    error_csv_empty: "CSV文件为空。",
    error_invalid_csv: "CSV格式无效。",
    error_insufficient_funds_payroll: "资金不足——未发送任何款项。",
    error_payroll_validation: "薪资验证失败——未发送任何款项。",
    error_employee_added: "员工已添加。",
    error_worker_not_found: "员工不存在，请先注册。",
    error_not_linked_employer: "您未与此雇主关联。",
    error_not_authorized_employer: "您未被授权从此雇主处接收付款。",
    error_employer_unverified: "此雇主账户尚未验证。",
    error_employer_insufficient_balance: "雇主余额不足，无法处理此请求。",
    error_request_exceeds_limit: "请求金额超过您的限额 {limit} {currency}。",
    error_duplicate_request: "重复请求。您已有此金额的待处理请求。",
    error_internal: "发生意外错误，请重试。",
    error_unauthorized: "未授权。",
    error_access_denied: "拒绝访问。",
    error_currency_required: "货币偏好设置为必填项。",
    error_too_many_accounts: "此设备创建的账户过多，请24小时后重试。",
    error_too_many_kyc: "验证尝试次数过多，请1小时后重试。",
    error_email_confirm_mismatch: "邮箱确认不匹配。",
    error_password_confirm_invalid: "密码确认无效。",
    error_not_found: "未找到。",
    error_withdrawal_in_progress: "此货币的提款正在处理中，请稍候。"
  },
  ja: {
    greeting: "こんにちは！👋 私はFelisaです、EGWalletのアシスタントです。以下についてサポートできます：\n\n- 取引に関する質問\n- アカウント情報\n- 機能ガイド\n- サポートチケット\n\n本日はどのようにお手伝いできますか？",
    greeting_return: "こんにちは！👋 本日はどのようにお手伝いできますか？",
    escalated_fraud: "これは非常に重要だと理解しています。不正対策セキュリティチームのために緊急優先チケット ({ticketId}) を作成しました。",
    escalated_security: "これは緊急だと理解しています。アカウントセキュリティチームのために緊急優先チケット ({ticketId}) を作成しました。",
    escalated_legal: "これは非常に重要だと理解しています。法務チームのために緊急優先チケット ({ticketId}) を作成しました。",
    escalated_general: "これは重要だと理解しています。サポートチームのために高優先チケット ({ticketId}) を作成しました。",
    sla_urgent: "⚡ 優先対応：12時間以内にこの問題を調査します。",
    sla_high: "🔍 高優先度：チームは24時間以内に対応します。",
    sla_normal: "予想応答時間：24～48時間",
    email_updates: "✓ チケットに関するメール更新を受け取ります",
    track_status: "✓ サポートセクションでいつでもステータスを追跡できます",
    security_email: "🛡 緊急のセキュリティサポートが必要な場合は、次のアドレスにもメールしてください：SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 アカウントの制限：\n- 1日の制限：${dailyLimit}\n- 本日使用：${dailySpent}\n- 残り：${dailyRemaining}",
    get_verified: "💡 本人確認をして $50,000+ の1日制限を解除しましょう！",
    verification_pending: "⏳ 本人確認は審査中です。より高い制限がまもなく利用可能になります！",
    data_collection_reason: "この問題を徹底的に調査するために、いくつかの詳細が必要です：",
    data_collection_help: "これにより、調査が迅速化され、やり取りが節約されます。",
    check_ticket: "チケットステータスを確認",
    view_ticket: "チケット詳細を表示",
    contact_support: "サポートに連絡",
    provide_details: "詳細を提供",
    skip_ticket: "スキップしてチケットを作成",
    verified_status: "✓ 本人確認が完了しました！\n\nアクセス可能：\n- $50,000+ の1日取引制限\n- 即時出金\n- 国際送金\n- プレミアム機能",
    fraud_theft_alert: "申し訳ございません — これは不正な取引である可能性があります。緊急セキュリティケースを作成しました（チケット #{ticketId}）。",
    security_lockdown_title: "🔒 緊急セキュリティ手順：",
    security_step_password: "1. 今すぐパスワードを変更してください",
    security_step_2fa: "2. 二要素認証を有効にしてください",
    security_step_logout: "3. すべてのデバイスからログアウトしてください",
    security_step_bank: "4. カードをリンクしている場合は銀行に連絡してください",
    security_step_otp: "5. OTP または確認コードを共有しないでください",
    fraud_investigation_help: "迅速に調査するため、以下の質問に答えてください：",
    fraud_q1: "どの取引が不正に見えますか？",
    fraud_q2: "おおよその日時は？",
    fraud_q3: "携帯電話を紛失したり、不審な OTP プロンプトを受け取りましたか？",
    fraud_sla: "🛡 不正/セキュリティケース：12-24時間以内に対応します。",
    fraud_ticket_id: "セキュリティチケット：#{ticketId}",
    transaction_pending_stop: "⚠️ この取引は保留中です — 停止できる可能性があります。",
    transaction_completed: "この取引は完了しました。取り消しの可能性を調査します。",
    multiple_suspicious: "⚠️ 警告：複数の不審な取引が検出されました — アカウント乗っ取りの可能性。",
    tx_latest: "最近の取引を確認するお手伝いができます。アプリで取引履歴をご確認いただくか、特定の取引の詳しい調査が必要な場合はサポートチケットを作成できます。",
    tx_latest_s1: "取引を見る", tx_latest_s2: "取引の問題を報告", tx_latest_s3: "ステータスを確認",
    tx_issue: "取引に関する問題については、以下のお手伝いができます：\n\n- 取引ステータスの確認\n- 異議申し立て\n- 調査のためのサポートチケット作成\n",
    tx_issue_note: "注意：返金や取り消しは直接処理できませんが、チームが {sla} 以内に調査します。",
    tx_issue_s1: "異議を申し立てる", tx_issue_s2: "チケットを作成", tx_issue_s3: "取引履歴",
    tx_general: "すべての取引は取引履歴画面でご確認いただけます。以下のお手伝いができます：\n\n- 取引ステータスの理解\n- 領収書のダウンロード\n- 問題の報告",
    tx_general_s1: "取引を見る", tx_general_s2: "領収書をダウンロード", tx_general_s3: "問題を報告",
    balance_general: "ウォレット画面でリアルタイムに残高をご確認いただけます。",
    balance_incorrect: "残高が正しくないと思われる場合は、調査のためのサポートチケットを作成できます。",
    balance_s1: "残高を見る", balance_s2: "差異を報告", balance_s3: "お金を追加",
    balance_limit_s1: "本人確認をする", balance_limit_s2: "残高を見る", balance_limit_s3: "限度額について", balance_limit_s4: "確認ステータスを確認",
    card_create: "仮想カードの作成方法：\n\n1. カードタブへ移動\n2. \"新しいカードを作成\"をタップ\n3. 利用限度額を設定\n4. カードはすぐに使用可能！\n\n仮想カードは無料で、最大5枚作成できます。",
    card_create_s1: "カードを作成", card_create_s2: "カードの特典", card_create_s3: "カードの限度額",
    card_frozen: "カードが凍結されている場合は、カード画面で解除できます。不正使用が疑われる場合は、セキュリティチケットの作成をお勧めします。",
    card_frozen_s1: "セキュリティチケットを作成", card_frozen_s2: "カードを見る", card_frozen_s3: "凍結/解除のヘルプ",
    card_general: "仮想カードは以下のことに役立ちます：\n\n- オンラインで安全に買い物\n- 加盟店ごとの支出管理\n- メインウォレットに影響せずいつでもキャンセル\n\n各カードには個別の限度額があり、予算管理に最適です。",
    card_general_s1: "カードを作成", card_general_s2: "カードを見る", card_general_s3: "カードのセキュリティ",
    kyc_pending_response: "⏳ 書類を審査中です。\n\n1〜2営業日以内にご連絡いたします。ご辛抱いただきありがとうございます！\n\n現在の限度額：${currentLimit}/日",
    kyc_pending_s1: "ステータスを確認", kyc_pending_s2: "追加書類をアップロード", kyc_pending_s3: "サポートに連絡",
    kyc_unverified: "より高い限度額を解除するために本人確認を完了してください！\n\n特典：\n- $50,000以上の取引限度額\n- 即時出金\n- 国際送金\n",
    kyc_unverified_current: "現在：${currentLimit}/日\n確認後：$50,000以上/日\n\n確認には約5分かかります。政府発行の身分証明書が必要です。",
    kyc_unverified_s1: "確認を開始", kyc_unverified_s2: "必要な書類", kyc_unverified_s3: "詳細を見る",
    security_response: "お客様のセキュリティが私たちの最優先事項です！EGWalletは以下の方法でお客様を保護します：\n\n- 生体認証\n- デバイス追跡\n- エンドツーエンド暗号化\n- 取引確認\n- 24時間365日の不正監視\n\n追加の保護のために設定で生体認証ロックを有効にしてください！",
    security_s1: "生体認証を有効にする", security_s2: "信頼できるデバイス", security_s3: "セキュリティのヒント",
    refund_response: "この取引についてお手伝いが必要なことは理解しています。支払いチームが調査するためのサポートチケットを作成できます。\n\nご注意ください：\n- 調査期間：2〜3営業日\n- 返金は取引タイプとポリシーによって異なります\n- メールで更新情報をお送りします\n\n返金を直接処理することはできませんが、チームがケースを確認します。",
    refund_s1: "チケットを作成", refund_s2: "異議を申し立てる", refund_s3: "サポートに連絡",
    help_response: "お手伝いするためにここにいます！以下のことができます：\n\n- 機能についての質問\n- 取引情報の取得\n- 問題の報告\n- サポートチケットの作成\n\nヘルプセンターには詳細なガイドがあります。サポートチームに繋ぐこともできます。",
    help_s1: "よくある質問を見る", help_s2: "チケットを作成", help_s3: "機能ガイド",
    fees_response: "EGWallet手数料体系：\n\n✓ 入金 — 最初の6回：無料、以降0.5%\n✓ 送金/受け取り：無料\n- 外貨両替：1.15%（通貨をまたいだ送金）\n- 国内出金：1.28%\n- 国際出金：1.75%\n✓ 仮想カード：無料\n✓ 月額登録料：無料\n\nすべての手数料は確認前に表示されます。隠れた手数料はありません。",
    fees_s1: "手数料はどのように計算されますか？", fees_s2: "国際送金", fees_s3: "手数料を節約",
    dispute_response: "正式な異議申し立てやサポートチケットの作成をお手伝いできます。チームは以下を行います：\n\n1. 2〜3営業日以内にケースを審査\n2. 関係者に連絡\n3. 徹底的に調査\n4. 定期的に更新情報を提供\n\n注意：調査期間はケースの複雑さによって異なります。",
    dispute_s1: "異議を申し立てる", dispute_s2: "チケットを作成", dispute_s3: "異議申し立てプロセスを見る",
    default_response: "以下のことでお手伝いできます：\n\n- 取引の質問と履歴\n- アカウントと残高の情報\n- 仮想カード\n- 本人確認\n- セキュリティ設定\n- サポートチケットの作成\n\n複雑な問題については、チームが調査するためのサポートチケットを作成できます。",
    default_s1: "チケットを作成", default_s2: "よくある質問を見る", default_s3: "アカウントを見る",
    typing_indicator: "Felisa が入力中...",
    init_s1: "取引を確認", init_s2: "問題を報告", init_s3: "アカウントの限度額", init_s4: "送金の方法",
    qa_track: "取引を追跡", qa_track_q: "最新の取引状況を確認する",
    qa_issue: "問題を報告", qa_issue_q: "問題を報告したい",
    qa_card: "仮想カード", qa_card_q: "仮想カードを作成するにはどうすればいいですか？",
    qa_verify: "身元確認", qa_verify_q: "身元確認を手伝ってください",
    limit_daily_reached: "1日の送金上限 {limit} に達しました。上限を引き上げるには本人確認を完了してください。",
    limit_weekly_reached: "週間の送金上限 {limit} に達しました。上限を引き上げるには本人確認を完了してください。",
    limit_monthly_reached: "月間の送金上限 {limit} に達しました。上限を引き上げるには本人確認を完了してください。",
    limit_upgrade: "",
    error_user_not_found: "ユーザーが見つかりません。",
    error_invalid_credentials: "メールアドレスまたはパスワードが間違っています。",
    error_user_exists: "このユーザーは既に存在します。",
    error_username_invalid: "ユーザー名は3〜20文字（英字、数字、アンダースコアのみ）にしてください。",
    error_username_taken: "このユーザー名は既に使用されています。",
    error_username_required: "ユーザー名は必須です。",
    error_missing_token: "トークンがありません。",
    error_invalid_token: "無効なトークンです。",
    error_invalid_refresh_token: "リフレッシュトークンが無効または期限切れです。",
    error_missing_fields: "必須フィールドが不足しています。",
    error_cannot_send_to_self: "自分自身に送金することはできません。",
    error_source_wallet_not_found: "送金元ウォレットが見つかりません。",
    error_destination_wallet_not_found: "送金先ウォレットが見つかりません。",
    error_insufficient_funds: "残高不足です。",
    error_sender_not_found: "送信者のアカウントが見つかりません。",
    error_wallet_capacity_exceeded: "送金先ウォレットの最大容量を超えます。",
    error_transaction_persist: "取引を完了できませんでした。再試行してください。",
    error_wallet_not_found: "ウォレットが見つかりません。",
    error_recipient_not_found: "受取人が見つかりません。",
    error_qr_not_found: "QRコードが見つかりません。",
    error_qr_expired: "QRコードの有効期限が切れています。",
    error_qr_used: "QRコードは既に使用済みです。",
    error_qr_fraud: "署名が無効です - 不正の可能性があります。",
    error_invalid_qr_format: "QRフォーマットが無効です。",
    error_request_not_found: "リクエストが見つかりません。",
    error_request_processed: "リクエストは既に処理済みです。",
    error_card_not_found: "カードが見つかりません。",
    error_card_deleted: "このカードは削除されています。",
    error_max_cards: "最大5枚のカードまで使用できます。",
    error_budget_not_found: "予算が見つかりません。",
    error_employer_not_found: "雇用主アカウントが見つかりません。",
    error_employer_exists: "雇用主アカウントは既に存在します。",
    error_employer_not_verified: "雇用主アカウントは確認されていません。",
    error_insufficient_kyc: "この操作にはKYCレベルが不足しています。",
    error_no_file_uploaded: "ファイルがアップロードされていません。",
    error_csv_empty: "CSVファイルが空です。",
    error_invalid_csv: "CSVフォーマットが無効です。",
    error_insufficient_funds_payroll: "残高不足のため、送金されませんでした。",
    error_payroll_validation: "給与の検証に失敗しました。送金されませんでした。",
    error_employee_added: "この従業員は既に追加されています。",
    error_worker_not_found: "ワーカーが見つかりません。先に登録してください。",
    error_not_linked_employer: "この雇用主に連携されていません。",
    error_not_authorized_employer: "この雇用主からの支払いを受け取る権限がありません。",
    error_employer_unverified: "この雇用主アカウントはまだ確認されていません。",
    error_employer_insufficient_balance: "雇用主のこのリクエストの残高が不足しています。",
    error_request_exceeds_limit: "リクエスト金額が上限 {limit} {currency} を超えています。",
    error_duplicate_request: "重複リクエストです。この金額の保留中のリクエストが既にあります。",
    error_internal: "予期しないエラーが発生しました。再試行してください。",
    error_unauthorized: "権限がありません。",
    error_access_denied: "アクセスが拒否されました。",
    error_currency_required: "通貨の設定が必要です。",
    error_too_many_accounts: "このデバイスから作成されたアカウントが多すぎます。24時間後に再試行してください。",
    error_too_many_kyc: "確認の試みが多すぎます。1時間後に再試行してください。",
    error_email_confirm_mismatch: "メールアドレスの確認が一致しません。",
    error_password_confirm_invalid: "パスワードの確認が無効です。",
    error_not_found: "見つかりません。",
    error_withdrawal_in_progress: "この通貨の出金は現在処理中です。しばらくお待ちください。"
  },
  ru: {
    greeting: "Здравствуйте! 👋 Меня зовут Фелиса, ваш помощник EGWallet. Я могу помочь вам с:\n\n- Вопросами о транзакциях\n- Информацией об учетной записи\n- Руководствами по функциям\n- Заявками в поддержку\n\nКак я могу помочь вам сегодня?",
    greeting_return: "Снова здравствуйте! 👋 Как я могу помочь вам сегодня?",
    escalated_fraud: "Я понимаю, что это очень важно. Я создал СРОЧНУЮ заявку ({ticketId}) для нашей команды безопасности по борьбе с мошенничеством.",
    escalated_security: "Я понимаю, что это срочно. Я создал СРОЧНУЮ заявку ({ticketId}) для нашей команды безопасности учетных записей.",
    escalated_legal: "Я понимаю, что это очень важно. Я создал СРОЧНУЮ заявку ({ticketId}) для нашей юридической команды.",
    escalated_general: "Я понимаю, что это важно. Я создал заявку с ВЫСОКИМ приоритетом ({ticketId}) для нашей команды поддержки.",
    sla_urgent: "⚡ ПРИОРИТЕТНЫЙ ОТВЕТ: Мы рассмотрим этот вопрос в течение 12 часов.",
    sla_high: "🔍 ВЫСОКИЙ ПРИОРИТЕТ: Наша команда ответит в течение 24 часов.",
    sla_normal: "Ожидаемое время ответа: 24-48 часов",
    email_updates: "✓ Вы будете получать обновления по электронной почте о вашей заявке",
    track_status: "✓ Отслеживайте статус в любое время в разделе Поддержка",
    security_email: "🛡 Для немедленной помощи по вопросам безопасности также отправьте письмо на: SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 Лимиты вашей учетной записи:\n- Дневной лимит: ${dailyLimit}\n- Использовано сегодня: ${dailySpent}\n- Осталось: ${dailyRemaining}",
    get_verified: "💡 Пройдите верификацию, чтобы разблокировать дневные лимиты $50,000+!",
    verification_pending: "⏳ Ваша верификация находится на рассмотрении. Более высокие лимиты скоро!",
    data_collection_reason: "Чтобы тщательно расследовать эту проблему, мне нужно несколько дополнительных деталей:",
    data_collection_help: "Это помогает нам быстрее расследовать и экономит переписку.",
    check_ticket: "Проверить статус заявки",
    view_ticket: "Просмотреть детали заявки",
    contact_support: "Связаться с поддержкой",
    provide_details: "Предоставить детали",
    skip_ticket: "Пропустить и создать заявку",
    verified_status: "✓ Ваша личность подтверждена!\n\nУ вас есть доступ к:\n- Дневные лимиты транзакций $50,000+\n- Мгновенные выводы\n- Международные переводы\n- Премиум функции",
    fraud_theft_alert: "Мне очень жаль, что это произошло — это может быть несанкционированная транзакция. Я создал срочное дело безопасности (Заявка #{ticketId}).",
    security_lockdown_title: "🔒 НЕМЕДЛЕННЫЕ МЕРЫ БЕЗОПАСНОСТИ:",
    security_step_password: "1. Измените пароль СЕЙЧАС",
    security_step_2fa: "2. Включите двухфакторную аутентификацию",
    security_step_logout: "3. Выйдите со всех устройств",
    security_step_bank: "4. Свяжитесь с банком, если привязали карту",
    security_step_otp: "5. НИКОГДА не делитесь кодами OTP или подтверждения",
    fraud_investigation_help: "Для быстрого расследования ответьте на эти вопросы:",
    fraud_q1: "Какая транзакция выглядит несанкционированной?",
    fraud_q2: "Приблизительная дата/время?",
    fraud_q3: "Вы потеряли телефон или получили подозрительные запросы OTP?",
    fraud_sla: "🛡 Дела о мошенничестве/безопасности: Отвечаем в течение 12-24 часов.",
    fraud_ticket_id: "Ваша заявка безопасности: #{ticketId}",
    transaction_pending_stop: "⚠️ Эта транзакция ОЖИДАЕТ — мы можем остановить её.",
    transaction_completed: "Эта транзакция завершена. Мы расследуем возможность отмены.",
    multiple_suspicious: "⚠️ ТРЕВОГА: Обнаружено несколько подозрительных транзакций — возможный захват аккаунта.",
    tx_latest: "Я могу помочь вам проверить последние транзакции. Просмотрите историю транзакций в приложении или я могу создать тикет поддержки для детального расследования конкретной транзакции.",
    tx_latest_s1: "Просмотреть транзакции", tx_latest_s2: "Сообщить о проблеме", tx_latest_s3: "Проверить статус",
    tx_issue: "По вопросам с транзакциями я могу помочь:\n\n- Проверить статус транзакции\n- Подать спор\n- Создать тикет поддержки для расследования\n",
    tx_issue_note: "Примечание: я не могу обработать возвраты напрямую, но наша команда может расследовать в течение {sla}.",
    tx_issue_s1: "Подать спор", tx_issue_s2: "Создать тикет", tx_issue_s3: "История транзакций",
    tx_general: "Все транзакции можно просмотреть на экране истории транзакций. Я могу помочь:\n\n- Понять статусы транзакций\n- Скачать квитанции\n- Сообщить о проблемах",
    tx_general_s1: "Просмотреть транзакции", tx_general_s2: "Скачать квитанцию", tx_general_s3: "Сообщить о проблеме",
    balance_general: "Вы можете проверить баланс на экране Кошелька в режиме реального времени.",
    balance_incorrect: "Если вы считаете, что баланс неверен, я могу создать тикет поддержки для расследования.",
    balance_s1: "Посмотреть баланс", balance_s2: "Сообщить о расхождении", balance_s3: "Пополнить счёт",
    balance_limit_s1: "Пройти верификацию", balance_limit_s2: "Посмотреть баланс", balance_limit_s3: "Узнать о лимитах", balance_limit_s4: "Проверить статус верификации",
    card_create: "Чтобы создать виртуальную карту:\n\n1. Перейдите на вкладку Карты\n2. Нажмите \"Создать новую карту\"\n3. Установите лимит расходов\n4. Карта готова мгновенно!\n\nВиртуальные карты бесплатны, можно создать до 5 карт.",
    card_create_s1: "Создать карту", card_create_s2: "Преимущества карты", card_create_s3: "Лимиты карты",
    card_frozen: "Если карта заморожена, разморозьте её на экране Карты. При подозрении на мошенничество рекомендую создать тикет безопасности.",
    card_frozen_s1: "Создать тикет безопасности", card_frozen_s2: "Просмотреть карты", card_frozen_s3: "Помощь с заморозкой/разморозкой",
    card_general: "Виртуальные карты помогают:\n\n- Безопасно делать покупки онлайн\n- Контролировать расходы у каждого продавца\n- Отменить в любое время без влияния на основной кошелёк\n\nКаждая карта имеет собственный лимит для лучшего управления бюджетом.",
    card_general_s1: "Создать карту", card_general_s2: "Просмотреть карты", card_general_s3: "Безопасность карты",
    kyc_pending_response: "⏳ Ваши документы рассматриваются.\n\nМы уведомим вас в течение 1-2 рабочих дней. Спасибо за терпение!\n\nТекущий лимит: ${currentLimit}/день",
    kyc_pending_s1: "Проверить статус", kyc_pending_s2: "Загрузить дополнительные документы", kyc_pending_s3: "Связаться с поддержкой",
    kyc_unverified: "Пройдите верификацию для разблокировки более высоких лимитов!\n\nПреимущества:\n- Лимиты транзакций $50,000+\n- Мгновенный вывод\n- Международные переводы\n",
    kyc_unverified_current: "Сейчас: ${currentLimit}/день\nПосле верификации: $50,000+/день\n\nВерификация занимает ~5 минут. Потребуется удостоверение личности государственного образца.",
    kyc_unverified_s1: "Начать верификацию", kyc_unverified_s2: "Необходимые документы", kyc_unverified_s3: "Узнать больше",
    security_response: "Ваша безопасность — наш приоритет! EGWallet защищает вас:\n\n- Биометрическая аутентификация\n- Отслеживание устройств\n- Сквозное шифрование\n- Подтверждения транзакций\n- Мониторинг мошенничества 24/7\n\nВключите биометрическую блокировку в Настройках для дополнительной защиты!",
    security_s1: "Включить биометрию", security_s2: "Доверенные устройства", security_s3: "Советы по безопасности",
    refund_response: "Я понимаю, что вам нужна помощь с этой транзакцией. Я могу создать тикет поддержки для расследования нашей командой платежей.\n\nПожалуйста, обратите внимание:\n- Срок расследования: 2-3 рабочих дня\n- Возвраты зависят от типа транзакции и наших политик\n- Вы получите обновления по электронной почте\n\nЯ не могу обработать возврат напрямую, но наша команда рассмотрит ваш случай.",
    refund_s1: "Создать тикет", refund_s2: "Подать спор", refund_s3: "Связаться с поддержкой",
    help_response: "Я здесь, чтобы помочь! Вы можете:\n\n- Задавать вопросы о функциях\n- Получить информацию о транзакциях\n- Сообщить о проблемах\n- Создать тикеты поддержки\n\nВ нашем Справочном центре есть подробные руководства, или я могу связать вас с нашей командой поддержки.",
    help_s1: "Просмотреть FAQ", help_s2: "Создать тикет", help_s3: "Руководства по функциям",
    fees_response: "Структура комиссий EGWallet:\n\n✓ Пополнение — первые 3 пополнения: БЕСПЛАТНО, затем 0,5%\n✓ Отправка / Получение: БЕСПЛАТНО\n- Конвертация валют: 1,15% (отправка между валютами)\n- Вывод внутри страны: 0,8%\n- Международный вывод: 1,75%\n✓ Виртуальная карта: БЕСПЛАТНО\n✓ Ежемесячная подписка: БЕСПЛАТНО\n\nВсе комиссии отображаются перед подтверждением. Без скрытых платежей.",
    fees_s1: "Как рассчитывается комиссия?", fees_s2: "Международные переводы", fees_s3: "Сэкономить на комиссиях",
    dispute_response: "Я могу помочь вам подать официальный спор или создать тикет поддержки. Наша команда:\n\n1. Рассмотрит ваше дело в течение 2-3 рабочих дней\n2. Свяжется с соответствующими сторонами\n3. Проведёт тщательное расследование\n4. Будет регулярно предоставлять обновления\n\nПримечание: Сроки расследования зависят от сложности дела.",
    dispute_s1: "Подать спор", dispute_s2: "Создать тикет", dispute_s3: "Посмотреть процесс оспаривания",
    default_response: "Я могу помочь вам с:\n\n- Вопросами о транзакциях и историей\n- Информацией об аккаунте и балансе\n- Виртуальными картами\n- Верификацией личности\n- Настройками безопасности\n- Созданием тикетов поддержки\n\nДля сложных вопросов я могу создать тикет поддержки для расследования нашей командой.",
    default_s1: "Создать тикет", default_s2: "Просмотреть FAQ", default_s3: "Посмотреть аккаунт",
    typing_indicator: "Felisa печатает...",
    init_s1: "Проверить транзакцию", init_s2: "Сообщить о проблеме", init_s3: "Лимиты аккаунта", init_s4: "Как отправить деньги",
    qa_track: "Отследить транзакцию", qa_track_q: "Проверить статус последней транзакции",
    qa_issue: "Сообщить о проблеме", qa_issue_q: "Я хочу сообщить о проблеме",
    qa_card: "Виртуальные карты", qa_card_q: "Как создать виртуальную карту?",
    qa_verify: "Подтвердить личность", qa_verify_q: "Помогите мне подтвердить личность",
    limit_daily_reached: "Вы исчерпали дневной лимит {limit}. Пройдите верификацию, чтобы увеличить лимиты.",
    limit_weekly_reached: "Вы исчерпали недельный лимит {limit}. Пройдите верификацию, чтобы увеличить лимиты.",
    limit_monthly_reached: "Вы исчерпали месячный лимит {limit}. Пройдите верификацию, чтобы увеличить лимиты.",
    limit_upgrade: "",
    error_user_not_found: "Пользователь не найден.",
    error_invalid_credentials: "Неверный email или пароль.",
    error_user_exists: "Пользователь уже существует.",
    error_username_invalid: "Имя пользователя должно содержать от 3 до 20 символов (только буквы, цифры и символы подчёркивания).",
    error_username_taken: "Это имя пользователя уже занято.",
    error_username_required: "Имя пользователя обязательно.",
    error_missing_token: "Токен отсутствует.",
    error_invalid_token: "Недействительный токен.",
    error_invalid_refresh_token: "Токен обновления недействителен или истёк.",
    error_missing_fields: "Отсутствуют обязательные поля.",
    error_cannot_send_to_self: "Вы не можете отправить деньги самому себе.",
    error_source_wallet_not_found: "Исходный кошелёк не найден.",
    error_destination_wallet_not_found: "Целевой кошелёк не найден.",
    error_insufficient_funds: "Недостаточно средств.",
    error_sender_not_found: "Аккаунт отправителя не найден.",
    error_wallet_capacity_exceeded: "Целевой кошелёк превысит максимальную вместимость.",
    error_transaction_persist: "Транзакцию не удалось завершить. Пожалуйста, попробуйте снова.",
    error_wallet_not_found: "Кошелёк не найден.",
    error_recipient_not_found: "Получатель не найден.",
    error_qr_not_found: "QR-код не найден.",
    error_qr_expired: "Срок действия QR-кода истёк.",
    error_qr_used: "QR-код уже был использован.",
    error_qr_fraud: "Недействительная подпись — возможное мошенничество.",
    error_invalid_qr_format: "Недействительный формат QR.",
    error_request_not_found: "Запрос не найден.",
    error_request_processed: "Запрос уже был обработан.",
    error_card_not_found: "Карта не найдена.",
    error_card_deleted: "Эта карта была удалена.",
    error_max_cards: "Допускается не более 5 карт.",
    error_budget_not_found: "Бюджет не найден.",
    error_employer_not_found: "Аккаунт работодателя не найден.",
    error_employer_exists: "Аккаунт работодателя уже существует.",
    error_employer_not_verified: "Аккаунт работодателя не подтверждён.",
    error_insufficient_kyc: "Недостаточный уровень KYC для этой операции.",
    error_no_file_uploaded: "Файл не загружен.",
    error_csv_empty: "Файл CSV пуст.",
    error_invalid_csv: "Недействительный формат CSV.",
    error_insufficient_funds_payroll: "Недостаточно средств — деньги не были отправлены.",
    error_payroll_validation: "Ошибка проверки зарплатной ведомости — деньги не были отправлены.",
    error_employee_added: "Сотрудник уже добавлен.",
    error_worker_not_found: "Работник не найден. Им необходимо сначала зарегистрироваться.",
    error_not_linked_employer: "Вы не связаны с этим работодателем.",
    error_not_authorized_employer: "Вы не авторизованы для получения платежей от этого работодателя.",
    error_employer_unverified: "Этот аккаунт работодателя ещё не верифицирован.",
    error_employer_insufficient_balance: "У работодателя недостаточно баланса для этого запроса.",
    error_request_exceeds_limit: "Сумма запроса превышает ваш лимит {limit} {currency}.",
    error_duplicate_request: "Дублирующий запрос. У вас уже есть ожидающий запрос на эту сумму.",
    error_internal: "Произошла непредвиденная ошибка. Пожалуйста, попробуйте снова.",
    error_unauthorized: "Не авторизован.",
    error_access_denied: "Доступ запрещён.",
    error_currency_required: "Требуется настройка валюты.",
    error_too_many_accounts: "Слишком много аккаунтов создано с этого устройства. Пожалуйста, повторите попытку через 24 часа.",
    error_too_many_kyc: "Слишком много попыток верификации. Пожалуйста, повторите попытку через 1 час.",
    error_email_confirm_mismatch: "Подтверждение email не совпадает.",
    error_password_confirm_invalid: "Подтверждение пароля недействительно.",
    error_not_found: "Не найдено.",
    error_withdrawal_in_progress: "Вывод средств в этой валюте уже обрабатывается. Пожалуйста, подождите."
  },
  de: {
    greeting: "Hallo! 👋 Mein Name ist Felisa, Ihre EGWallet-Assistentin. Ich kann Ihnen helfen mit:\n\n- Transaktionsfragen\n- Kontoinformationen\n- Funktionsanleitungen\n- Support-Tickets\n\nWie kann ich Ihnen heute helfen?",
    greeting_return: "Hallo nochmal! 👋 Wie kann ich Ihnen heute helfen?",
    escalated_fraud: "Ich verstehe, dass dies sehr wichtig ist. Ich habe ein DRINGENDES Prioritäts-Ticket ({ticketId}) für unser Betrugsbekämpfungs-Sicherheitsteam erstellt.",
    escalated_security: "Ich verstehe, dass dies dringend ist. Ich habe ein DRINGENDES Prioritäts-Ticket ({ticketId}) für unser Kontosicherheitsteam erstellt.",
    escalated_legal: "Ich verstehe, dass dies sehr wichtig ist. Ich habe ein DRINGENDES Prioritäts-Ticket ({ticketId}) für unser Rechtsteam erstellt.",
    escalated_general: "Ich verstehe, dass dies wichtig ist. Ich habe ein HOCH-Prioritäts-Ticket ({ticketId}) für unser Support-Team erstellt.",
    sla_urgent: "⚡ PRIORITÄTSANTWORT: Wir werden diese Angelegenheit innerhalb von 12 Stunden untersuchen.",
    sla_high: "🔍 HOHE PRIORITÄT: Unser Team wird innerhalb von 24 Stunden antworten.",
    sla_normal: "Erwartete Antwortzeit: 24-48 Stunden",
    email_updates: "✓ Sie erhalten E-Mail-Updates zu Ihrem Ticket",
    track_status: "✓ Verfolgen Sie den Status jederzeit im Support-Bereich",
    security_email: "🛡 Für sofortige Sicherheitshilfe senden Sie auch eine E-Mail an: SUPPORT@EGWALLETFINANCE.COM",
    account_limits: "📊 Ihre Kontolimits:\n- Tageslimit: ${dailyLimit}\n- Heute verwendet: ${dailySpent}\n- Verbleibend: ${dailyRemaining}",
    get_verified: "💡 Verifizieren Sie sich, um Tageslimits von $50,000+ freizuschalten!",
    verification_pending: "⏳ Ihre Verifizierung wird überprüft. Höhere Limits kommen bald!",
    data_collection_reason: "Um dieses Problem gründlich zu untersuchen, benötige ich einige weitere Details:",
    data_collection_help: "Dies hilft uns, schneller zu ermitteln und spart Hin- und Her-Nachrichten.",
    check_ticket: "Ticket-Status prüfen",
    view_ticket: "Ticket-Details anzeigen",
    contact_support: "Support kontaktieren",
    provide_details: "Details angeben",
    skip_ticket: "Überspringen und Ticket erstellen",
    verified_status: "✓ Ihre Identität ist verifiziert!\n\nSie haben Zugriff auf:\n- $50,000+ tägliche Transaktionslimits\n- Sofortige Auszahlungen\n- Internationale Überweisungen\n- Premium-Funktionen",
    fraud_theft_alert: "Es tut mir wirklich leid, dass dies passiert ist — dies könnte eine nicht autorisierte Transaktion sein. Ich habe jetzt einen dringenden Sicherheitsfall erstellt (Ticket #{ticketId}).",
    security_lockdown_title: "🔒 SOFORTIGE SICHERHEITSMASSNAHMEN:",
    security_step_password: "1. Ändern Sie Ihr Passwort JETZT",
    security_step_2fa: "2. Aktivieren Sie die Zwei-Faktor-Authentifizierung",
    security_step_logout: "3. Melden Sie sich von allen Geräten ab",
    security_step_bank: "4. Kontaktieren Sie Ihre Bank, wenn Sie eine Karte verknüpft haben",
    security_step_otp: "5. Teilen Sie NIEMALS OTP- oder Verifizierungscodes",
    fraud_investigation_help: "Um schnell zu ermitteln, beantworten Sie bitte diese Fragen:",
    fraud_q1: "Welche Transaktion sieht nicht autorisiert aus?",
    fraud_q2: "Ungefähres Datum/Uhrzeit?",
    fraud_q3: "Haben Sie Ihr Telefon verloren oder verdächtige OTP-Aufforderungen erhalten?",
    fraud_sla: "🛡 Betrugs-/Sicherheitsfälle: Wir antworten innerhalb von 12-24 Stunden.",
    fraud_ticket_id: "Ihr Sicherheitsticket: #{ticketId}",
    transaction_pending_stop: "⚠️ Diese Transaktion ist AUSSTEHEND — wir können sie möglicherweise stoppen.",
    transaction_completed: "Diese Transaktion wurde abgeschlossen. Wir untersuchen eine mögliche Rückabwicklung.",
    multiple_suspicious: "⚠️ ALARM: Mehrere verdächtige Transaktionen erkannt — mögliche Kontoübernahme.",
    tx_latest: "Ich kann Ihnen helfen, Ihre aktuellen Transaktionen zu überprüfen. Sehen Sie sich den Transaktionsverlauf in der App an, oder ich kann ein Support-Ticket erstellen, wenn Sie eine detaillierte Untersuchung benötigen.",
    tx_latest_s1: "Transaktionen ansehen", tx_latest_s2: "Transaktionsproblem melden", tx_latest_s3: "Status prüfen",
    tx_issue: "Bei Transaktionsproblemen kann ich Ihnen helfen mit:\n\n- Prüfung des Transaktionsstatus\n- Einleitung eines Widerspruchs\n- Erstellung eines Support-Tickets zur Untersuchung\n",
    tx_issue_note: "Hinweis: Ich kann Rückerstattungen nicht direkt bearbeiten, aber unser Team kann innerhalb von {sla} ermitteln.",
    tx_issue_s1: "Widerspruch einlegen", tx_issue_s2: "Ticket erstellen", tx_issue_s3: "Transaktionsverlauf",
    tx_general: "Sie können alle Transaktionen im Transaktionsverlauf-Bildschirm einsehen. Ich kann Ihnen helfen mit:\n\n- Verstehen von Transaktionsstatus\n- Herunterladen von Quittungen\n- Probleme melden",
    tx_general_s1: "Transaktionen ansehen", tx_general_s2: "Quittung herunterladen", tx_general_s3: "Problem melden",
    balance_general: "Sie können Ihren Kontostand jederzeit in Echtzeit auf dem Wallet-Bildschirm prüfen.",
    balance_incorrect: "Wenn Sie glauben, dass Ihr Kontostand falsch ist, kann ich ein Support-Ticket zur Untersuchung erstellen.",
    balance_s1: "Kontostand ansehen", balance_s2: "Abweichung melden", balance_s3: "Geld hinzufügen",
    balance_limit_s1: "Verifizierung starten", balance_limit_s2: "Kontostand ansehen", balance_limit_s3: "Über Limits informieren", balance_limit_s4: "Status prüfen",
    card_create: "So erstellen Sie eine virtuelle Karte:\n\n1. Gehen Sie zum Karten-Tab\n2. Tippen Sie auf \"Neue Karte erstellen\"\n3. Legen Sie Ihr Ausgabenlimit fest\n4. Karte ist sofort einsatzbereit!\n\nVirtuelle Karten sind kostenlos, Sie können bis zu 5 Karten erstellen.",
    card_create_s1: "Karte erstellen", card_create_s2: "Kartenvorteile", card_create_s3: "Kartenlimits",
    card_frozen: "Wenn Ihre Karte eingefroren ist, können Sie sie im Karten-Bildschirm entsperren. Wenn Sie Betrug vermuten, empfehle ich die Erstellung eines Sicherheitstickets.",
    card_frozen_s1: "Sicherheitsticket erstellen", card_frozen_s2: "Karten ansehen", card_frozen_s3: "Hilfe beim Einfrieren/Entsperren",
    card_general: "Virtuelle Karten helfen Ihnen:\n\n- Sicher online einkaufen\n- Ausgaben pro Händler kontrollieren\n- Jederzeit kündigen ohne Auswirkungen auf Ihr Haupt-Wallet\n\nJede Karte hat ihr eigenes Limit für bessere Budgetverwaltung.",
    card_general_s1: "Karte erstellen", card_general_s2: "Karten ansehen", card_general_s3: "Kartensicherheit",
    kyc_pending_response: "⏳ Ihre Dokumente werden geprüft.\n\nWir werden Sie innerhalb von 1-2 Werktagen benachrichtigen. Vielen Dank für Ihre Geduld!\n\nAktuelles Limit: ${currentLimit}/Tag",
    kyc_pending_s1: "Status prüfen", kyc_pending_s2: "Weitere Dokumente hochladen", kyc_pending_s3: "Support kontaktieren",
    kyc_unverified: "Verifizieren Sie sich, um höhere Limits freizuschalten!\n\nVorteile:\n- Transaktionslimits von 50.000 $+\n- Sofortauszahlungen\n- Internationale Überweisungen\n",
    kyc_unverified_current: "Aktuell: ${currentLimit}/Tag\nNach Verifizierung: 50.000 $+/Tag\n\nDie Verifizierung dauert ~5 Minuten. Sie benötigen einen amtlichen Lichtbildausweis.",
    kyc_unverified_s1: "Verifizierung starten", kyc_unverified_s2: "Erforderliche Dokumente", kyc_unverified_s3: "Mehr erfahren",
    security_response: "Ihre Sicherheit hat für uns oberste Priorität! EGWallet schützt Sie mit:\n\n- Biometrischer Authentifizierung\n- Geräteverfolgung\n- Ende-zu-Ende-Verschlüsselung\n- Transaktionsbestätigungen\n- 24/7-Betrugserkennung\n\nAktivieren Sie die biometrische Sperre in den Einstellungen für zusätzlichen Schutz!",
    security_s1: "Biometrie aktivieren", security_s2: "Vertrauenswürdige Geräte", security_s3: "Sicherheitstipps",
    refund_response: "Ich verstehe, dass Sie Hilfe bei dieser Transaktion benötigen. Ich kann ein Support-Ticket für unser Zahlungsteam zur Untersuchung erstellen.\n\nBitte beachten Sie:\n- Untersuchungszeitraum: 2-3 Werktage\n- Erstattungen hängen von der Transaktionsart und unseren Richtlinien ab\n- Sie erhalten E-Mail-Updates\n\nIch kann Erstattungen nicht direkt bearbeiten, aber unser Team wird Ihren Fall prüfen.",
    refund_s1: "Ticket erstellen", refund_s2: "Widerspruch einlegen", refund_s3: "Support kontaktieren",
    help_response: "Ich bin hier, um zu helfen! Sie können:\n\n- Fragen zu Funktionen stellen\n- Transaktionsinformationen erhalten\n- Probleme melden\n- Support-Tickets erstellen\n\nUnser Hilfezentrum bietet detaillierte Anleitungen, oder ich kann Sie mit unserem Support-Team verbinden.",
    help_s1: "FAQs durchsuchen", help_s2: "Ticket erstellen", help_s3: "Funktionsleitfäden",
    fees_response: "EGWallet Gebührenstruktur:\n\n✓ Geld hinzufügen — erste 3 Aufladungen: KOSTENLOS, danach 0,5%\n✓ Senden / Empfangen: KOSTENLOS\n- Währungsumtausch: 1,15% (währungsübergreifende Überweisungen)\n- Inland-Auszahlung: 0,8%\n- Internationale Auszahlung: 1,75%\n✓ Virtuelle Karte: KOSTENLOS\n✓ Monatsabonnement: KOSTENLOS\n\nAlle Gebühren werden vor der Bestätigung angezeigt. Keine versteckten Kosten.",
    fees_s1: "Wie wird die Gebühr berechnet?", fees_s2: "Internationale Überweisungen", fees_s3: "Bei Gebühren sparen",
    dispute_response: "Ich kann Ihnen helfen, einen formellen Widerspruch einzulegen oder ein Support-Ticket zu erstellen. Unser Team wird:\n\n1. Ihren Fall innerhalb von 2-3 Werktagen prüfen\n2. Relevante Parteien kontaktieren\n3. Gründlich untersuchen\n4. Regelmäßige Updates bereitstellen\n\nHinweis: Die Untersuchungszeiträume variieren je nach Komplexität des Falls.",
    dispute_s1: "Widerspruch einlegen", dispute_s2: "Ticket erstellen", dispute_s3: "Widerspruchsprozess ansehen",
    default_response: "Ich kann Ihnen helfen mit:\n\n- Fragen zu Transaktionen und Verlauf\n- Konto- und Kontostandinformationen\n- Virtuellen Karten\n- Identitätsverifizierung\n- Sicherheitseinstellungen\n- Erstellung von Support-Tickets\n\nBei komplexen Problemen kann ich ein Support-Ticket erstellen, damit unser Team ermitteln kann.",
    default_s1: "Ticket erstellen", default_s2: "FAQs durchsuchen", default_s3: "Konto ansehen",
    typing_indicator: "Felisa tippt...",
    init_s1: "Meine Transaktion prüfen", init_s2: "Problem melden", init_s3: "Kontolimits", init_s4: "Wie sende ich Geld",
    qa_track: "Transaktion verfolgen", qa_track_q: "Status meiner letzten Transaktion prüfen",
    qa_issue: "Problem melden", qa_issue_q: "Ich möchte ein Problem melden",
    qa_card: "Virtuelle Karten", qa_card_q: "Wie erstelle ich eine virtuelle Karte?",
    qa_verify: "Identität verifizieren", qa_verify_q: "Helfen Sie mir, meine Identität zu verifizieren",
    limit_daily_reached: "Sie haben Ihr Tageslimit von {limit} erreicht. Schließen Sie die Verifizierung ab, um Ihre Limits zu erhöhen.",
    limit_weekly_reached: "Sie haben Ihr Wochenlimit von {limit} erreicht. Schließen Sie die Verifizierung ab, um Ihre Limits zu erhöhen.",
    limit_monthly_reached: "Sie haben Ihr Monatslimit von {limit} erreicht. Schließen Sie die Verifizierung ab, um Ihre Limits zu erhöhen.",
    limit_upgrade: "",
    error_user_not_found: "Benutzer nicht gefunden.",
    error_invalid_credentials: "Falsche E-Mail-Adresse oder falsches Passwort.",
    error_user_exists: "Ein Konto mit dieser E-Mail-Adresse existiert bereits.",
    error_username_invalid: "Der Benutzername muss 3–20 Zeichen lang sein (nur Buchstaben, Zahlen und Unterstriche).",
    error_username_taken: "Dieser Benutzername ist bereits vergeben.",
    error_username_required: "Benutzername ist erforderlich.",
    error_missing_token: "Authentifizierung erforderlich. Bitte melden Sie sich an.",
    error_invalid_token: "Sitzung abgelaufen. Bitte melden Sie sich erneut an.",
    error_invalid_refresh_token: "Sitzung abgelaufen. Bitte melden Sie sich erneut an.",
    error_missing_fields: "Bitte füllen Sie alle Pflichtfelder aus.",
    error_cannot_send_to_self: "Sie können kein Geld an sich selbst senden.",
    error_source_wallet_not_found: "Ihre Wallet wurde nicht gefunden.",
    error_destination_wallet_not_found: "Empfänger-Wallet nicht gefunden.",
    error_insufficient_funds: "Unzureichendes Guthaben.",
    error_sender_not_found: "Absender-Konto nicht gefunden.",
    error_wallet_capacity_exceeded: "Die Empfänger-Wallet hat ihre maximale Kapazität erreicht.",
    error_transaction_persist: "Die Transaktion konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.",
    error_wallet_not_found: "Wallet nicht gefunden.",
    error_recipient_not_found: "Empfänger nicht gefunden.",
    error_qr_not_found: "QR-Code nicht gefunden.",
    error_qr_expired: "Dieser QR-Code ist abgelaufen.",
    error_qr_used: "Dieser QR-Code wurde bereits verwendet.",
    error_qr_fraud: "Ungültige QR-Signatur — möglicher Betrug.",
    error_invalid_qr_format: "Ungültiges QR-Code-Format.",
    error_request_not_found: "Zahlungsanforderung nicht gefunden.",
    error_request_processed: "Diese Anforderung wurde bereits verarbeitet.",
    error_card_not_found: "Karte nicht gefunden.",
    error_card_deleted: "Diese Karte wurde gelöscht.",
    error_max_cards: "Sie können maximal 5 virtuelle Karten haben.",
    error_budget_not_found: "Budget nicht gefunden.",
    error_employer_not_found: "Arbeitgeberkonto nicht gefunden.",
    error_employer_exists: "Ein Arbeitgeberkonto existiert bereits.",
    error_employer_not_verified: "Das Arbeitgeberkonto wurde noch nicht verifiziert.",
    error_insufficient_kyc: "Sie müssen die KYC-Verifizierung der Stufe 2 abschließen, um sich als Arbeitgeber zu registrieren.",
    error_no_file_uploaded: "Es wurde keine Datei hochgeladen.",
    error_csv_empty: "Die CSV-Datei ist leer.",
    error_invalid_csv: "Ungültiges CSV-Format.",
    error_insufficient_funds_payroll: "Unzureichendes Guthaben — keine Zahlungen wurden gesendet.",
    error_payroll_validation: "Lohnvalidierung fehlgeschlagen — keine Zahlungen wurden gesendet.",
    error_employee_added: "Dieser Mitarbeiter wurde bereits hinzugefügt.",
    error_worker_not_found: "Mitarbeiter nicht gefunden. Er muss sich zuerst bei EGWallet registrieren.",
    error_not_linked_employer: "Sie sind nicht mit diesem Arbeitgeber verknüpft.",
    error_not_authorized_employer: "Sie müssen ein autorisierter Mitarbeiter sein, um Zahlungen von diesem Arbeitgeber anzufordern.",
    error_employer_unverified: "Dieses Arbeitgeberkonto wurde noch nicht verifiziert.",
    error_employer_insufficient_balance: "Der Arbeitgeber hat nicht genug Guthaben für diese Anfrage.",
    error_request_exceeds_limit: "Der Anfragebetrag überschreitet Ihr Limit von {limit} {currency}.",
    error_duplicate_request: "Doppelte Anfrage. Sie haben bereits eine ausstehende Anfrage für diesen Betrag.",
    error_internal: "Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.",
    error_unauthorized: "Nicht autorisiert.",
    error_access_denied: "Zugriff verweigert.",
    error_currency_required: "Währungspräferenz ist erforderlich.",
    error_too_many_accounts: "Zu viele Konten von diesem Gerät erstellt. Bitte versuchen Sie es in 24 Stunden erneut.",
    error_too_many_kyc: "Zu viele Verifizierungsversuche. Bitte versuchen Sie es in 1 Stunde erneut.",
    error_email_confirm_mismatch: "E-Mail-Bestätigung stimmt nicht überein.",
    error_password_confirm_invalid: "Passwortbestätigung ist ungültig.",
    error_not_found: "Nicht gefunden.",
    error_withdrawal_in_progress: "Eine Auszahlung in dieser Währung wird bereits verarbeitet. Bitte warten Sie."
  
  }
};

// Translation helper function
function t(key, lang = 'en', replacements = {}) {
  let text = translations[lang]?.[key] || translations.en[key] || key;
  
  // Replace placeholders like {ticketId}, ${dailyLimit}, etc.
  Object.keys(replacements).forEach(replaceKey => {
    const value = replacements[replaceKey];
    text = text.replace(new RegExp(`\\{${replaceKey}\\}`, 'g'), value);
    text = text.replace(new RegExp(`\\$\\{${replaceKey}\\}`, 'g'), typeof value === 'number' ? `$${value.toLocaleString()}` : value);
  });
  
  return text;
}

// Currency decimals map (minor units)
const currencyDecimals = {
  // Major global
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2,
  // Asia-Pacific
  CNY: 2, JPY: 0, KRW: 0, HKD: 2, SGD: 2, TWD: 2, THB: 2,
  MYR: 2, IDR: 0, PHP: 2, VND: 0, INR: 2, PKR: 2, BDT: 2,
  LKR: 2, NPR: 2, MMK: 2, KHR: 2, MNT: 2,
  // Europe
  SEK: 2, NOK: 2, DKK: 2, ISK: 0, PLN: 2, CZK: 2, HUF: 0, RON: 2,
  BGN: 2, HRK: 2, RSD: 2, UAH: 2, RUB: 2, TRY: 2, GEL: 2,
  // Middle East
  SAR: 2, AED: 2, QAR: 2, KWD: 3, BHD: 3, OMR: 3, ILS: 2, JOD: 3, IQD: 3,
  // Africa
  NGN: 2, GHS: 2, ZAR: 2, KES: 2, TZS: 2, UGX: 0, RWF: 0,
  ETB: 2, EGP: 2, TND: 3, MAD: 2, LYD: 3, DZD: 2, ERN: 2,
  AOA: 2, SOS: 2, SDG: 2, GMD: 2, MUR: 2, SCR: 2,
  BWP: 2, ZWL: 2, MZN: 2, NAD: 2, LSL: 2, SZL: 2,
  ZMW: 2, MWK: 2, GNF: 0, MGA: 0, DJF: 0, BIF: 0, KMF: 0,
  XAF: 0, XOF: 0, CVE: 2, STN: 2,
  // Americas
  BRL: 2, MXN: 2, ARS: 2, CLP: 0, COP: 2, PEN: 2, UYU: 2,
  BOB: 2, PYG: 0, GTQ: 2, HNL: 2, NIO: 2, CRC: 2, JMD: 2,
  TTD: 2, DOP: 2, BBD: 2, GYD: 2, SRD: 2,
};

// Comprehensive global country → default currency mapping
const COUNTRY_TO_CURRENCY = {
  // North America
  US: 'USD', CA: 'CAD', MX: 'MXN',
  // Europe — Euro zone
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR',
  AT: 'EUR', PT: 'EUR', FI: 'EUR', IE: 'EUR', GR: 'EUR', LU: 'EUR',
  SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', CY: 'EUR',
  MT: 'EUR', AD: 'EUR', MC: 'EUR', SM: 'EUR', VA: 'EUR', ME: 'EUR',
  XK: 'EUR', HR: 'EUR',
  // Europe — non-Euro
  GB: 'GBP', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', IS: 'ISK',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RS: 'RSD',
  UA: 'UAH', RU: 'RUB', TR: 'TRY', GE: 'GEL', AM: 'AMD', AZ: 'AZN',
  BY: 'BYN', MD: 'MDL', AL: 'ALL', MK: 'MKD', BA: 'BAM',
  // Asia-Pacific
  CN: 'CNY', JP: 'JPY', KR: 'KRW', IN: 'INR', SG: 'SGD', HK: 'HKD',
  TW: 'TWD', TH: 'THB', MY: 'MYR', ID: 'IDR', PH: 'PHP', VN: 'VND',
  PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR', MM: 'MMK', KH: 'KHR',
  LA: 'LAK', MN: 'MNT', AU: 'AUD', NZ: 'NZD', FJ: 'FJD', PG: 'PGK',
  KZ: 'KZT', UZ: 'UZS',
  // Middle East
  SA: 'SAR', AE: 'AED', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR',
  IL: 'ILS', JO: 'JOD', LB: 'LBP', IQ: 'IQD', IR: 'IRR', YE: 'YER',
  // Africa — XAF zone (Central Africa CFA)
  GQ: 'XAF', CM: 'XAF', CF: 'XAF', TD: 'XAF', CG: 'XAF', GA: 'XAF',
  // Africa — XOF zone (West Africa CFA)
  BJ: 'XOF', BF: 'XOF', CI: 'XOF', GW: 'XOF', ML: 'XOF',
  NE: 'XOF', SN: 'XOF', TG: 'XOF',
  // Africa — individual currencies
  NG: 'NGN', GH: 'GHS', ZA: 'ZAR', KE: 'KES', TZ: 'TZS',
  UG: 'UGX', RW: 'RWF', ET: 'ETB', EG: 'EGP', TN: 'TND',
  MA: 'MAD', LY: 'LYD', DZ: 'DZD', AO: 'AOA', ER: 'ERN',
  SO: 'SOS', SD: 'SDG', GM: 'GMD', MU: 'MUR', SC: 'SCR',
  BW: 'BWP', ZW: 'ZWL', MZ: 'MZN', NA: 'NAD', LS: 'LSL', SZ: 'SZL',
  ZM: 'ZMW', MW: 'MWK', LR: 'LRD', SL: 'SLL', GN: 'GNF',
  MG: 'MGA', MR: 'MRU', SS: 'SSP', CV: 'CVE', ST: 'STN',
  KM: 'KMF', DJ: 'DJF', BI: 'BIF',
  // South America
  BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU',
  BO: 'BOB', PY: 'PYG', GY: 'GYD', SR: 'SRD', VE: 'VES',
  // Central America & Caribbean
  GT: 'GTQ', HN: 'HNL', NI: 'NIO', CR: 'CRC', BZ: 'BZD',
  JM: 'JMD', TT: 'TTD', DO: 'DOP', BB: 'BBD', HT: 'HTG',
  PA: 'USD', EC: 'USD', SV: 'USD', PR: 'USD',
};

function decimalsFor(currency) {
  const d = currencyDecimals[currency];
  return d !== undefined ? d : 2;
}

function minorToMajor(amountMinor, currency) {
  const d = decimalsFor(currency);
  return amountMinor / Math.pow(10, d);
}

function majorToMinor(amountMajor, currency) {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * Math.pow(10, d));
}

// Safety guard: ensure FX-converted amounts are finite and non-negative.
// Returns {safe: true} or {safe: false, reason: string}.
function fxSafetyCheck(receivedMinor, toCurrency) {
  if (!Number.isFinite(receivedMinor) || receivedMinor < 0) {
    return { safe: false, reason: `FX result for ${toCurrency} is not a finite non-negative number: ${receivedMinor}` };
  }
  return { safe: true };
}

// Sanitize withdrawal accountNumber for API responses.
// Returns the pre-computed accountMask ("****1234") when present (new records).
// For legacy records without accountMask: card methods return last4, bank returns as-is.
// Never returns raw ciphertext — if the field is encrypted and no mask exists, returns null.
function safeWithdrawalAccountNumber(w) {
  if (w.accountMask) return w.accountMask;
  if (!w.accountNumber) return null;
  if (isEncrypted(w.accountNumber)) return null; // encrypted without mask — migration pending
  if (w.method === 'debit' || w.method === 'credit') {
    return String(w.accountNumber).replace(/\D/g, '').slice(-4) || null;
  }
  return w.accountNumber; // legacy plaintext bank account (migration will encrypt it)
}

/**
 * Return a response-safe copy of a withdrawal record.
 * PII fields are masked or omitted — ciphertext is never returned to API callers.
 * bankNameDisplay and accountMask are the safe display copies set at creation time.
 */
function sanitizeWithdrawalForResponse(w) {
  return {
    ...w,
    accountNumber:     safeWithdrawalAccountNumber(w),
    bankName:          w.bankNameDisplay || null,  // plaintext display copy
    accountHolderName: null,                        // personal name — not returned in responses
    iban:              null,                        // encrypted — not returned in responses
    swiftBic:          null,                        // encrypted — not returned in responses
  };
}

function emptyDB() {
  return {
    users: [], wallets: [], transactions: [], paymentRequests: [],
    virtualCards: [], budgets: [], devices: [], supportTickets: [],
    fraudAlerts: [], savedContacts: [], qrCodes: [], refreshTokens: [],
    auditLog: [], employers: [], employerEmployees: [], payrollBatches: [],
    demoIntents: [], notifications: [], passwordResetTokens: [],
    idempotencyRecords: [], withdrawals: [], ledger: [], kycIdentityClaims: {},
    payoutLocks: [],
    rates: {
      base: 'USD',
      values: {
        USD: 1, EUR: 0.93, GBP: 0.79, CHF: 0.90, CAD: 1.35,
        AUD: 1.52, NZD: 1.63,
        CNY: 7.25, JPY: 149, KRW: 1340, HKD: 7.82, SGD: 1.34,
        TWD: 31, THB: 34, MYR: 4.65, IDR: 15600, PHP: 56,
        VND: 24500, INR: 83, PKR: 278, BDT: 110, LKR: 320,
        SEK: 10.5, NOK: 10.7, DKK: 6.89, PLN: 3.95, CZK: 22.7,
        HUF: 360, RON: 4.62, RUB: 90, TRY: 32, UAH: 37,
        SAR: 3.75, AED: 3.67, QAR: 3.64, KWD: 0.31, BHD: 0.38,
        OMR: 0.38, ILS: 3.71,
        BRL: 5.2, MXN: 17, ARS: 850, CLP: 910, COP: 3900, PEN: 3.7,
        NGN: 1540, GHS: 12, XAF: 600, XOF: 600, ZAR: 19,
        KES: 130, TZS: 2650, UGX: 3800, RWF: 1300, ETB: 52,
        EGP: 50, TND: 3.1, MAD: 10, LYD: 4.8, DZD: 135,
        BWP: 14, ZWL: 360, MZN: 65, NAD: 19, LSL: 19,
        ERN: 15, AOA: 835, SOS: 570, SDG: 550, GMD: 65,
        MUR: 45, SCR: 13, ZMW: 25, MWK: 1700, GNF: 8600,
        SLE: 22, CDF: 2800, CVE: 103, HTG: 132,
      },
      updatedAt: Date.now(),
    },
  };
}

function loadDB() {
  // Fresh install or new volume mount — db.json does not exist yet.
  // This is NOT corruption; create the directory and seed an empty database.
  if (!fs.existsSync(DB_FILE)) {
    const dbDir = path.dirname(DB_FILE);
    try { fs.mkdirSync(dbDir, { recursive: true }); } catch (_) {}
    const fresh = emptyDB();
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), 'utf8');
      console.log('[loadDB] db.json not found — created fresh database at', DB_FILE);
    } catch (writeErr) {
      console.error('[loadDB] Could not write initial db.json:', writeErr.message,
        '— running in-memory only until disk is writable.');
    }
    return fresh;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);
    // Migration: ensure all required collections exist (handles older db.json files)
    if (!db.paymentRequests) db.paymentRequests = [];
    if (!db.virtualCards) db.virtualCards = [];
    if (!db.budgets) db.budgets = [];
    if (!db.devices) db.devices = [];
    if (!db.supportTickets) db.supportTickets = [];
    if (!db.fraudAlerts) db.fraudAlerts = [];
    if (!db.savedContacts) db.savedContacts = [];
    if (!db.qrCodes) db.qrCodes = [];
    if (!db.refreshTokens) db.refreshTokens = [];
    if (!db.auditLog) db.auditLog = [];
    if (!db.employers) db.employers = [];
    if (!db.employerEmployees) db.employerEmployees = [];
    if (!db.payrollBatches) db.payrollBatches = [];
    if (!db.demoIntents) db.demoIntents = [];
    if (!db.notifications) db.notifications = [];
    if (!db.passwordResetTokens) db.passwordResetTokens = [];
    // Core money-path collections — must exist before any deposit/withdrawal handler runs.
    if (!db.transactions)       db.transactions       = [];
    if (!db.withdrawals)        db.withdrawals        = [];
    if (!db.ledger)             db.ledger             = [];
    if (!db.idempotencyRecords) db.idempotencyRecords = [];
    // Persistent KYC identity claims: { [kycIdHash]: { userId, status, claimedAt, updatedAt } }
    // Authoritative dedup source — survives rejection/error without clearing hash.
    if (!db.kycIdentityClaims) db.kycIdentityClaims = {};
    // Advisory payout locks — TTL-keyed, cleaned on load and at startup sweep.
    if (!db.payoutLocks) db.payoutLocks = [];
    return db;
  } catch (e) {
    // Never overwrite a potentially-recoverable corrupt file with an empty database.
    // Quarantine it, attempt backup restore, and fail safely.
    const corruptPath = DB_FILE + '.corrupt.' + Date.now();
    try { fs.renameSync(DB_FILE, corruptPath); } catch (_) { /* rename failed — disk issue */ }
    console.error('[loadDB] db.json failed to parse — quarantined to', corruptPath, e.message);

    // Attempt to restore from the last known-good backup.
    if (fs.existsSync(DB_BACKUP)) {
      try {
        const backupRaw = fs.readFileSync(DB_BACKUP, 'utf8');
        const backupDb  = JSON.parse(backupRaw);
        // Copy backup over so subsequent loadDB calls (and saveDB) use the restored file.
        fs.copyFileSync(DB_BACKUP, DB_FILE);
        console.warn('[loadDB] Restored db.json from backup');
        // Apply the same migrations as the happy path above.
        if (!backupDb.paymentRequests)   backupDb.paymentRequests   = [];
        if (!backupDb.virtualCards)      backupDb.virtualCards      = [];
        if (!backupDb.budgets)           backupDb.budgets           = [];
        if (!backupDb.devices)           backupDb.devices           = [];
        if (!backupDb.supportTickets)    backupDb.supportTickets    = [];
        if (!backupDb.fraudAlerts)       backupDb.fraudAlerts       = [];
        if (!backupDb.savedContacts)     backupDb.savedContacts     = [];
        if (!backupDb.qrCodes)           backupDb.qrCodes           = [];
        if (!backupDb.refreshTokens)     backupDb.refreshTokens     = [];
        if (!backupDb.auditLog)          backupDb.auditLog          = [];
        if (!backupDb.employers)         backupDb.employers         = [];
        if (!backupDb.employerEmployees) backupDb.employerEmployees = [];
        if (!backupDb.payrollBatches)    backupDb.payrollBatches    = [];
        if (!backupDb.demoIntents)       backupDb.demoIntents       = [];
        if (!backupDb.notifications)     backupDb.notifications     = [];
        if (!backupDb.passwordResetTokens) backupDb.passwordResetTokens = [];
        if (!backupDb.idempotencyRecords)  backupDb.idempotencyRecords  = [];
        if (!backupDb.withdrawals)         backupDb.withdrawals         = [];
        if (!backupDb.transactions)        backupDb.transactions        = [];
        if (!backupDb.ledger)              backupDb.ledger              = [];
        if (!backupDb.kycIdentityClaims)   backupDb.kycIdentityClaims   = {};
        if (!backupDb.payoutLocks)         backupDb.payoutLocks         = [];
        return backupDb;
      } catch (backupErr) {
        console.error('[loadDB] Backup restore also failed', backupErr.message);
      }
    }

    // No recovery possible.
    if (process.env.NODE_ENV === 'production') {
      console.error('[loadDB] FATAL: db.json is corrupt and backup restore failed. Refusing to continue with empty database.');
      process.exit(1);
    }

    // Dev/staging only — return empty database in-memory without writing to disk.
    // The file was quarantined above; let the operator decide what to restore.
    console.warn('[loadDB] Dev mode: returning empty in-memory database (no disk write).');
    return emptyDB();
  }
}

function saveDB(db, { skipVersionCheck = false } = {}) {
  // Create backup before saving.
  // In production a backup failure is fatal — proceeding without it risks
  // permanent data loss if the subsequent write fails or is interrupted.
  if (fs.existsSync(DB_FILE)) {
    try {
      fs.copyFileSync(DB_FILE, DB_BACKUP);
    } catch (err) {
      if (NODE_ENV === 'production') {
        logger.error('FATAL: db.json backup failed — aborting save to prevent unrecoverable data loss', {
          error: err.message,
        });
        throw new Error('BACKUP_FAILED');
      }
      logger.warn('Failed to create backup (non-production — continuing)', { error: err.message });
    }
  }
  // Multi-instance collision guard.
  // Re-read _dbVersion from disk; if it has advanced since loadDB() was called,
  // another process wrote to the file while we held our in-memory copy.
  // We refuse to overwrite silently and throw so the route handler can return 503.
  // Pass skipVersionCheck:true for async payout jobs that run outside the mutex.
  if (!skipVersionCheck && fs.existsSync(DB_FILE)) {
    try {
      const onDisk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if ((onDisk._dbVersion || 0) !== (db._dbVersion || 0)) {
        logger.error('FATAL: db.json _dbVersion conflict — multi-instance write collision', {
          expected: db._dbVersion, actual: onDisk._dbVersion,
        });
        throw new Error('DB_VERSION_CONFLICT');
      }
    } catch (e) {
      if (e.message === 'DB_VERSION_CONFLICT') throw e;
      // I/O error or JSON parse failure — we cannot confirm the on-disk version is safe
      // to overwrite.  Fail closed: throw so the caller gets a retryable error rather
      // than silently clobbering a potentially newer version written by another process.
      logger.error('saveDB: version check unverifiable — aborting write to prevent data loss', {
        error: e.message,
      });
      throw new Error(`DB_VERSION_UNVERIFIABLE: ${e.message}`);
    }
  }
  db._dbVersion = (db._dbVersion || 0) + 1;
  // Atomic write: write to a temp file then rename so a mid-write crash cannot
  // corrupt the live db.json. fs.renameSync on the same filesystem is an atomic
  // directory-entry swap on both Linux and Windows (NTFS MoveFileEx w/ replace).
  const DB_TMP = DB_FILE + '.tmp';
  fs.writeFileSync(DB_TMP, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(DB_TMP, DB_FILE);
  logger.debug('Database saved', { timestamp: Date.now(), version: db._dbVersion });
}

// ==================== LIVE FX RATE REFRESH ====================
// Uses open.er-api.com (free, no API key required, updates every hour)
// Falls back gracefully to seeded rates if the request fails.
async function fetchLiveRates() {
  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 10000 });
    const liveRates = response.data && response.data.rates;
    if (!liveRates || Object.keys(liveRates).length < 20) throw new Error('Unexpected response shape');

    const db = loadDB();
    // Merge: start with existing rates (keeps currencies not in the free API like XAF/XOF)
    // then overlay with live data so real currencies are always fresh.
    const merged = { ...db.rates.values, ...liveRates };
    // Force USD = 1 as the base
    merged.USD = 1;
    // Re-derive CFA franc currencies from live EUR rate (fixed peg: 1 EUR = 655.957 XAF/XOF)
    // open.er-api.com free plan may not include these; this ensures they are always current.
    if (merged.EUR) {
      merged.XAF = merged.EUR * 655.957;
      merged.XOF = merged.EUR * 655.957;
    }
    db.rates = { base: 'USD', values: merged, updatedAt: Date.now(), source: 'open.er-api.com' };
    saveDB(db);
    logger.info(`[FX] Live rates refreshed — ${Object.keys(liveRates).length} currencies`);
  } catch (err) {
    logger.warn('[FX] Rate refresh failed — using cached rates', { error: err.message });
  }
}

// Refresh on startup (async, non-blocking) and every hour (open.er-api.com updates hourly)
fetchLiveRates();
setInterval(fetchLiveRates, 60 * 60 * 1000);

// Rates older than 25 hours are treated as stale — flagged in quote/exchange responses
const FX_STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000;

// ==================== EXPRESS APP INITIALIZATION ====================

const app = express();

// Trust Railway's reverse proxy so express-rate-limit gets the real client IP
app.set('trust proxy', 1);

// Health check MUST be first — before any middleware (CORS, Helmet, rate-limit)
// so Railway's healthcheck always gets 200 and never gets blocked
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/health-simple', (req, res) => res.status(200).json({ status: 'ok', port: PORT }));

// ==================== SECURITY MIDDLEWARE ====================

// Helmet - Security headers
if (process.env.ENABLE_HELMET !== 'false') {
  app.use(helmet({
    contentSecurityPolicy: process.env.ENABLE_STRICT_CSP === 'true' ? undefined : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));
}

// CORS - Restrict origins in production
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin || NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked origin', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Idempotency-Key', 'Accept-Language']
};

app.use(cors(corsOptions));

// ── Provider webhook endpoints ─────────────────────────────────────────────────
// MUST be registered BEFORE app.use(express.json(...)) so Stripe's raw-body
// signature verification runs before the global JSON parser consumes the stream.

// ─── POST /webhooks/stripe ──────────────────────────────────────────────────
// Receives signed Stripe payout events (payout.paid / payout.failed / payout.canceled).
// STRIPE_WEBHOOK_SECRET must be set to the secret from your Stripe dashboard.
app.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || !stripeClient) {
      logger.warn('[webhook/stripe] STRIPE_WEBHOOK_SECRET or stripeClient not configured');
      return res.status(503).json({ error: 'Webhook endpoint not configured — provider should retry' });
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.warn('[webhook/stripe] Signature verification failed', { error: err.message });
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

    // ── payment_intent.succeeded — deposit settlement fallback ───────────────
    // Credits the wallet from intent metadata if /deposits/confirm was never
    // called (network failure, app killed after PaymentSheet completed, etc.).
    // Uses the same stripeIntentId idempotency guard as /deposits/confirm so
    // double-credit is impossible regardless of which path fires first.
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      // Defense-in-depth: reject test-mode events in production.
      // The startup guard already blocks sk_test_ keys, but this catches events
      // delivered after a key rotation or from misconfigured Stripe dashboard webhooks.
      if (NODE_ENV === 'production' && event.livemode === false) {
        logger.warn('[webhook/stripe] Ignoring test-mode payment_intent.succeeded in production',
          { intentId: intent.id });
        return res.json({ received: true });
      }
      const { userId: intentUserId, walletId: intentWalletId,
              netCredited: netCreditedStr, feeAmount: feeAmountStr,
              feeRate: feeRateStr } = intent.metadata || {};
      if (!intentUserId || !intentWalletId) {
        logger.warn('[webhook/stripe] payment_intent.succeeded missing metadata', { intentId: intent.id });
        return res.json({ received: true });
      }
      try {
        await withBalanceMutex(async () => {
          const db = loadDB();
          // Idempotency — already credited by /deposits/confirm or a prior webhook delivery?
          if ((db.transactions || []).some(tx => tx.stripeIntentId === intent.id)) {
            logger.info('[webhook/stripe] payment_intent.succeeded already credited — idempotent', { intentId: intent.id });
            return;
          }
          const wallet = (db.wallets || []).find(
            w => w.id === intentWalletId && w.userId === intentUserId
          );
          if (!wallet) {
            logger.error('[webhook/stripe] Wallet not found for payment_intent.succeeded',
              { intentId: intent.id, intentUserId, intentWalletId });
            throw new Error('Wallet not found');
          }
          const netCredited = Number(netCreditedStr) || intent.amount;
          const feeAmount   = Number(feeAmountStr)   || 0;
          const feeRate     = Number(feeRateStr)     || 0;
          const currency    = (intent.currency || '').toUpperCase();
          let balance = wallet.balances.find(b => b.currency === currency);
          if (!balance) { balance = { currency, amount: 0 }; wallet.balances.push(balance); }
          balance.amount += netCredited;
          db.transactions.push({
            id: uuidv4(),
            type: 'deposit',
            fromWalletId: null,
            toWalletId: intentWalletId,
            amount: netCredited,
            currency,
            receivedAmount: netCredited,
            receivedCurrency: currency,
            wasConverted: false,
            feeAmount,
            feeRate,
            grossAmount: netCredited + feeAmount,
            status: 'completed',
            timestamp: Date.now(),
            memo: 'Deposit via Stripe (webhook settlement)',
            direction: 'in',
            stripeIntentId: intent.id,
          });
          saveDB(db);
          logger.info('[webhook/stripe] payment_intent.succeeded — wallet credited via webhook',
            { intentId: intent.id, intentUserId, intentWalletId, netCredited, currency });
        });
        return res.json({ received: true });
      } catch (err) {
        logger.error('[webhook/stripe] payment_intent.succeeded processing error',
          { intentId: intent.id, error: err.message });
        return res.status(500).json({ error: 'Processing failed' });
      }
    }

    const STRIPE_PAYOUT_EVENTS = new Set(['payout.paid', 'payout.failed', 'payout.canceled']);
    if (!STRIPE_PAYOUT_EVENTS.has(event.type)) return res.json({ received: true });

    const payout       = event.data.object;
    const withdrawalId = payout.metadata?.withdrawalId;
    if (!withdrawalId) {
      logger.warn('[webhook/stripe] Payout event missing withdrawalId metadata', { payoutId: payout.id });
      return res.json({ received: true });
    }

    try {
      await withBalanceMutex(async () => {
        const db = loadDB();
        const w  = (db.withdrawals || []).find(x => x.id === withdrawalId);
        if (!w || w.status !== 'processing') return; // already resolved — idempotent
        if (event.type === 'payout.paid') {
          markWithdrawalPaid(db, withdrawalId, payout.id, 'stripe');
          logger.info('[webhook/stripe] Marked paid', { withdrawalId, payoutId: payout.id });
        } else {
          // C-2: If a disbursement was already initiated, do not auto-refund on an out-of-order
          // failure event — the provider may still settle.  Leave processing for admin reconcile.
          if (w.payoutReference || w.payoutDispatchRef) {
            w.reconcileRequired = true;
            saveDB(db);
            logger.warn('[webhook/stripe] Failure event on active disbursement — leaving processing for reconcile',
              { withdrawalId, payoutId: payout.id, status: payout.status });
            return;
          }
          markWithdrawalFailed(db, withdrawalId,
            `Stripe webhook: payout ${payout.status} (${payout.id})`);
          logger.info('[webhook/stripe] Marked failed', { withdrawalId, payoutId: payout.id, status: payout.status });
        }
        saveDB(db);
      });
      res.json({ received: true });
    } catch (err) {
      logger.error('[webhook/stripe] Processing error', { withdrawalId, error: err.message });
      res.status(500).json({ error: 'Processing failed' });
    }
  }
);

// ─── POST /webhooks/kora ────────────────────────────────────────────────────
// Receives signed Kora disbursement events.
// KORA_WEBHOOK_SECRET must be set to the HMAC-SHA256 secret from Kora dashboard.
// Kora signs with: x-korapay-signature = HMAC-SHA256(secret, <raw-body-bytes>)
// We use express.raw to capture the raw body before any JSON parsing so the HMAC
// is computed over the exact bytes Kora signed — re-serialising parsed JSON can
// produce different whitespace/key order and will always fail timingSafeEqual.
app.post('/webhooks/kora',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const webhookSecret = process.env.KORA_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.warn('[webhook/kora] KORA_WEBHOOK_SECRET not configured');
      return res.status(503).json({ error: 'Webhook endpoint not configured — provider should retry' });
    }
    const sig = req.headers['x-korapay-signature'];
    const expected = crypto.createHmac('sha256', webhookSecret)
      .update(req.body)   // req.body is a raw Buffer — matches Kora's signed bytes exactly
      .digest('hex');
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(sig || '', 'hex'),
        Buffer.from(expected,    'hex')
      );
    } catch (_) { /* length mismatch → not equal */ }
    if (!valid) {
      logger.warn('[webhook/kora] Signature verification failed');
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

    // Parse JSON only after signature is verified
    let koraBody;
    try {
      koraBody = JSON.parse(req.body.toString('utf8'));
    } catch (_e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const data      = koraBody?.data || {};
    const reference = data.reference || data.transaction_reference;
    if (!reference || !reference.startsWith('egw-')) return res.json({ received: true });

    const withdrawalId  = reference.replace(/^egw-/, '');
    const status        = (data.status || '').toLowerCase();
    const KORA_SETTLED  = new Set(['success', 'completed']);
    const KORA_FAILED   = new Set(['failed', 'reversed', 'cancelled']);
    if (!KORA_SETTLED.has(status) && !KORA_FAILED.has(status)) {
      // Pending/processing — not terminal, nothing to persist yet.
      return res.json({ received: true });
    }

    const koraRef = data.transaction_reference || reference;
    try {
      await withBalanceMutex(async () => {
        const db = loadDB();
        const w  = (db.withdrawals || []).find(x => x.id === withdrawalId);
        if (!w || w.status !== 'processing') return; // already resolved — idempotent
        if (KORA_SETTLED.has(status)) {
          markWithdrawalPaid(db, withdrawalId, koraRef, 'kora');
          logger.info('[webhook/kora] Marked paid', { withdrawalId, koraRef, status });
        } else {
          // C-2: If a disbursement was already initiated, do not auto-refund on an out-of-order
          // failure event — the provider may still settle.  Leave processing for admin reconcile.
          if (w.payoutReference || w.payoutDispatchRef) {
            w.reconcileRequired = true;
            saveDB(db);
            logger.warn('[webhook/kora] Failure event on active disbursement — leaving processing for reconcile',
              { withdrawalId, koraRef, status });
            return;
          }
          markWithdrawalFailed(db, withdrawalId,
            `Kora webhook: status=${status} ref=${koraRef}`);
          logger.info('[webhook/kora] Marked failed', { withdrawalId, koraRef, status });
        }
        saveDB(db);
      });
      res.json({ received: true });
    } catch (err) {
      logger.error('[webhook/kora] Processing error', { withdrawalId, error: err.message });
      res.status(500).json({ error: 'Processing failed' });
    }
  }
);

app.use(express.json({ limit: '100kb' }));

// Expose shared utilities to routers (adminWithdrawals.js uses these)
app.locals.loadDB = loadDB;
app.locals.saveDB = saveDB;
app.locals.logger = logger;
app.locals.withBalanceMutex = withBalanceMutex;
app.locals.executePayout = executePayout;

// IP tracking middleware
app.use((req, res, next) => {
  req.clientIP = getClientIP(req);
  next();
});

// Language middleware — read Accept-Language header, validate against supported langs
const SUPPORTED_LANGS = ['en', 'es', 'fr', 'pt', 'zh', 'ja', 'ru', 'de'];
app.use((req, res, next) => {
  const header = (req.headers['accept-language'] || 'en').toLowerCase().trim();
  const lang = SUPPORTED_LANGS.find(l => header.startsWith(l)) || 'en';
  req.lang = lang;
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.clientIP,
      userAgent: req.headers['user-agent']
    });
  });
  next();
});

// ==================== RATE LIMITING ====================

// General API rate limit
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.clientIP, path: req.path });
    res.status(429).json({ 
      error: 'Too many requests',
      message: 'Please try again later.',
      retryAfter: 60
    });
  }
});

// Auth endpoints rate limit (stricter) — for login/refresh: only failed attempts count
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT) || 5,
  message: 'Too many authentication attempts, please try again later.',
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', { ip: req.clientIP });
    res.status(429).json({ 
      error: 'Too many login attempts',
      message: 'Please try again in 15 minutes.',
      retryAfter: 900
    });
  }
});

// Registration rate limit — every successful registration counts so Sybil
// account creation cannot inflate per-account KYC tier quotas.
// skipSuccessfulRequests is intentionally false here.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,                              // 1-hour sliding window
  max: parseInt(process.env.REGISTER_RATE_LIMIT) || 5,   // 5 new accounts per IP per hour
  skipSuccessfulRequests: false,                          // successful registrations must count
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Registration rate limit exceeded', { ip: req.clientIP });
    res.status(429).json({
      error: 'Too many accounts created from this device or network. Please try again later.',
      retryAfter: 3600,
    });
  },
});

// AI Chat rate limit (prevent abuse)
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.AI_CHAT_RATE_LIMIT) || 10,
  message: 'Too many AI chat requests, please slow down.',
  handler: (req, res) => {
    logger.warn('AI chat rate limit exceeded', { 
      ip: req.clientIP, 
      userId: req.user?.userId 
    });
    res.status(429).json({ 
      error: 'Too many requests',
      message: 'Please wait a moment before sending another message.',
      retryAfter: 60
    });
  }
});

// Apply general limiter to all routes
app.use(generalLimiter);

// ==================== HEALTH CHECK ENDPOINTS ====================

app.get('/health', (req, res) => {
  const db = loadDB();
  const healthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    gitCommit: process.env.GIT_COMMIT || process.env.RAILWAY_GIT_COMMIT_SHA || null,
    allowDemoDeposits: ALLOW_DEMO_DEPOSITS,
    stripeConfigured: !!stripeClient,
    database: fs.existsSync(DB_FILE) ? 'connected' : 'missing',
    users: db.users?.length || 0,
    tickets: db.supportTickets?.length || 0,
    freshdeskConfigured: !!(FRESHDESK_DOMAIN && FRESHDESK_API_KEY)
  };
  res.status(200).json(healthStatus);
});

// Firebase connectivity health check
app.get('/firebase/health', async (req, res) => {
  if (!firebaseAdmin) {
    return res.status(503).json({
      status: 'unavailable',
      message: 'Firebase Admin SDK is not initialized. Check server logs for credential errors.',
    });
  }

  const services = {};

  // Test Firebase Auth
  try {
    await firebaseAuth.listUsers(1);
    services.auth = 'ok';
  } catch (err) {
    services.auth = err.code === 'auth/configuration-not-found' || err.message.includes('Identity Toolkit API')
      ? 'disabled — enable Firebase Authentication in the Firebase Console'
      : `error: ${err.message}`;
  }

  // Test Firestore
  if (firestore) {
    try {
      await firestore.collection('_health').limit(1).get();
      services.firestore = 'ok';
    } catch (err) {
      services.firestore = err.message.includes('Cloud Firestore API has not been used') || err.message.includes('PERMISSION_DENIED')
        ? 'disabled — enable Cloud Firestore in the Firebase Console'
        : `error: ${err.message}`;
    }
  } else {
    services.firestore = 'not initialized';
  }

  const allOk = Object.values(services).every(v => v === 'ok');
  res.status(allOk ? 200 : 207).json({
    status: allOk ? 'ok' : 'partial',
    firebase: 'connected',
    project: firebaseProjectId,
    services,
  });
});

// ==================== AUTHENTICATION MIDDLEWARE ====================

function findUserByEmail(db, email) {
  return db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    logger.warn('Missing auth token', { ip: req.clientIP, path: req.path });
    return res.status(401).json({ error: t('error_missing_token', req.headers['accept-language'] || 'en') });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'access') {
      logger.warn('Non-access token used as bearer', { type: payload.type, ip: req.clientIP, path: req.path });
      return res.status(401).json({ error: t('error_invalid_token', req.headers['accept-language'] || 'en') });
    }

    // C2: Reject deleted accounts. C3: Reject tokens superseded by password reset.
    const db = loadDB();
    const authedUser = db.users.find(u => u.id === payload.userId);
    if (!authedUser || authedUser.status === 'deleted') {
      logger.warn('Auth rejected — account deleted', { userId: payload.userId, ip: req.clientIP, path: req.path });
      return res.status(401).json({ error: t('error_invalid_token', req.headers['accept-language'] || 'en') });
    }
    if ((authedUser.tokenVersion || 0) !== (payload.tokenVersion || 0)) {
      logger.warn('Auth rejected — tokenVersion mismatch (post-reset)', { userId: payload.userId, ip: req.clientIP, path: req.path });
      return res.status(401).json({ error: t('error_invalid_token', req.headers['accept-language'] || 'en') });
    }

    req.user = payload;
    next();
  } catch (e) {
    logger.warn('Invalid token', { error: e.message, ip: req.clientIP });
    return res.status(401).json({ error: t('error_invalid_token', req.headers['accept-language'] || 'en') });
  }
}

// Admin-only middleware — must be chained after authMiddleware
function adminMiddleware(req, res, next) {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user || user.role !== 'admin') {
    logger.warn('Admin access denied', { userId: req.user.userId, path: req.path, ip: req.clientIP });
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Fields whose submitted values must never appear in logs or API responses.
const SENSITIVE_FIELDS = new Set([
  'password', 'passwordConfirm', 'currentPassword', 'newPassword',
]);
const redactValidationErrors = errs =>
  errs.map(e => SENSITIVE_FIELDS.has(e.path) ? { ...e, value: '[REDACTED]' } : e);

// Input validation middleware
function validateInput(validations) {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const safeErrors = redactValidationErrors(errors.array());
      logger.warn('Input validation failed', { errors: safeErrors, ip: req.clientIP });
      return res.status(400).json({ error: 'Validation failed', details: safeErrors });
    }
    next();
  };
}

// ==================== AUTHENTICATION ENDPOINTS ====================

// Auth
app.post('/auth/register', 
  registerLimiter,
  validateInput([
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ]),
  (req, res) => {
  const db = loadDB();
  const { email, password, region, deviceInfo, username } = req.body;
  const lang = req.lang || 'en';

  // Require a non-empty x-device-id header.
  // Without it, the per-device signup tracker (below) is skipped and an attacker
  // can create unlimited accounts from a single device, bypassing KYC tier limits.
  const rawDeviceId = req.headers['x-device-id'];
  if (!rawDeviceId || typeof rawDeviceId !== 'string' || !rawDeviceId.trim()) {
    return res.status(400).json({ error: 'x-device-id header is required for registration' });
  }

  if (!email || !password) return res.status(400).json({ error: t('error_missing_fields', lang) });
  if (findUserByEmail(db, email)) return res.status(400).json({ error: t('error_user_exists', lang) });

  // Optional username — validate format and uniqueness
  let normalizedUsername = null;
  if (username) {
    normalizedUsername = username.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(normalizedUsername)) {
      return res.status(400).json({ error: t('error_username_invalid', lang) });
    }
    if ((db.users || []).some(u => u.username === normalizedUsername)) {
      return res.status(400).json({ error: t('error_username_taken', lang) });
    }
  }

  // ==================== DEVICE BINDING CHECKS ====================
  // Read canonical device ID from header (preferred) or fall back to body fingerprint
  const deviceId = (req.headers['x-device-id'] && typeof req.headers['x-device-id'] === 'string')
    ? req.headers['x-device-id'].trim()
    : (deviceInfo?.fingerprint || null);

  const riskFlags = [];
  let forceUnverifiedDevice = false;

  if (deviceId) {
    const now = Date.now();

    // --- Rate limit: max 3 signups per device per 24h (persistent) ---
    if (!db.device_signup_tracker) db.device_signup_tracker = [];
    let trackerRec = db.device_signup_tracker.find(r => r.deviceId === deviceId);
    const recentSignups = trackerRec
      ? trackerRec.timestamps.filter(ts => now - ts < DEVICE_SIGNUP_WINDOW_MS)
      : [];
    if (recentSignups.length >= DEVICE_SIGNUP_LIMIT) {
      logger.warn('Device signup rate limit exceeded', { deviceId, ip: req.clientIP });
      return res.status(429).json({
        error: t('error_too_many_accounts', lang),
      });
    }
    recentSignups.push(now);
    if (trackerRec) {
      trackerRec.timestamps = recentSignups;
      trackerRec.updatedAt  = now;
    } else {
      db.device_signup_tracker.push({ deviceId, timestamps: recentSignups, updatedAt: now });
    }
    // Note: saveDB is called later after the user record is fully built — no extra write needed here.

    // --- Multiple accounts on same device ---
    const existingOnDevice = (db.users || []).filter(u => u.deviceId === deviceId);
    if (existingOnDevice.length > 0) {
      riskFlags.push('multiple_accounts_same_device');
      // If any existing account is KYC-verified, keep the new one unverified
      const hasVerified = existingOnDevice.some(u => (u.kycTier || 0) >= 1 || u.kycStatus === 'approved');
      if (hasVerified) {
        riskFlags.push('device_has_verified_account');
        forceUnverifiedDevice = true;
      }
    }

    // Log for audit trail
    logger.info('Signup device binding', {
      deviceId,
      ip: req.clientIP,
      timestamp: new Date().toISOString(),
      riskFlags,
      forceUnverifiedDevice,
    });
  }
  // ============================================================

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 12);

  // Auto-detect preferred currency using the global country→currency map
  const preferredCurrency = COUNTRY_TO_CURRENCY[region] || 'USD';

  const user = { 
    id, 
    email, 
    username: normalizedUsername,
    region: region || 'US', 
    role: 'individual',
    preferredCurrency, 
    autoConvertIncoming: true, 
    createdAt: Date.now(),
    kycTier: 0,
    kycStatus: 'pending',
    kycDocuments: {},
    deviceId: deviceId || null,
    riskFlags: riskFlags.length > 0 ? riskFlags : undefined,
    kycDeviceBlocked: forceUnverifiedDevice || undefined,
    dailySpent: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
    limitTracking: {
      dailyUsedUSD:   0,
      weeklyUsedUSD:  0,
      monthlyUsedUSD: 0,
      dayKey:   new Date().toISOString().slice(0, 10),
      weekKey:  getWeekKey(),
      monthKey: new Date().toISOString().slice(0, 7),
    },
    linkedEmployers: [],
    tokenVersion: 0,
  };
  db.users.push({ ...user, passwordHash });

  // create wallet — seed with user's preferred currency so their wallet opens in their local currency
  const wallet = { id: uuidv4(), userId: id, balances: [{ currency: preferredCurrency, amount: 0 }], createdAt: Date.now(), maxLimitUSD: 250000 };
  db.wallets.push(wallet);

  // Register first device (no alert needed on registration)
  if (!db.devices) db.devices = [];
  if (deviceInfo && deviceInfo.fingerprint) {
    db.devices.push({
      id: uuidv4(),
      userId: id,
      fingerprint: deviceInfo.fingerprint,
      name: deviceInfo.name || 'Unknown Device',
      type: deviceInfo.type || 'Mobile',
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      trusted: true
    });
  }

  saveDB(db);

  const token = jwt.sign({ userId: id, email, type: 'access', tokenVersion: 0 }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '15m' });
  const refreshToken = jwt.sign({ userId: id, email, type: 'refresh', tokenVersion: 0 }, JWT_SECRET, { expiresIn: '30d' });

  // Store token hash only — never the raw JWT. Evict oldest sessions beyond cap.
  if (!db.refreshTokens) db.refreshTokens = [];
  db.refreshTokens.push({ tokenHash: hashToken(refreshToken), userId: id, createdAt: Date.now() });
  enforceSessionCap(db, id);
  saveDB(db);
  
  res.json({ token, refreshToken, user: user, walletId: wallet.id, newDevice: false });
});

app.post('/auth/login', 
  authLimiter,
  validateInput([
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ]),
  (req, res) => {
  const db = loadDB();
  const { email, password, deviceInfo } = req.body;
  const lang = req.lang || 'en';
  
  const u = findUserByEmail(db, email);
  if (!u) {
    logger.warn('Login attempt - user not found', { email: maskEmail(email), ip: req.clientIP });
    return res.status(401).json({ error: t('error_invalid_credentials', lang) });
  }
  
  if (!bcrypt.compareSync(password, u.passwordHash)) {
    logger.warn('Login attempt - invalid password', { userId: u.id, ip: req.clientIP });
    return res.status(401).json({ error: t('error_invalid_credentials', lang) });
  }

  // Check if this is a new device
  let isNewDevice = false;
  if (!db.devices) db.devices = [];
  
  if (deviceInfo && deviceInfo.fingerprint) {
    const existingDevice = db.devices.find(d => 
      d.userId === u.id && d.fingerprint === deviceInfo.fingerprint
    );
    
    if (existingDevice) {
      // Update last seen time
      existingDevice.lastSeen = Date.now();
      existingDevice.lastIP = req.clientIP;
    } else {
      // New device detected
      isNewDevice = true;
      db.devices.push({
        id: uuidv4(),
        userId: u.id,
        fingerprint: deviceInfo.fingerprint,
        name: deviceInfo.name || 'Unknown Device',
        type: deviceInfo.type || 'Mobile',
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        lastIP: req.clientIP,
        trusted: false // Require user to trust new devices
      });
      
      logger.info('New device detected', { userId: u.id, deviceType: deviceInfo.type, ip: req.clientIP });
    }
  }

  const token = jwt.sign({ userId: u.id, email: u.email, type: 'access', tokenVersion: u.tokenVersion || 0 }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '15m' });
  const refreshToken = jwt.sign({ userId: u.id, email: u.email, type: 'refresh', tokenVersion: u.tokenVersion || 0 }, JWT_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '30d' });
  
  logger.info('User logged in', { userId: u.id, newDevice: isNewDevice, ip: req.clientIP });
  
  // Store token hash only — never the raw JWT. Evict oldest sessions beyond cap.
  if (!db.refreshTokens) db.refreshTokens = [];
  db.refreshTokens.push({ tokenHash: hashToken(refreshToken), userId: u.id, createdAt: Date.now() });
  enforceSessionCap(db, u.id);
  saveDB(db);
  
  res.json({ 
    token, 
    refreshToken, 
    user: { id: u.id, email: u.email, region: u.region, preferredCurrency: u.preferredCurrency || 'USD', autoConvertIncoming: u.autoConvertIncoming !== false, kycTier: u.kycTier || 0, kycStatus: u.kycStatus || 'pending', tierLimits: KYC_TIERS[u.kycTier || 0] },
    newDevice: isNewDevice,
    deviceName: deviceInfo?.name || 'Unknown Device'
  });
});

app.get('/auth/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  res.json({ id: user.id, email: user.email, username: user.username || null, preferredCurrency: user.preferredCurrency || 'USD', autoConvertIncoming: user.autoConvertIncoming !== false, kycTier: user.kycTier || 0, kycStatus: user.kycStatus || 'pending', tierLimits: KYC_TIERS[user.kycTier || 0] });
});

// Set or update @username — persists to database, enforces uniqueness
function setUsernameHandler(req, res) {
  const db = loadDB();
  const lang = req.lang || 'en';
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', lang), errorCode: 'error_user_not_found' });

  const raw = req.body.username;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: t('error_username_required', lang), errorCode: 'error_username_required' });
  }

  const normalized = raw.replace(/^@/, '').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(normalized)) {
    return res.status(400).json({ error: t('error_username_invalid', lang), errorCode: 'error_username_invalid' });
  }

  const existing = db.users.find(u => u.username === normalized);
  if (existing && existing.id !== user.id) {
    return res.status(409).json({ error: t('error_username_taken', lang), errorCode: 'error_username_taken' });
  }

  user.username = normalized;
  saveDB(db);
  logger.info('Username updated', { userId: user.id, username: normalized });
  res.json({ username: normalized });
}
app.put('/auth/username', authMiddleware, setUsernameHandler);
app.post('/auth/username', authMiddleware, setUsernameHandler);

// Refresh-token rate limiter — mobile apps refresh frequently; 20/15 min allows
// normal background refresh while blocking brute-force token-grinding.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.REFRESH_RATE_LIMIT) || 20,
  skipSuccessfulRequests: false,
  handler: (req, res) => {
    logger.warn('Refresh rate limit exceeded', { ip: req.clientIP });
    res.status(429).json({ error: 'Too many token refresh requests', retryAfter: 900 });
  },
});

// Refresh token endpoint — issues a new access token AND rotates the refresh token.
// The old refresh token is invalidated atomically with the new one being stored.
// Rate-limited + serialised per user to prevent concurrent token multiplication.
app.post('/auth/refresh', refreshLimiter, (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  // Verify JWT outside the mutex — cheap, stateless, and avoids holding the lock
  // for an unnecessary extra tick.
  let payload;
  try {
    payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: t('error_invalid_refresh_token', req.lang || 'en') });
    }
  } catch (e) {
    return res.status(401).json({ error: t('error_invalid_refresh_token', req.lang || 'en') });
  }

  // Per-user mutex: serialises concurrent rotation requests for the same userId.
  // The second concurrent request will re-read the DB after the first write and
  // find the original token already consumed, returning 401 instead of issuing a
  // duplicate session.
  withRefreshMutex(payload.userId, () => {
    try {
      const db = loadDB();
      if (!db.refreshTokens) db.refreshTokens = [];

      // Find the stored record by hash (legacy plaintext tokens migrated at startup).
      const incomingHash = hashToken(refreshToken);
      const tokenIdx = db.refreshTokens.findIndex(r =>
        r.userId === payload.userId && r.tokenHash === incomingHash
      );
      if (tokenIdx === -1) {
        res.status(401).json({ error: t('error_invalid_refresh_token', req.lang || 'en') });
        return;
      }

      // Reject tokens issued before a password reset or account deletion.
      const refreshUser = db.users.find(u => u.id === payload.userId);
      if (!refreshUser || refreshUser.status === 'deleted') {
        res.status(401).json({ error: t('error_invalid_refresh_token', req.lang || 'en') });
        return;
      }
      if ((refreshUser.tokenVersion || 0) !== (payload.tokenVersion || 0)) {
        res.status(401).json({ error: t('error_invalid_refresh_token', req.lang || 'en') });
        return;
      }

      // Issue new access token and rotated refresh token.
      const newToken = jwt.sign(
        { userId: payload.userId, email: payload.email, type: 'access', tokenVersion: refreshUser.tokenVersion || 0 },
        JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '15m' }
      );
      const newRefreshToken = jwt.sign(
        { userId: payload.userId, email: payload.email, type: 'refresh', tokenVersion: refreshUser.tokenVersion || 0 },
        JWT_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '30d' }
      );

      // Remove old token, add new hash, enforce session cap, and persist atomically.
      // If saveDB throws, the old token remains on disk — client retries with it.
      db.refreshTokens.splice(tokenIdx, 1);
      db.refreshTokens.push({ tokenHash: hashToken(newRefreshToken), userId: payload.userId, createdAt: Date.now() });
      enforceSessionCap(db, payload.userId);
      saveDB(db);

      res.json({ token: newToken, refreshToken: newRefreshToken });
    } catch (e) {
      if (!res.headersSent) {
        res.status(401).json({ error: t('error_invalid_refresh_token', req.lang || 'en') });
      }
    }
  }).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });
});

// Admin login rate limiter — guards the single shared ADMIN_SECRET; 5 failed
// attempts per 15 min per IP to block online brute-force while allowing ops use.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    logger.warn('Admin login rate limit exceeded', { ip: req.clientIP });
    res.status(429).json({ error: 'Too many admin login attempts', retryAfter: 900 });
  },
});

// Forgot-password rate limiter (stricter: 3 per 15 min per IP)
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  skipSuccessfulRequests: false,
  handler: (req, res) => {
    logger.warn('Forgot-password rate limit exceeded', { ip: req.clientIP });
    // Still return a generic success to avoid leaking info
    res.json({ success: true });
  }
});

// Logout endpoint (revoke refresh token)
// Logout — revokes the caller's refresh token.
// Does NOT require authMiddleware: the refresh JWT itself authenticates the request,
// allowing revocation even when the access token has already expired (common on mobile).
// Rate-limited via refreshLimiter to prevent token-grinding.
app.post('/auth/logout', refreshLimiter, (req, res) => {
  const { refreshToken } = req.body;

  // No refresh token supplied — nothing to revoke; treat as success (idempotent).
  if (!refreshToken) return res.json({ success: true });

  const db = loadDB();
  if (!db.refreshTokens) db.refreshTokens = [];

  try {
    // Verify the token to extract userId — prevents cross-user revocation.
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') {
      return res.status(400).json({ error: 'Invalid token type' });
    }
    const logoutHash = hashToken(refreshToken);
    db.refreshTokens = db.refreshTokens.filter(t => {
      const sameUser = t.userId === payload.userId;
      const sameToken = t.tokenHash === logoutHash;
      return !(sameUser && sameToken);
    });
    saveDB(db);
  } catch (e) {
    // Expired or malformed refresh token — already unusable; still return success
    // so the client can clear local storage without an error loop.
    logger.info('Logout called with expired/invalid refresh token', { ip: req.clientIP });
  }

  res.json({ success: true });
});

// ─── Forgot Password ──────────────────────────────────────────────────────────
app.post('/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    // Always return success – never reveal whether an email is registered
    if (!email || typeof email !== 'string') return res.json({ success: true });

    const db = loadDB();
    const user = db.users.find(u => u.email && u.email.toLowerCase() === email.trim().toLowerCase());

    if (user) {
      // Clean up any old tokens for this user
      if (!db.passwordResetTokens) db.passwordResetTokens = [];
      db.passwordResetTokens = db.passwordResetTokens.filter(tok => tok.userId !== user.id);

      // Generate a secure random token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = Date.now() + 20 * 60 * 1000; // 20 minutes

      db.passwordResetTokens.push({ tokenHash, userId: user.id, expiresAt, createdAt: Date.now() });
      saveDB(db);

      // Build reset link
      const frontendUrl = process.env.APP_FRONTEND_URL || 'egwallet://reset-password';
      const resetLink = `${frontendUrl}?token=${rawToken}`;

      // ── Email delivery ────────────────────────────────────────────────────
      // Supports SendGrid, Mailgun, or any SMTP provider via env vars.
      //
      //  Provider   | SMTP_HOST                        | SMTP_PORT | SMTP_SECURE
      //  -----------|----------------------------------|-----------|------------
      //  SendGrid   | smtp.sendgrid.net                | 587       | false
      //  Mailgun    | smtp.mailgun.org                 | 587       | false
      //  Gmail      | smtp.gmail.com                   | 465       | true
      //  Custom     | your-smtp-host                   | 587/465   | true/false
      //
      // Set on Railway:
      //   SMTP_HOST        smtp.sendgrid.net
      //   SMTP_PORT        587
      //   SMTP_USER        apikey               (SendGrid literal string "apikey")
      //   SMTP_PASS        SG.xxxxxxxxxxxx      (your SendGrid API key)
      //   SMTP_FROM        EGWallet <no-reply@yourdomain.com>
      //   SMTP_SECURE      false
      //   APP_FRONTEND_URL egwallet://reset-password
      // ─────────────────────────────────────────────────────────────────────
      const smtpHost = process.env.SMTP_HOST;
      if (smtpHost) {
        try {
          const smtpPort = parseInt(process.env.SMTP_PORT || '587');
          const smtpSecure = process.env.SMTP_SECURE === 'true'; // true only for port 465
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            },
            // Enforce TLS upgrade on STARTTLS connections (port 587)
            requireTLS: !smtpSecure,
            tls: { rejectUnauthorized: true },
          });

          const fromAddress = process.env.SMTP_FROM || 'EGWallet <egwallet.business@gmail.com>';

          // Mobile-optimised HTML email (table-based, widely compatible)
          const htmlEmail = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset your EGWallet password</title></head>
<body style="margin:0;padding:0;background:#F5F7FA;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FA;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);" cellpadding="0" cellspacing="0">
        <!-- Header -->
        <tr><td style="background:#1565C0;padding:28px 32px;text-align:center;">
          <p style="margin:0;font-size:28px;">💳</p>
          <h1 style="margin:8px 0 0;color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:-0.3px;">EGWallet</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          <h2 style="margin:0 0 12px;font-size:20px;color:#14171A;">Reset your password</h2>
          <p style="margin:0 0 24px;font-size:15px;color:#657786;line-height:1.6;">
            We received a request to reset the password for your EGWallet account.<br>
            Tap the button below — this link is valid for <strong>20 minutes</strong>.
          </p>
          <!-- CTA button -->
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
            <tr><td align="center">
              <a href="${resetLink}" target="_blank"
                style="display:inline-block;background:#1565C0;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.2px;">
                Reset Password
              </a>
            </td></tr>
          </table>
          <!-- Manual link fallback -->
          <p style="margin:0 0 8px;font-size:13px;color:#657786;">Or copy this link into your browser / app:</p>
          <p style="margin:0 0 24px;font-size:12px;color:#1565C0;word-break:break-all;">${resetLink}</p>
          <hr style="border:none;border-top:1px solid #E1E8ED;margin:0 0 24px;">
          <p style="margin:0;font-size:13px;color:#AAB8C2;line-height:1.6;">
            If you didn't request a password reset, you can safely ignore this email — your password will not change.<br><br>
            — The EGWallet Team
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#F5F7FA;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:11px;color:#AAB8C2;">© 2026 EGWallet. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

          const plainText = `Reset your EGWallet password\n\nWe received a request to reset your password.\n\nReset link (valid 20 minutes):\n${resetLink}\n\nIf you didn't request this, ignore this email — your password won't change.\n\n— The EGWallet Team`;

          await transporter.sendMail({
            from: fromAddress,
            to: user.email,
            subject: 'Reset your EGWallet password',
            text: plainText,
            html: htmlEmail,
          });

          logger.info('[Email] Password reset email sent', { userId: user.id, smtpHost });
        } catch (emailErr) {
          // SMTP failure: log full error for Railway visibility but DO NOT surface to client
          logger.error('[Email] FAILED to send password reset email', {
            userId: user.id,
            smtpHost,
            error: emailErr.message,
            code: emailErr.code,
            response: emailErr.response,
          });
          // Token is still saved — user can request again or check logs in dev
        }
      } else {
        // No SMTP configured — log reset token so it can be tested via Railway logs
        logger.warn('[Email] SMTP not configured — token saved to DB but not delivered. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM to enable email delivery.', { userId: user.id });
      }
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Forgot-password error', { err: err.message });
    // Still return success — do not expose internal errors
    res.json({ success: true });
  }
});

// ─── Reset Password ─────────────────────────────────────────────────────────
app.post('/auth/reset-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || typeof token !== 'string' || !newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'token_and_password_required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }

    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const db = loadDB();
    if (!db.passwordResetTokens) db.passwordResetTokens = [];

    const record = db.passwordResetTokens.find(tok => tok.tokenHash === tokenHash && tok.expiresAt > Date.now());
    if (!record) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }

    const user = db.users.find(u => u.id === record.userId);
    if (!user) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }

    // Update password
    user.passwordHash = bcrypt.hashSync(newPassword, 12);

    // Bump tokenVersion — invalidates all outstanding access JWTs immediately
    user.tokenVersion = (user.tokenVersion || 0) + 1;

    // Remove used token and all other tokens for this user
    db.passwordResetTokens = db.passwordResetTokens.filter(tok => tok.userId !== user.id);

    // Invalidate all existing refresh tokens (security: force re-login everywhere)
    if (!db.refreshTokens) db.refreshTokens = [];
    db.refreshTokens = db.refreshTokens.filter(t => t.userId !== user.id);

    saveDB(db);
    logger.info('Password reset successful', { userId: user.id });

    res.json({ success: true });
  } catch (err) {
    logger.error('Reset-password error', { err: err.message });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/auth/update-currency', authMiddleware, (req, res) => {
  const db = loadDB();
  const { preferredCurrency } = req.body;
  if (!preferredCurrency) return res.status(400).json({ error: t('error_currency_required', req.lang || 'en') });
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  user.preferredCurrency = preferredCurrency;
  saveDB(db);
  res.json({ success: true, preferredCurrency });
});

app.post('/auth/update-auto-convert', authMiddleware, (req, res) => {
  const db = loadDB();
  const { autoConvertIncoming } = req.body;
  if (typeof autoConvertIncoming !== 'boolean') return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  user.autoConvertIncoming = autoConvertIncoming;
  saveDB(db);
  res.json({ success: true, autoConvertIncoming });
});

// Wallet endpoints
app.get('/wallets/:id/balance', authMiddleware, (req, res) => {
  const db = loadDB();
  const wallet = db.wallets.find(w => w.id === req.params.id && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  res.json({ balances: wallet.balances, maxLimitUSD: wallet.maxLimitUSD });
});

// List wallets for authenticated user
app.get('/wallets', authMiddleware, (req, res) => {
  const db = loadDB();
  let wallets = db.wallets.filter(w => w.userId === req.user.userId);
  
  // Auto-create wallet if user has none (backward compatibility fix)
  if (wallets.length === 0) {
    const autoUser = db.users.find(u => u.id === req.user.userId);
    const autoCurrency = autoUser?.preferredCurrency || 'USD';
    const wallet = { 
      id: uuidv4(), 
      userId: req.user.userId, 
      balances: [{ currency: autoCurrency, amount: 0 }], 
      createdAt: Date.now(), 
      maxLimitUSD: 250000 
    };
    db.wallets.push(wallet);
    saveDB(db);
    wallets = [wallet];
    logger.info('Auto-created missing wallet for user', { userId: req.user.userId });
  }
  
  res.json({ wallets });
});

app.get('/wallets/:id/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const wallet = db.wallets.find(w => w.id === req.params.id && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  const txs = db.transactions
    .filter(t => t.fromWalletId === wallet.id || t.toWalletId === wallet.id)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(t => ({
      ...t,
      direction: t.fromWalletId === wallet.id ? 'out' : 'in',
      type: t.type || (t.fromWalletId === wallet.id ? 'sent' : 'received')
    }));
  // Include withdrawals (stored separately in db.withdrawals, not db.transactions)
  const withdrawalTxs = (db.withdrawals || [])
    .filter(w => w.walletId === wallet.id)
    .map(w => ({
      id: w.id,
      type: 'withdrawal',
      direction: 'out',
      fromWalletId: w.walletId,
      amount: w.amount,
      currency: w.currency,
      feeAmount: w.feeAmount,
      netPayout: w.netPayout,
      method: w.method,
      bankName: w.bankNameDisplay || null,
      accountNumber: safeWithdrawalAccountNumber(w),
      accountHolderName: null,
      status: w.status,
      timestamp: w.createdAt,
      memo: `Withdrawal to ${w.bankNameDisplay || w.method || 'account'}`,
    }));
  const combined = [...txs, ...withdrawalTxs].sort((a, b) => b.timestamp - a.timestamp);
  res.json({ transactions: combined });
});

// Get all transactions for authenticated user (across all their wallets)
app.get('/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  const walletIds = new Set(userWallets.map(w => w.id));
  const txs = db.transactions
    .filter(t => walletIds.has(t.fromWalletId) || walletIds.has(t.toWalletId))
    .map(t => ({
      ...t,
      direction: walletIds.has(t.fromWalletId) ? 'out' : 'in',
      type: t.type || (walletIds.has(t.fromWalletId) ? 'sent' : 'received')
    }));
  // Include withdrawals (stored separately in db.withdrawals, not db.transactions)
  const withdrawalTxs = (db.withdrawals || [])
    .filter(w => walletIds.has(w.walletId))
    .map(w => ({
      id: w.id,
      type: 'withdrawal',
      direction: 'out',
      fromWalletId: w.walletId,
      amount: w.amount,
      currency: w.currency,
      feeAmount: w.feeAmount,
      netPayout: w.netPayout,
      method: w.method,
      bankName: w.bankNameDisplay || null,
      accountNumber: safeWithdrawalAccountNumber(w),
      accountHolderName: null,
      status: w.status,
      timestamp: w.createdAt,
      memo: `Withdrawal to ${w.bankNameDisplay || w.method || 'account'}`,
    }));
  const combined = [...txs, ...withdrawalTxs].sort((a, b) => b.timestamp - a.timestamp);
  res.json(combined);
});

// Resolve @username OR email to { userId, walletId }
// Supports: "@frank" (username), "frank@email.com" (email)
// Auto-creates wallet if user exists but wallet is missing.
function resolveRecipient(db, input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const trimmed = input.trim();
  let user = null;

  if (trimmed.startsWith('@')) {
    // @username lookup
    const uname = trimmed.slice(1).toLowerCase();
    user = (db.users || []).find(u => u.username && u.username === uname);
    // Also try email-prefix match if no username hit (e.g. @frank → frank@...)
    if (!user) {
      user = (db.users || []).find(u => u.email && u.email.toLowerCase().startsWith(uname + '@'));
    }
  } else if (trimmed.includes('@') && trimmed.includes('.')) {
    // Email lookup (contains @ and . → likely an email)
    user = (db.users || []).find(u => u.email && u.email.toLowerCase() === trimmed.toLowerCase());
  } else {
    return null; // Not an @-identifier or email — caller handles as wallet ID
  }

  if (!user) return null;

  // Find or auto-create wallet
  let wallet = (db.wallets || []).find(w => w.userId === user.id);
  if (!wallet) {
    const preferredCurrency = user.preferredCurrency || 'USD';
    wallet = { id: uuidv4(), userId: user.id, balances: [{ currency: preferredCurrency, amount: 0 }], createdAt: Date.now(), maxLimitUSD: 250000 };
    if (!db.wallets) db.wallets = [];
    db.wallets.push(wallet);
    saveDB(db);
    logger.info('Auto-created wallet for user', { userId: user.id, walletId: wallet.id });
  }

  return { userId: user.id, walletId: wallet.id };
}

// Send money (simple internal transfer between wallets by walletId or @username)
app.post('/transactions', authMiddleware, async (req, res) => {
  const lang = req.lang || 'en';
  const { fromWalletId, toWalletId: rawToId, amount, currency, memo, idempotencyKey } = req.body; // amount is expected in minor units (integer)
  if (!fromWalletId || !rawToId || typeof amount === 'undefined' || !currency) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  // ── Idempotency check ──────────────────────────────────────────────────────
  const clientKey = idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (!clientKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  const cached0 = idempotencyStore.get(clientKey);
  if (cached0 && cached0.userId === req.user.userId && Date.now() - cached0.timestamp < IDEMPOTENCY_EXPIRY) {
    return res.status(200).json(cached0.response);
  }

  return withBalanceMutex(async () => {
  const db = loadDB();

  // Durable idempotency — survives restart (check DB after acquiring mutex)
  if (clientKey) {
    const durableHit = checkDurableIdempotency(db, clientKey, req.user.userId);
    if (durableHit) {
      idempotencyStore.set(clientKey, { userId: req.user.userId, response: durableHit, timestamp: Date.now() });
      return res.status(200).json(durableHit);
    }
  }

  // @username / email resolution — resolve to walletId before all other logic
  let toWalletId = rawToId;
  if (typeof rawToId === 'string' && (rawToId.startsWith('@') || (rawToId.includes('@') && rawToId.includes('.')))) {
    const resolved = resolveRecipient(db, rawToId);
    if (!resolved) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
    if (resolved.userId === req.user.userId) return res.status(400).json({ error: t('error_cannot_send_to_self', lang) });
    toWalletId = resolved.walletId;
  }

  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: t('error_source_wallet_not_found', req.lang || 'en') });
  const toWallet = db.wallets.find(w => w.id === toWalletId);
  if (!toWallet) return res.status(404).json({ error: t('error_destination_wallet_not_found', req.lang || 'en') });

  // Block self-transfers — including same wallet id (debit+credit same bucket nets to zero).
  if (fromWalletId === toWalletId || fromWallet.userId === toWallet.userId) {
    return res.status(400).json({ error: t('error_cannot_send_to_self', lang) });
  }

  normalizeWalletBalances(fromWallet);
  normalizeWalletBalances(toWallet);

  const rates = db.rates.values;

  // Resolve debit bucket — must be a real entry in fromWallet.balances (never a detached object).
  let debitEntry = getWalletBalanceEntry(fromWallet, currency);
  let debitCurrency = currency;
  let debitAmount = amount;
  let senderCrossCurrency = false;

  if (!debitEntry || debitEntry.amount < amount) {
    const richest = (fromWallet.balances || []).reduce((best, b) => {
      const valUSD = minorToMajor(b.amount, b.currency) / (rates[b.currency] || 1);
      const bestUSD = best ? minorToMajor(best.amount, best.currency) / (rates[best.currency] || 1) : 0;
      return valUSD > bestUSD ? b : best;
    }, null);
    if (!richest) return res.status(400).json({ error: t('error_insufficient_funds', lang) });

    const sendMajor = minorToMajor(amount, currency);
    const sendUSD = sendMajor / (rates[currency] || 1);
    const debitMajor = sendUSD * (rates[richest.currency] || 1);
    debitAmount = majorToMinor(debitMajor, richest.currency);
    const fxGuard = fxSafetyCheck(debitAmount, richest.currency);
    if (!fxGuard.safe) {
      logger.error('[/transactions] FX safety check failed for cross-currency send', {
        currency, richest: richest.currency, amount, debitAmount, reason: fxGuard.reason,
      });
      return res.status(500).json({ error: 'FX conversion error — please retry' });
    }
    if (richest.amount < debitAmount) {
      return res.status(400).json({ error: t('error_insufficient_funds', lang) });
    }
    debitEntry = richest;
    debitCurrency = richest.currency;
    senderCrossCurrency = true;
  }
  const amountMajor = minorToMajor(amount, currency);
  const toAmountInUSD = amountMajor / (rates[currency] || 1);

  // CHECK #1: KYC tier limits (daily / weekly / monthly rolling windows)
  const senderUser = db.users.find(u => u.id === req.user.userId);
  if (!senderUser) return res.status(404).json({ error: t('error_sender_not_found', lang) });

  const limitCheck = checkKYCLimits(senderUser, toAmountInUSD, db);
  if (!limitCheck.allowed) {
    return res.status(403).json({
      code:                'LIMIT_EXCEEDED',
      error:               limitCheck.message,
      limitType:           limitCheck.limitType,
      remainingDailyUSD:   limitCheck.remainingDailyUSD,
      remainingWeeklyUSD:  limitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: limitCheck.remainingMonthlyUSD,
      tierLevel:           limitCheck.tierLevel,
      nextTier:            limitCheck.nextTier,
    });
  }

  // CHECK #2: Max wallet capacity ($250,000 USD) for destination
  const destTotalUSD = toWallet.balances.reduce((s,b)=>{
    const bMajor = minorToMajor(b.amount, b.currency);
    return s + (bMajor / (rates[b.currency] || 1));
  },0) + toAmountInUSD;
  
  const MAX_WALLET_CAPACITY_USD = toWallet.maxLimitUSD || 250000;
  if (destTotalUSD > MAX_WALLET_CAPACITY_USD) {
    return res.status(400).json({ 
      error: t('error_wallet_capacity_exceeded', lang),
      destinationTotal: destTotalUSD,
      maxCapacity: MAX_WALLET_CAPACITY_USD
    });
  }
  
  // Get receiver's preferred currency and auto-convert setting
  const toUser = db.users.find(u => u.id === toWallet.userId);
  const shouldAutoConvert = toUser?.autoConvertIncoming !== false;
  // Determine receiver's local currency:
  //   1. Explicit preferredCurrency on user record (set at registration or via settings)
  //   2. Country-based lookup from user's region (global map covers all countries)
  //   3. Wallet's primary balance currency (for existing wallets before this feature)
  //   4. Fall back to sender's currency (no conversion)
  const receiverCurrencyByRegion = COUNTRY_TO_CURRENCY[toUser?.region] || null;
  const receiverWalletCurrency = toWallet.balances?.[0]?.currency || null;
  const receiverCurrency = shouldAutoConvert
    ? (toUser?.preferredCurrency || receiverCurrencyByRegion || receiverWalletCurrency || currency)
    : currency;
  
  // Block cross-currency sends in production when FX rates are stale — before any
  // balance mutation so no rollback is needed.
  if ((shouldAutoConvert && receiverCurrency !== currency || senderCrossCurrency) && NODE_ENV === 'production') {
    const txRatesAgeMs = Date.now() - (db.rates?.updatedAt || 0);
    if (txRatesAgeMs > FX_STALE_THRESHOLD_MS) {
      logger.error('[/transactions] Stale FX rates — blocking cross-currency send in production', {
        ageHours: (txRatesAgeMs / 3600000).toFixed(1),
        fromCurrency: currency,
        debitCurrency,
        receiverCurrency,
      });
      return res.status(503).json({
        error: 'FX rates are outdated. Cross-currency transfers are temporarily unavailable. Please try again shortly.',
      });
    }
  }

  // Deduct from sender — save originals for rollback if saveDB fails
  const originalFromAmount = debitEntry.amount;
  let destBalance = getWalletBalanceEntry(toWallet, receiverCurrency);
  const originalDestAmount = destBalance ? destBalance.amount : null;

  // Same balance object on same wallet would net to zero (money created from nothing).
  if (fromWallet === toWallet && debitEntry === destBalance) {
    return res.status(400).json({ error: t('error_cannot_send_to_self', lang) });
  }

  debitEntry.amount -= debitAmount;
  
  // Convert to receiver's preferred currency if different AND auto-convert is enabled
  let receivedAmount = amount;
  let receivedCurrency = currency;
  let wasConverted = false;
  let fxFeeAmount = 0;

  if (shouldAutoConvert && receiverCurrency !== currency) {
    // Convert: original → USD → receiver's currency
    const amountMajor = minorToMajor(amount, currency);
    const amountUSD = amountMajor / (rates[currency] || 1);
    const amountInReceiverCurrency = amountUSD * (rates[receiverCurrency] || 1);
    const rawConverted = majorToMinor(amountInReceiverCurrency, receiverCurrency);
    // Apply 1.15% FX fee — deducted from the converted amount (transparent)
    const fxFeeCalc = calcFxFee(rawConverted);
    receivedAmount = fxFeeCalc.netReceived;
    fxFeeAmount    = fxFeeCalc.feeAmount;
    receivedCurrency = receiverCurrency;
    wasConverted = true;
  }
  
  // Add to receiver in their preferred currency
  if (destBalance) destBalance.amount += receivedAmount;
  else {
    destBalance = { currency: receivedCurrency, amount: receivedAmount };
    toWallet.balances.push(destBalance);
  }

  // Integrity: sender must actually lose funds; receiver must gain funds.
  if (debitEntry.amount >= originalFromAmount) {
    logger.error('[/transactions] INTEGRITY FAIL — sender balance did not decrease', {
      fromWalletId, toWalletId, debitCurrency, originalFromAmount, debitAmount,
    });
    debitEntry.amount = originalFromAmount;
    if (destBalance && originalDestAmount !== null) destBalance.amount = originalDestAmount;
    else if (destBalance) toWallet.balances = toWallet.balances.filter(b => b !== destBalance);
    return res.status(500).json({ error: t('error_transaction_persist', lang) });
  }
  if (receivedAmount <= 0) {
    logger.error('[/transactions] INTEGRITY FAIL — receiver credit is non-positive', { receivedAmount });
    debitEntry.amount = originalFromAmount;
    if (destBalance && originalDestAmount !== null) destBalance.amount = originalDestAmount;
    return res.status(500).json({ error: t('error_transaction_persist', lang) });
  }

  const tx = { 
    id: uuidv4(), 
    fromWalletId, 
    toWalletId, 
    amount, 
    currency,
    debitAmount,
    debitCurrency,
    senderCrossCurrency,
    receivedAmount, 
    receivedCurrency,
    wasConverted,
    fxFeeAmount,       // 0 for same-currency; 1.15% of converted amount otherwise
    sendFeeAmount: 0,  // P2P sends are always free
    memo: memo||'', 
    status: 'completed', 
    timestamp: Date.now() 
  };
  db.transactions.push(tx);

  // Increment stored USD usage for the sender (calendar-based daily/weekly/monthly buckets)
  updateLimitTracking(senderUser, toAmountInUSD);
  // senderUser is a reference to the object already in db.users — saveDB below persists it

  // Build response before the first saveDB so the idempotency record is committed
  // in the same atomic write as the financial mutation. A crash after saveDB always
  // leaves a valid replay record; a crash before saveDB leaves nothing (safe: retry allowed).
  const responseBody = {
    transaction: tx,
    feeBreakdown: {
      youSend: amount,
      currency,
      fxFee: fxFeeAmount,
      transferFee: 0,
      theyReceive: receivedAmount,
      receivedCurrency,
      wasConverted,
    },
    limits: {
      remainingDailyUSD:   limitCheck.remainingDailyUSD,
      remainingWeeklyUSD:  limitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: limitCheck.remainingMonthlyUSD,
      tierLevel:           limitCheck.tierLevel,
    },
  };
  if (clientKey) saveDurableIdempotency(db, clientKey, responseBody, req.user.userId);

  try {
    saveDB(db); // commits balances + tx + limit tracking + idempotency atomically
  } catch (saveErr) {
    // Rollback in-memory changes so state stays consistent before rethrowing
    debitEntry.amount = originalFromAmount;
    if (destBalance && originalDestAmount !== null) destBalance.amount = originalDestAmount;
    else if (destBalance) toWallet.balances = toWallet.balances.filter(b => b.currency !== receivedCurrency);
    db.transactions.pop();
    if (clientKey && db.idempotencyRecords?.length) db.idempotencyRecords.pop();
    console.error('[/transactions] saveDB failed — rolled back in-memory state:', saveErr);
    return res.status(500).json({ error: t('error_transaction_persist', lang) });
  }

  if (clientKey) idempotencyStore.set(clientKey, { userId: req.user.userId, response: responseBody, timestamp: Date.now() });

  // Notify sender
  createNotification(db, req.user.userId, 'money_sent',
    'Payment Sent',
    `You sent ${minorToMajor(amount, currency).toFixed(decimalsFor(currency))} ${currency}${wasConverted ? ` → ${minorToMajor(receivedAmount, receivedCurrency).toFixed(decimalsFor(receivedCurrency))} ${receivedCurrency}` : ''}`,
    { transactionId: tx.id, amount, currency });

  // Notify receiver
  createNotification(db, toWallet.userId, 'money_received',
    'Payment Received',
    `You received ${minorToMajor(receivedAmount, receivedCurrency).toFixed(decimalsFor(receivedCurrency))} ${receivedCurrency} from ${senderUser.fullName || senderUser.username || senderUser.email || 'someone'}`,
    { transactionId: tx.id, amount: receivedAmount, currency: receivedCurrency });
  saveDB(db);

  res.json(responseBody);
  }); // withBalanceMutex
});

// ==================== ADMIN ROUTES ====================
app.post('/admin/login',  adminLoginLimiter, adminLoginHandler);
app.post('/admin/logout', adminLoginLimiter, adminLogoutHandler);
app.use('/admin/withdrawals', adminWithdrawalsRouter);

// Withdrawals to bank/mobile money
app.post('/withdrawals', authMiddleware, async (req, res) => {
  const {
    fromWalletId, amount, currency, method, isInternational,
    country, bankName, accountNumber, accountHolderName,
    bankCode, branchCode, iban, swiftBic,
  } = req.body;

  if (!fromWalletId || typeof amount === 'undefined' || !currency || !method)
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  // ── Amount and method validation ──────────────────────────────────────────
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000)
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  const ALLOWED_WITHDRAWAL_METHODS = new Set(['bank', 'mobile', 'debit', 'credit']);
  if (!ALLOWED_WITHDRAWAL_METHODS.has(method))
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  // String field length limits — prevent oversized strings reaching the DB
  const WITHDRAWAL_STR_LIMITS = {
    bankName: 100, accountNumber: 50, accountHolderName: 100,
    bankCode: 20, branchCode: 20, iban: 34, swiftBic: 11, country: 60,
  };
  for (const [field, max] of Object.entries(WITHDRAWAL_STR_LIMITS)) {
    const val = req.body[field];
    if (val !== undefined && val !== null && (typeof val !== 'string' || val.length > max))
      return res.status(400).json({ error: `${field} exceeds maximum allowed length` });
  }

  // ── Card PAN server-side sanitization ────────────────────────────────────
  // Clients are untrusted. When method is debit/credit, strip everything but
  // the last 4 digits here — before the value ever reaches createWithdrawal
  // or db.json. Full PANs must never be persisted or returned via any API.
  let sanitizedAccountNumber = accountNumber || null;
  if ((method === 'debit' || method === 'credit') && sanitizedAccountNumber) {
    sanitizedAccountNumber = String(sanitizedAccountNumber).replace(/\D/g, '').slice(-4) || null;
  }

  // ── Block in production when no payout provider is configured ────────────
  // Prevents funds entering holdBalance with no path to release them.
  // Stripe requires BOTH an API key AND a configured Connect destination account
  // (STRIPE_CONNECT_READY=true).  Without Connect, stripePayout() always throws
  // in production, leaving funds permanently locked in holdBalance.
  if (process.env.NODE_ENV === 'production') {
    const resolvedProvider = payoutRouter(country || '');
    // H-2: Stripe payouts currently disburse to the operator's STRIPE_CONNECT_ACCOUNT,
    // not the user's entered bank details.  Block Stripe-routed withdrawals in
    // production until per-user Stripe Connect external accounts are implemented.
    const stripeReady = false;
    const koraReady   = !!process.env.KORA_API_KEY;
    const providerReady = (resolvedProvider === 'stripe' && stripeReady) ||
                          (resolvedProvider === 'kora'   && koraReady);
    if (!providerReady) {
      logger.error('POST /withdrawals blocked — no payout provider configured for region', {
        userId: req.user.userId, country, resolvedProvider,
      });
      return res.status(503).json({
        error: 'Withdrawals are temporarily unavailable. Please contact support.',
      });
    }
  }

  // ── Client-supplied idempotency key (required) ────────────────────────────
  const clientKey = req.body.idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (!clientKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  const cached0 = idempotencyStore.get(clientKey);
  if (cached0 && cached0.userId === req.user.userId && Date.now() - cached0.timestamp < IDEMPOTENCY_EXPIRY)
    return res.status(200).json(cached0.response);

  let _capturedWithdrawalId;

  await withBalanceMutex(async () => {
  const db = loadDB();

  // Durable idempotency — survives restart
  if (clientKey) {
    const durableHit = checkDurableIdempotency(db, clientKey, req.user.userId);
    if (durableHit) {
      // Sanitize PII from cached response — strips encrypted fields, returns safe masks.
      if (durableHit.withdrawal) {
        durableHit.withdrawal = sanitizeWithdrawalForResponse(durableHit.withdrawal);
      }
      idempotencyStore.set(clientKey, { userId: req.user.userId, response: durableHit, timestamp: Date.now() });
      _capturedWithdrawalId = durableHit.withdrawal?.id;
      return res.status(200).json(durableHit);
    }
  }

  // KYC tier limits — same enforcement as POST /transactions and POST /exchange.
  // Checked before createWithdrawal so funds are never held if the limit is exceeded.
  const withdrawUser = db.users.find(u => u.id === req.user.userId);
  if (!withdrawUser) return res.status(404).json({ error: t('error_sender_not_found', req.lang || 'en') });
  const wRates       = db.rates?.values || {};
  const withdrawMajor = minorToMajor(amount, currency);
  const withdrawUSD   = withdrawMajor / (wRates[currency] || 1);
  const wLimitCheck   = checkKYCLimits(withdrawUser, withdrawUSD, db);
  if (!wLimitCheck.allowed) {
    return res.status(403).json({
      code:                'LIMIT_EXCEEDED',
      error:               wLimitCheck.message,
      limitType:           wLimitCheck.limitType,
      remainingDailyUSD:   wLimitCheck.remainingDailyUSD,
      remainingWeeklyUSD:  wLimitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: wLimitCheck.remainingMonthlyUSD,
      tierLevel:           wLimitCheck.tierLevel,
      nextTier:            wLimitCheck.nextTier,
    });
  }

  const feeCalc = calcWithdrawFee(amount, !!isInternational);

  let withdrawal;
  try {
    withdrawal = createWithdrawal(db, req.user.userId, {
      walletId:          fromWalletId,
      amount,
      currency,
      method,
      isInternational,
      country:           country           || null,
      bankName:          bankName          || null,
      accountNumber:     sanitizedAccountNumber,
      accountHolderName: accountHolderName || null,
      bankCode:          bankCode          || null,
      branchCode:        branchCode        || null,
      iban:              iban              || null,
      swiftBic:          swiftBic          || null,
      feeAmount:  feeCalc.feeAmount,
      feeRate:    feeCalc.rate,
      netPayout:  feeCalc.netPayout,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  // In production withdrawals stay pending_review for admin approval before any funds move.
  // In dev/staging advance immediately so end-to-end payout flows can be tested.
  if (NODE_ENV !== 'production') {
    advanceToProcessing(db, withdrawal.id);
  }

  // Increment KYC limit tracking — withdrawUser is a reference inside db.users,
  // persisted atomically with the hold deduction by saveDB below.
  updateLimitTracking(withdrawUser, withdrawUSD);

  // Build response before saveDB so idempotency is committed atomically with the
  // financial mutation — a crash after saveDB always leaves a replay-safe record.
  // sanitizeWithdrawalForResponse strips encrypted PII from the response and cache;
  // the db.json record keeps the ciphertext for the payout provider to decrypt.
  const responseBody = {
    withdrawal: sanitizeWithdrawalForResponse(withdrawal),
    feeBreakdown: {
      youSend:      amount,
      fee:          feeCalc.feeAmount,
      theyReceive:  feeCalc.netPayout,
      currency,
      feeRate:      feeCalc.rate,
      isInternational: !!isInternational,
    },
  };
  if (clientKey) saveDurableIdempotency(db, clientKey, responseBody, req.user.userId);

  saveDB(db); // commits hold deduction + KYC limits + idempotency atomically

  if (clientKey) idempotencyStore.set(clientKey, { userId: req.user.userId, response: responseBody, timestamp: Date.now() });

  // Notify user — fresh db load so the notification saveDB has the current version.
  const db2 = loadDB();
  createNotification(db2, req.user.userId, 'withdrawal',
    'Withdrawal Submitted',
    `${minorToMajor(feeCalc.netPayout, currency).toFixed(decimalsFor(currency))} ${currency} is being sent to your ${isInternational ? 'international' : 'local'} account`,
    { withdrawalId: withdrawal.id, amount, currency });
  saveDB(db2);

  logger.info('Withdrawal created', {
    userId:       req.user.userId,
    withdrawalId: withdrawal.id,
    amount,
    feeAmount:    feeCalc.feeAmount,
    netPayout:    feeCalc.netPayout,
    currency,
    method,
    isInternational: !!isInternational,
  });

  _capturedWithdrawalId = withdrawal.id;
  res.json(responseBody);
  }); // withBalanceMutex

  // Only fire automatic payout dispatch in dev/staging.
  // In production, withdrawals stay pending_review and require admin approval before processing.
  if (_capturedWithdrawalId && NODE_ENV !== 'production') {
    setImmediate(() => executePayout(_capturedWithdrawalId, loadDB, saveDB, logger, withBalanceMutex));
  }
});

// Cancel a pending_review withdrawal — returns held funds to available balance.
// Only the owning user can cancel, and only while the withdrawal has not yet been approved.
app.post('/withdrawals/:id/cancel', authMiddleware, async (req, res) => {
  await withBalanceMutex(async () => {
    const db = loadDB();

    const w = (db.withdrawals || []).find(
      x => x.id === req.params.id && x.userId === req.user.userId
    );
    if (!w) return res.status(404).json({ error: 'Withdrawal not found' });

    if (w.status !== 'pending_review') {
      return res.status(400).json({
        error: 'Only withdrawals in pending_review status can be cancelled. ' +
               'Once approved or processing, please contact support.',
      });
    }

    try {
      markWithdrawalFailed(db, w.id, 'Cancelled by user');
      saveDB(db);
      logger.info('Withdrawal cancelled by user', {
        userId: req.user.userId,
        withdrawalId: w.id,
        amount: w.amount,
        currency: w.currency,
      });
      res.json({ success: true, message: 'Withdrawal cancelled and funds returned to your wallet.' });
    } catch (err) {
      logger.error('Error cancelling withdrawal', { error: err.message, withdrawalId: req.params.id });
      return res.status(err.status || 500).json({ error: err.message });
    }
  });
});

// Rates
app.get('/rates', (req, res) => {
  const db = loadDB();
  res.json(db.rates);
});

// ==================== NOTIFICATIONS ====================

/**
 * Internal helper — write a notification record into db.notifications.
 * Called by deposit/withdrawal/send endpoints after successful operations.
 */
function createNotification(db, userId, type, title, body, metadata = {}) {
  if (!db.notifications) db.notifications = [];
  db.notifications.unshift({
    id: uuidv4(),
    userId,
    type,      // 'money_received' | 'money_sent' | 'deposit' | 'withdrawal' | 'failed'
    title,
    body,
    read: false,
    metadata,
    createdAt: Date.now(),
  });
  // Keep at most 100 notifications per user in the flat-file store
  db.notifications = db.notifications.filter(n => n.userId === userId).slice(0, 100)
    .concat(db.notifications.filter(n => n.userId !== userId));
}

// GET /notifications — list all for authenticated user (newest first)
app.get('/notifications', authMiddleware, (req, res) => {
  const db = loadDB();
  const all = (db.notifications || []).filter(n => n.userId === req.user.userId);
  res.json({ notifications: all, unreadCount: all.filter(n => !n.read).length });
});

// PATCH /notifications/read-all — mark every unread notification as read
app.patch('/notifications/read-all', authMiddleware, (req, res) => {
  const db = loadDB();
  let changed = 0;
  (db.notifications || []).forEach(n => {
    if (n.userId === req.user.userId && !n.read) { n.read = true; changed++; }
  });
  if (changed > 0) saveDB(db);
  res.json({ markedRead: changed });
});

// PATCH /notifications/:id/read — mark a single notification as read
app.patch('/notifications/:id/read', authMiddleware, (req, res) => {
  const db = loadDB();
  const notif = (db.notifications || []).find(n => n.id === req.params.id && n.userId === req.user.userId);
  if (!notif) return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  notif.read = true;
  saveDB(db);
  res.json({ ok: true });
});

// FX Quote — preview a cross-currency conversion before sending
// GET /fx-quote?from=XAF&to=NGN&amount=500000  (amount in minor units of 'from')
app.get('/fx-quote', authMiddleware, (req, res) => {
  const { from, to, amount } = req.query;
  if (!from || !to || !amount) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  const sentAmountMinor = Math.round(Number(amount));
  if (isNaN(sentAmountMinor) || sentAmountMinor <= 0) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  const db = loadDB();
  const rates = db.rates.values;
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!fromRate) return res.status(400).json({ error: `Unsupported currency: ${from}` });
  if (!toRate) return res.status(400).json({ error: `Unsupported currency: ${to}` });

  if (from === to) {
    return res.json({
      fromCurrency: from, toCurrency: to,
      sentAmountMinor, receivedAmountMinor: sentAmountMinor,
      fxFeeAmount: 0, receivedAmountMinorAfterFee: sentAmountMinor,
      rate: 1, rateDisplay: `1 ${from} = 1 ${to}`,
      isSameCurrency: true, fxFeeRate: 0, ratesUpdatedAt: db.rates.updatedAt,
      ratesStale: (Date.now() - (db.rates.updatedAt || 0)) > FX_STALE_THRESHOLD_MS,
    });
  }

  // Convert: minor(from) → major(from) → USD → major(to) → minor(to)
  const amountMajorFrom = minorToMajor(sentAmountMinor, from);
  const amountUSD = amountMajorFrom / fromRate;
  const amountMajorTo = amountUSD * toRate;
  const receivedAmountMinor = majorToMinor(amountMajorTo, to);

  // Safety guard: reject if conversion produces a nonsensical result
  const fxGuard = fxSafetyCheck(receivedAmountMinor, to);
  if (!fxGuard.safe) {
    logger.error('[FX] Safety check failed in /fx-quote', { from, to, sentAmountMinor, receivedAmountMinor, reason: fxGuard.reason });
    return res.status(500).json({ error: 'FX conversion error — please retry' });
  }
  const fxFeeCalc = calcFxFee(receivedAmountMinor);

  // Exchange rate: 1 unit of fromCurrency in toCurrency
  const rate = toRate / fromRate;

  res.json({
    fromCurrency: from, toCurrency: to,
    sentAmountMinor,
    receivedAmountMinor,                                  // before FX fee (raw)
    fxFeeAmount: fxFeeCalc.feeAmount,
    receivedAmountMinorAfterFee: fxFeeCalc.netReceived,   // what recipient actually gets
    fxFeeRate: FEES.FX_RATE,
    rate, rateDisplay: `1 ${from} = ${rate.toFixed(6)} ${to}`,
    isSameCurrency: false, ratesUpdatedAt: db.rates.updatedAt,
    ratesStale: (Date.now() - (db.rates.updatedAt || 0)) > FX_STALE_THRESHOLD_MS,
  });
});

// Get a wallet's primary currency (used by sender to show FX preview for recipient)
// Only returns currency code — no balance or owner data exposed.
app.get('/wallets/:id/currency', authMiddleware, (req, res) => {
  const db = loadDB();
  let wallet = db.wallets.find(w => w.id === req.params.id);

  // If not a direct wallet ID, try resolving as @username or email
  if (!wallet) {
    const resolved = resolveRecipient(db, req.params.id);
    if (resolved) wallet = db.wallets.find(w => w.id === resolved.walletId);
  }

  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  const owner = db.users.find(u => u.id === wallet.userId);
  // Prefer user's explicitly set preferredCurrency, then first balance currency
  const currency = owner?.preferredCurrency || wallet.balances?.[0]?.currency || 'USD';
  res.json({ currency, walletId: req.params.id });
});

// ==================== IN-WALLET CURRENCY EXCHANGE ====================
// Exchange one currency balance for another within the same wallet.
// The FX fee (1.15%) is deducted from the converted (received) amount.
// This endpoint is additive — it does NOT touch /transactions, /withdrawals, or any other path.
//
// POST /exchange  { walletId, fromCurrency, toCurrency, amount, idempotencyKey }
//   amount : integer, minor units of fromCurrency  (e.g. 60000 for 60,000 XAF; 10000 for $100 USD)
app.post('/exchange', authMiddleware, async (req, res) => {
  const lang = req.lang || 'en';
  const { walletId, fromCurrency, toCurrency, amount, idempotencyKey } = req.body;

  // ── 1. Input validation ───────────────────────────────────────────────────
  if (!walletId || !fromCurrency || !toCurrency || typeof amount === 'undefined') {
    return res.status(400).json({ error: t('error_missing_fields', lang) });
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    return res.status(400).json({ error: t('error_missing_fields', lang) });
  }
  if (fromCurrency === toCurrency) {
    return res.status(400).json({ error: 'Cannot exchange a currency for itself' });
  }

  // ── 2. Idempotency check ──────────────────────────────────────────────────
  const clientKey = idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (!clientKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  const cached0 = idempotencyStore.get(clientKey);
  if (cached0 && cached0.userId === req.user.userId && Date.now() - cached0.timestamp < IDEMPOTENCY_EXPIRY) {
    return res.status(200).json(cached0.response);
  }

  // ── 2b. Preflight (no mutex wait) — return real HTTP errors immediately ─────
  // Authoritative balance/limit checks still run inside withBalanceMutex below.
  try {
    const preDb = loadDB();
    const preWallet = preDb.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
    if (!preWallet) {
      return res.status(404).json({ error: t('error_source_wallet_not_found', lang) });
    }
    const preFrom = preWallet.balances.find(b => b.currency === fromCurrency);
    if (!preFrom || preFrom.amount < amount) {
      return res.status(400).json({ error: t('error_insufficient_funds', lang) });
    }
    const preUser = preDb.users.find(u => u.id === req.user.userId);
    if (!preUser) {
      return res.status(404).json({ error: t('error_sender_not_found', lang) });
    }
    const preFromRate = preDb.rates.values[fromCurrency];
    const preToRate = preDb.rates.values[toCurrency];
    if (!preFromRate) return res.status(400).json({ error: `Unsupported currency: ${fromCurrency}` });
    if (!preToRate) return res.status(400).json({ error: `Unsupported currency: ${toCurrency}` });
    const preRatesAgeMs = Date.now() - (preDb.rates.updatedAt || 0);
    if (preRatesAgeMs > FX_STALE_THRESHOLD_MS && NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'FX rates are outdated. Exchange is temporarily unavailable. Please try again shortly.',
        ratesUpdatedAt: preDb.rates.updatedAt,
      });
    }
    const preAmountUSD = minorToMajor(amount, fromCurrency) / preFromRate;
    const preLimit = checkKYCLimits(preUser, preAmountUSD, preDb);
    if (!preLimit.allowed) {
      return res.status(403).json({
        code:                'LIMIT_EXCEEDED',
        error:               preLimit.message,
        limitType:           preLimit.limitType,
        remainingDailyUSD:   preLimit.remainingDailyUSD,
        remainingWeeklyUSD:  preLimit.remainingWeeklyUSD,
        remainingMonthlyUSD: preLimit.remainingMonthlyUSD,
        tierLevel:           preLimit.tierLevel,
        nextTier:            preLimit.nextTier,
      });
    }
  } catch (preErr) {
    logger.error('[/exchange] preflight check failed', { error: preErr.message, userId: req.user?.userId });
    return res.status(500).json({ error: t('error_transaction_persist', lang) });
  }

  try {
  await withBalanceMutex(async () => {
  try {
  const db = loadDB();

  // Durable idempotency — survives restart
  if (clientKey) {
    const durableHit = checkDurableIdempotency(db, clientKey, req.user.userId);
    if (durableHit) {
      idempotencyStore.set(clientKey, { userId: req.user.userId, response: durableHit, timestamp: Date.now() });
      return res.status(200).json(durableHit);
    }
  }

  // ── 3. Wallet ownership ───────────────────────────────────────────────────
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_source_wallet_not_found', lang) });

  // ── 4. Sufficient balance in source currency ──────────────────────────────
  const fromBalance = wallet.balances.find(b => b.currency === fromCurrency);
  if (!fromBalance || fromBalance.amount < amount) {
    return res.status(400).json({ error: t('error_insufficient_funds', lang) });
  }

  // ── 5. KYC tier limits (exchange counts toward daily/weekly/monthly quotas) ─
  const senderUser = db.users.find(u => u.id === req.user.userId);
  if (!senderUser) return res.status(404).json({ error: t('error_sender_not_found', lang) });

  const rates    = db.rates.values;
  const fromRate = rates[fromCurrency];
  const toRate   = rates[toCurrency];
  if (!fromRate) return res.status(400).json({ error: `Unsupported currency: ${fromCurrency}` });
  if (!toRate)   return res.status(400).json({ error: `Unsupported currency: ${toCurrency}` });

  const ratesAgeMs = Date.now() - (db.rates.updatedAt || 0);
  const ratesStale = ratesAgeMs > FX_STALE_THRESHOLD_MS;
  if (ratesStale) {
    if (NODE_ENV === 'production') {
      logger.error('[/exchange] Stale FX rates — blocking exchange in production', {
        ageHours: (ratesAgeMs / 3600000).toFixed(1),
        updatedAt: db.rates.updatedAt,
      });
      return res.status(503).json({
        error: 'FX rates are outdated. Exchange is temporarily unavailable. Please try again shortly.',
        ratesUpdatedAt: db.rates.updatedAt,
      });
    }
    logger.warn('[/exchange] Using stale FX rates (dev/staging only)', {
      ageHours: (ratesAgeMs / 3600000).toFixed(1),
      updatedAt: db.rates.updatedAt,
    });
  }

  const amountMajorFrom = minorToMajor(amount, fromCurrency);
  const amountUSD       = amountMajorFrom / fromRate;
  const limitCheck      = checkKYCLimits(senderUser, amountUSD, db);
  if (!limitCheck.allowed) {
    return res.status(403).json({
      code:                'LIMIT_EXCEEDED',
      error:               limitCheck.message,
      limitType:           limitCheck.limitType,
      remainingDailyUSD:   limitCheck.remainingDailyUSD,
      remainingWeeklyUSD:  limitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: limitCheck.remainingMonthlyUSD,
      tierLevel:           limitCheck.tierLevel,
      nextTier:            limitCheck.nextTier,
    });
  }

  // ── 6. FX conversion math (same formula as /fx-quote) ────────────────────
  const amountMajorTo       = amountUSD * toRate;
  const receivedAmountMinor = majorToMinor(amountMajorTo, toCurrency);

  const fxGuard = fxSafetyCheck(receivedAmountMinor, toCurrency);
  if (!fxGuard.safe) {
    logger.error('[/exchange] FX safety check failed',
      { fromCurrency, toCurrency, amount, receivedAmountMinor, reason: fxGuard.reason });
    return res.status(500).json({ error: 'FX conversion error — please retry' });
  }

  const fxFeeCalc   = calcFxFee(receivedAmountMinor);
  const netReceived = fxFeeCalc.netReceived;
  const fxFeeAmount = fxFeeCalc.feeAmount;

  // ── 7. Rollback snapshots (taken before any mutation) ────────────────────
  const originalFromAmount = fromBalance.amount;
  const toBalance          = wallet.balances.find(b => b.currency === toCurrency);
  const originalToAmount   = toBalance ? toBalance.amount : null;

  // ── 8. Apply balance changes ──────────────────────────────────────────────
  fromBalance.amount -= amount;
  if (toBalance) {
    toBalance.amount += netReceived;
  } else {
    wallet.balances.push({ currency: toCurrency, amount: netReceived });
  }

  // ── 9. Build transaction record ───────────────────────────────────────────
  const tx = {
    id:               uuidv4(),
    type:             'exchange',
    fromWalletId:     walletId,
    toWalletId:       walletId,
    amount,
    currency:         fromCurrency,
    receivedAmount:   netReceived,
    receivedCurrency: toCurrency,
    wasConverted:     true,
    fxFeeAmount,
    sendFeeAmount:    0,
    memo:             '',
    status:           'completed',
    timestamp:        Date.now(),
  };
  db.transactions.push(tx);

  // ── 10. Update KYC limit tracking ────────────────────────────────────────
  updateLimitTracking(senderUser, amountUSD);

  // ── 11. Build response, then persist — rollback in-memory on failure ────────
  // responseBody is built before saveDB so the idempotency record is committed
  // atomically with the financial mutation.
  const responseBody = {
    transaction: tx,
    feeBreakdown: {
      youSend:      amount,
      fromCurrency,
      rawConverted: receivedAmountMinor,
      fxFee:        fxFeeAmount,
      youReceive:   netReceived,
      toCurrency,
      rate:         toRate / fromRate,
      rateDisplay:  `1 ${fromCurrency} = ${(toRate / fromRate).toFixed(6)} ${toCurrency}`,
    },
    limits: {
      remainingDailyUSD:   limitCheck.remainingDailyUSD,
      remainingWeeklyUSD:  limitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: limitCheck.remainingMonthlyUSD,
      tierLevel:           limitCheck.tierLevel,
    },
    ratesUpdatedAt: db.rates.updatedAt,
    ratesStale,
  };
  if (clientKey) saveDurableIdempotency(db, clientKey, responseBody, req.user.userId);

  try {
    saveDB(db); // commits balances + tx + limit tracking + idempotency atomically
  } catch (saveErr) {
    fromBalance.amount = originalFromAmount;
    if (toBalance) {
      toBalance.amount = originalToAmount;
    } else {
      wallet.balances = wallet.balances.filter(b => b.currency !== toCurrency);
    }
    db.transactions.pop();
    if (clientKey && db.idempotencyRecords?.length) db.idempotencyRecords.pop();
    logger.error('[/exchange] saveDB failed — rolled back in-memory state:', saveErr);
    return res.status(500).json({ error: t('error_transaction_persist', lang) });
  }

  if (clientKey) idempotencyStore.set(clientKey, { userId: req.user.userId, response: responseBody, timestamp: Date.now() });

  // ── 12. Notification ──────────────────────────────────────────────────────
  createNotification(db, req.user.userId, 'exchange_completed',
    'Exchange Completed',
    `Exchanged ${minorToMajor(amount, fromCurrency).toFixed(decimalsFor(fromCurrency))} ${fromCurrency} \u2192 ${minorToMajor(netReceived, toCurrency).toFixed(decimalsFor(toCurrency))} ${toCurrency}`,
    { transactionId: tx.id, amount, fromCurrency, toCurrency });
  try {
    saveDB(db);
  } catch (notifSaveErr) {
    // Exchange is already committed — never drop the HTTP response here.
    logger.error('[/exchange] notification saveDB failed — exchange already committed', {
      error: notifSaveErr.message,
      transactionId: tx.id,
      userId: req.user.userId,
    });
  }

  res.json(responseBody);
  } catch (handlerErr) {
    logger.error('[/exchange] unhandled handler error', {
      error: handlerErr.message,
      userId: req.user?.userId,
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: t('error_transaction_persist', lang) });
    }
  }
  }); // withBalanceMutex
  } catch (routeErr) {
    logger.error('[/exchange] route/mutex error', { error: routeErr.message, userId: req.user?.userId });
    if (!res.headersSent) {
      return res.status(500).json({ error: t('error_transaction_persist', lang) });
    }
  }
});

// GET /fx-rates/status — rate freshness info (safe: no balances or user data)
app.get('/fx-rates/status', authMiddleware, (req, res) => {
  const db = loadDB();
  const updatedAt = db.rates.updatedAt || 0;
  const ageMs = Date.now() - updatedAt;
  res.json({
    updatedAt,
    source:        db.rates.source || 'seeded',
    ageSeconds:    Math.floor(ageMs / 1000),
    ageMinutes:    Math.floor(ageMs / 60000),
    currencyCount: Object.keys(db.rates.values || {}).length,
    isStale:       ageMs > FX_STALE_THRESHOLD_MS,
  });
});

// ==================== DEPOSIT / TOP-UP ENDPOINTS ====================

// Fee-info endpoint — cheap call so DepositScreen can show the fee tier before the user confirms
app.get('/deposits/fee-info', authMiddleware, (req, res) => {
  const db = loadDB();
  const depositCount = getUserDepositCount(db, req.user.userId);
  const isFree = depositCount < FEES.TOPUP_FREE_LIMIT;
  res.json({
    depositCount,
    freeTopupsRemaining: Math.max(0, FEES.TOPUP_FREE_LIMIT - depositCount),
    isFreeTopup: isFree,
    feeRate: isFree ? 0 : FEES.TOPUP_FEE_RATE,
    feeRatePct: isFree ? '0%' : `${(FEES.TOPUP_FEE_RATE * 100).toFixed(1)}%`,
    freeLimit: FEES.TOPUP_FREE_LIMIT,
  });
});

// Step 1: Create a Stripe PaymentIntent (or demo intent if Stripe not configured)
// Returns clientSecret for use with @stripe/stripe-react-native PaymentSheet
app.post('/deposits/create-intent', authMiddleware,
  validateInput([
    body('amount').isInt({ min: 100 }),   // amount in minor units, min 1 USD
    body('currency').isString().isLength({ min: 3, max: 5 }),
    body('walletId').isString(),
  ]),
  async (req, res) => {
    const db = loadDB();
    const { amount, currency, walletId } = req.body;
    const user = db.users.find(u => u.id === req.user.userId);
    if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
    // Fall back to the user's first wallet if the provided walletId is 'demo' or not found
    const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId)
      || db.wallets.find(w => w.userId === req.user.userId);
    if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
    const effectiveWalletId = wallet.id;

    // Compute fee BEFORE charging — so the total charged to the card includes the fee
    const depositCount = getUserDepositCount(db, req.user.userId);
    const feeInfo = calcTopupFee(amount, depositCount);
    // Total card charge = amount requested + fee (user pays the fee on top)
    const totalCharged = amount + feeInfo.feeAmount; // amount that goes to card / Stripe
    const netCredited  = amount;                      // wallet always receives the amount entered

    if (stripeClient) {
      // Real Stripe PaymentIntent — charge total (including fee)
      try {
        const intent = await stripeClient.paymentIntents.create({
          amount: Math.round(totalCharged),
          currency: currency.toLowerCase(),
          metadata: {
            userId: req.user.userId,
            walletId: effectiveWalletId,
            netCredited: String(netCredited),
            feeAmount: String(feeInfo.feeAmount),
            feeRate: String(feeInfo.rate),
          },
          automatic_payment_methods: { enabled: true },
        });
        logger.info('Stripe PaymentIntent created', { intentId: intent.id, userId: req.user.userId, amount, totalCharged, currency });
        return res.json({
          clientSecret: intent.client_secret,
          intentId: intent.id,
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
          resolvedWalletId: effectiveWalletId,
          mode: 'stripe',
          feeBreakdown: {
            youPay: totalCharged,
            fee: feeInfo.feeAmount,
            addedToWallet: netCredited,
            currency,
            isFree: feeInfo.isFree,
            feeRate: feeInfo.rate,
            depositCount,
          },
        });
      } catch (err) {
        logger.error('Stripe PaymentIntent failed', { error: err.message, userId: req.user.userId });
        return res.status(500).json({ error: t('error_internal', req.lang || 'en'), message: err.message });
      }
    }

    // Demo / test mode — no Stripe key configured
    if (NODE_ENV === 'production' && !ALLOW_DEMO_DEPOSITS) {
      logger.error('Deposit attempted in production without Stripe configuration', { userId: req.user.userId });
      return res.status(503).json({ error: 'Deposits require Stripe configuration in production. Contact support.' });
    }
    const demoIntentId = `demo_intent_${uuidv4()}`;
    if (!db.demoIntents) db.demoIntents = [];
    db.demoIntents.push({
      id: demoIntentId,
      userId: req.user.userId,
      walletId: effectiveWalletId,
      amount,
      currency,
      netCredited,
      feeAmount: feeInfo.feeAmount,
      feeRate: feeInfo.rate,
      status: 'pending',
      createdAt: Date.now(),
    });
    saveDB(db);
    logger.info('Demo deposit intent created', { intentId: demoIntentId, userId: req.user.userId, amount, netCredited, feeAmount: feeInfo.feeAmount, currency });
    return res.json({
      clientSecret: `${demoIntentId}_secret`,
      intentId: demoIntentId,
      publishableKey: null,
      resolvedWalletId: effectiveWalletId,
      mode: 'demo',
      feeBreakdown: {
        youPay: totalCharged,
        fee: feeInfo.feeAmount,
        addedToWallet: netCredited,
        currency,
        isFree: feeInfo.isFree,
        feeRate: feeInfo.rate,
        depositCount,
      },
    });
  }
);

// Step 2: Confirm deposit — credit wallet after successful payment
// Called by frontend after PaymentSheet succeeds (or immediately in demo mode)
app.post('/deposits/confirm', authMiddleware,
  validateInput([
    body('intentId').isString(),
    body('walletId').isString(),
  ]),
  async (req, res) => {
    const { intentId, walletId } = req.body;

    return withBalanceMutex(async () => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.userId);
    if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
    const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
    if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });

    let amount, currency, netCredited, feeAmount, feeRate;

    if (stripeClient && !intentId.startsWith('demo_intent_')) {
      // Verify real Stripe PaymentIntent status
      try {
        const intent = await stripeClient.paymentIntents.retrieve(intentId);
        if (intent.status !== 'succeeded') {
          return res.status(400).json({ error: `Payment not completed. Status: ${intent.status}` });
        }
        if (intent.metadata.walletId !== walletId || intent.metadata.userId !== req.user.userId) {
          return res.status(403).json({ error: t('error_internal', req.lang || 'en') });
        }
        // netCredited is stored in metadata (amount entered by user, not total charged)
        netCredited = Number(intent.metadata.netCredited) || intent.amount;
        feeAmount   = Number(intent.metadata.feeAmount)   || 0;
        feeRate     = Number(intent.metadata.feeRate)     || 0;
        amount      = netCredited; // use net credited as the canonical "deposit amount"
        currency    = intent.currency.toUpperCase();

        // C1: Idempotency — block replay of an already-credited Stripe intent.
        // Reload DB inside the wallet lock so the check reflects any concurrent save.
        const freshDb = loadDB();
        const alreadyDeposited = (freshDb.transactions || []).some(
          tx => tx.stripeIntentId === intentId
        );
        if (alreadyDeposited) {
          const existing = freshDb.transactions.find(tx => tx.stripeIntentId === intentId);
          logger.warn('Stripe deposit replay blocked — intent already credited', { intentId, userId: req.user.userId });
          return res.json({ success: true, transaction: existing, currency, alreadyProcessed: true });
        }
      } catch (err) {
        return res.status(500).json({ error: t('error_internal', req.lang || 'en'), message: err.message });
      }
    } else {
      // Demo mode — blocked in production unless closed-testing flag is set
      if (NODE_ENV === 'production' && !ALLOW_DEMO_DEPOSITS) {
        logger.error('Demo deposit confirm attempted in production', { userId: req.user.userId, intentId });
        return res.status(503).json({ error: 'Demo deposits are not permitted in production.' });
      }
      // Demo mode — look up pending intent
      if (!db.demoIntents) return res.status(400).json({ error: t('error_not_found', req.lang || 'en') });
      const demo = db.demoIntents.find(d => d.id === intentId && d.userId === req.user.userId && d.walletId === walletId);
      if (!demo) return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
      if (demo.status !== 'pending') return res.status(400).json({ error: t('error_request_processed', req.lang || 'en') });
      amount      = demo.amount;
      netCredited = demo.netCredited  ?? demo.amount;
      feeAmount   = demo.feeAmount    ?? 0;
      feeRate     = demo.feeRate      ?? 0;
      currency    = demo.currency;
      demo.status = 'used';
    }

    // Credit wallet with net amount (amount the user wanted in their wallet)
    let balance = wallet.balances.find(b => b.currency === currency);
    if (!balance) {
      balance = { currency, amount: 0 };
      wallet.balances.push(balance);
    }
    balance.amount += netCredited;

    // Record transaction with full fee breakdown
    const tx = {
      id: uuidv4(),
      type: 'deposit',
      fromWalletId: null,
      toWalletId: walletId,
      amount: netCredited,
      currency,
      receivedAmount: netCredited,
      receivedCurrency: currency,
      wasConverted: false,
      feeAmount,
      feeRate,
      grossAmount: netCredited + feeAmount, // total charged to card
      status: 'completed',
      timestamp: Date.now(),
      memo: `Deposit via ${intentId.startsWith('demo_intent_') ? 'Demo Mode' : 'Stripe'}`,
      direction: 'in',
      stripeIntentId: intentId,
    };
    db.transactions.push(tx);
    saveDB(db);

    // Notify user
    createNotification(db, req.user.userId, 'deposit',
      'Deposit Successful',
      `${minorToMajor(netCredited, currency).toFixed(decimalsFor(currency))} ${currency} has been added to your wallet${feeAmount > 0 ? ` (fee: ${minorToMajor(feeAmount, currency).toFixed(decimalsFor(currency))} ${currency})` : ' (free top-up)'}`,
      { transactionId: tx.id, netCredited, feeAmount, currency });
    saveDB(db);

    logger.info('Deposit confirmed', { intentId, userId: req.user.userId, walletId, netCredited, feeAmount, currency });
    return res.json({
      success: true,
      transaction: tx,
      newBalance: balance.amount,
      currency,
      feeBreakdown: {
        youPaid: netCredited + feeAmount,
        fee: feeAmount,
        addedToWallet: netCredited,
        currency,
        feeRate,
      },
    });

    }); // withBalanceMutex
  }
);

// Basic user info
app.get('/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const u = db.users.find(x=>x.id===req.user.userId);
  if (!u) return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  res.json({ id: u.id, email: u.email, username: u.username || null, region: u.region, kycTier: u.kycTier || 0, kycStatus: u.kycStatus || 'pending', tierLimits: KYC_TIERS[u.kycTier || 0] });
});

// GET /users/lookup?q=<walletId or @username>
// Returns minimal public info about another user — used by RequestScreen to resolve recipient.
app.get('/users/lookup', authMiddleware, (req, res) => {
  const db = loadDB();
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  let recipientUser = null;

  if (q.startsWith('@')) {
    // @username lookup
    const handle = q.slice(1).toLowerCase();
    recipientUser = db.users.find(u => u.username && u.username.toLowerCase() === handle);
  } else {
    // wallet ID lookup
    const wallet = db.wallets.find(w => w.id === q);
    if (wallet) {
      recipientUser = db.users.find(u => u.id === wallet.userId);
    }
  }

  if (!recipientUser) {
    return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  }

  // Never expose the same user to themselves in a misleading way — still return it
  res.json({
    userId: recipientUser.id,
    username: recipientUser.username || null,
    displayName: `${recipientUser.firstName || ''} ${recipientUser.lastName || ''}`.trim() || recipientUser.email.split('@')[0],
  });
});

// ==================== PAYMENT REQUESTS ====================
// Create a payment request
app.post('/payment-requests', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, amount, currency, memo, idempotencyKey, targetWalletId, recipientHandle } = req.body;
  if (!walletId || typeof amount === 'undefined' || !currency) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }

  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached && cached.userId === req.user.userId) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  
  // SECURITY CHECK: If requesting from a specific wallet (employer), verify authorization
  let isEmployerRequest = false;
  let employerRelationship = null;
  
  if (targetWalletId) {
    const targetWallet = db.wallets.find(w => w.id === targetWalletId);
    if (!targetWallet) {
      return res.status(404).json({ error: t('error_destination_wallet_not_found', req.lang || 'en') });
    }
    
    // Check if target wallet belongs to an employer
    const targetEmployer = db.employers.find(e => {
      const fundingWallet = db.wallets.find(w => 
        w.id === e.fundingWalletId && w.id === targetWalletId
      );
      return !!fundingWallet;
    });
    
    if (targetEmployer) {
      isEmployerRequest = true;
      
      // CRITICAL: Verify employer-employee relationship
      employerRelationship = db.employerEmployees.find(ee => 
        ee.employerId === targetEmployer.id && 
        ee.workerId === req.user.userId &&
        ee.status === 'active'
      );
      
      if (!employerRelationship) {
        logger.warn('Unauthorized employer payment request attempt', {
          workerId: req.user.userId,
          employerId: targetEmployer.id,
          amount,
          currency
        });
        return res.status(403).json({ 
          error: t('error_not_authorized_employer', req.lang || 'en') 
        });
      }
      
      // SECURITY CHECK: Employer must be verified
      if (targetEmployer.verificationStatus !== 'verified') {
        return res.status(403).json({ 
          error: t('error_employer_unverified', req.lang || 'en') 
        });
      }
      
      // SECURITY CHECK: Verify employer wallet has sufficient balance
      const targetBalance = targetWallet.balances.find(b => b.currency === currency);
      if (!targetBalance || targetBalance.amount < amount) {
        return res.status(400).json({ 
          error: t('error_employer_insufficient_balance', req.lang || 'en') 
        });
      }
      
      // SECURITY CHECK: Amount within employee's max request limit
      if (employerRelationship.maxRequestAmount && amount > employerRelationship.maxRequestAmount) {
        return res.status(403).json({ 
          error: t('error_request_exceeds_limit', req.lang || 'en', { limit: employerRelationship.maxRequestAmount, currency }) 
        });
      }
      
      // SECURITY CHECK: AML threshold - flag large requests
      const amountUSD = convertToUSD(minorToMajor(amount, currency), currency, db.rates);
      const AML_THRESHOLD_USD = 10000; // $10K+
      if (amountUSD >= AML_THRESHOLD_USD) {
        logger.warn('Large employer payment request (AML threshold)', {
          workerId: req.user.userId,
          employerId: targetEmployer.id,
          amountUSD,
          currency,
          amount
        });
        
        // Create flagged audit record
        const auditEntry = {
          id: uuidv4(),
          type: 'aml_large_request',
          userId: req.user.userId,
          employerId: targetEmployer.id,
          amountUSD,
          currency,
          amount,
          timestamp: Date.now(),
          flags: ['large_amount', 'employer_request']
        };
        if (!db.auditLog) db.auditLog = [];
        db.auditLog.push(auditEntry);
      }
      
      // SECURITY CHECK: Rate limiting (5 requests per hour to employers)
      const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
      const RATE_LIMIT_MAX = 5;
      const now = Date.now();
      
      if (!db.paymentRequestsRateLimit) db.paymentRequestsRateLimit = {};
      const rateLimitKey = `${req.user.userId}_${targetEmployer.id}`;
      
      if (!db.paymentRequestsRateLimit[rateLimitKey]) {
        db.paymentRequestsRateLimit[rateLimitKey] = [];
      }
      
      // Clean old entries
      db.paymentRequestsRateLimit[rateLimitKey] = db.paymentRequestsRateLimit[rateLimitKey]
        .filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
      
      if (db.paymentRequestsRateLimit[rateLimitKey].length >= RATE_LIMIT_MAX) {
        logger.warn('Rate limit exceeded for employer payment requests', {
          workerId: req.user.userId,
          employerId: targetEmployer.id
        });
        return res.status(429).json({ 
          error: t('error_duplicate_request', req.lang || 'en'),
          retryAfter: 3600
        });
      }
      
      // High-3: Duplicate request prevention (24-hour window).
      // Match on BOTH field names: r.targetEmployerId (legacy) and r.employerId (new path),
      // and normalize currency to prevent cross-path duplicates slipping through.
      const DUPLICATE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
      const recentRequests = db.paymentRequests.filter(r =>
        (r.requesterId === req.user.userId || r.userId === req.user.userId) &&
        (r.targetEmployerId === targetEmployer.id || r.employerId === targetEmployer.id) &&
        r.amount === amount &&
        (r.currency || '').toUpperCase() === (currency || '').toUpperCase() &&
        r.status === 'pending' &&
        (now - r.createdAt) < DUPLICATE_WINDOW
      );
      
      if (recentRequests.length > 0) {
        logger.warn('Duplicate employer payment request detected', {
          workerId: req.user.userId,
          employerId: targetEmployer.id,
          amount,
          currency
        });
        return res.status(400).json({ 
          error: t('error_duplicate_request', req.lang || 'en'),
          existingRequestId: recentRequests[0].id
        });
      }
      // NOTE: rate-limit timestamp is pushed inside withBalanceMutex below to prevent
      // TOCTOU (two concurrent requests both reading count=0 and both passing).
    }
  }
  
  // Create request with proper tagging
  const request = {
    id: uuidv4(),
    requesterId: req.user.userId,
    walletId,
    targetWalletId: targetWalletId || null,
    targetEmployerId: isEmployerRequest && employerRelationship ? employerRelationship.employerId : null,
    amount,
    currency,
    memo: memo || '',
    status: 'pending', // pending, paid, cancelled
    type: isEmployerRequest ? 'payroll_request' : 'personal_request', // COMPLIANCE TAGGING
    createdAt: Date.now(),
    paidAt: null,
    paidBy: null,
    transactionId: null
  };

  // Resolve recipient from recipientHandle (@username or walletId)
  let recipientUserId = null;
  if (recipientHandle && !isEmployerRequest) {
    const handle = recipientHandle.trim();
    let recipientUser = null;
    if (handle.startsWith('@')) {
      const uname = handle.slice(1).toLowerCase();
      recipientUser = db.users.find(u => u.username && u.username.toLowerCase() === uname);
    } else {
      const rWallet = db.wallets.find(w => w.id === handle);
      if (rWallet) recipientUser = db.users.find(u => u.id === rWallet.userId);
    }
    if (recipientUser) {
      recipientUserId = recipientUser.id;
      request.recipientUserId = recipientUserId;
    }
  }
  
  // Add payroll metadata if employer request
  if (isEmployerRequest && employerRelationship) {
    request.payrollMetadata = {
      employerId: employerRelationship.employerId,
      employerName: employerRelationship.employerName,
      workerId: req.user.userId,
      workerEmail: employerRelationship.workerEmail,
      position: employerRelationship.position
    };
    
    request.complianceFlags = {
      requiresApproval: true,
      amlChecked: true,
      employerVerified: true
    };
  }
  
  // High-2: Employer requests use withBalanceMutex for an atomic rate-limit-push +
  // duplicate re-check + push + save, preventing TOCTOU in single-process deployment.
  // (Multi-instance deployments need a distributed lock; the in-process mutex documents
  // the single-pod guarantee, consistent with the pattern used throughout this codebase.)
  if (isEmployerRequest && employerRelationship) {
    withBalanceMutex(() => {
      const dbLocked = loadDB();
      const now2 = Date.now();
      const legacyEmpId = employerRelationship.employerId;
      const rlKey2 = `${req.user.userId}_${legacyEmpId}`;

      // High-2: Re-check active linkage inside mutex (may have been revoked since outer check).
      const lockedLinkage = (dbLocked.employerEmployees || []).find(ee =>
        ee.employerId === legacyEmpId && ee.workerId === req.user.userId && ee.status === 'active'
      );
      if (!lockedLinkage) {
        logger.warn('[/payment-requests legacy] Worker linkage revoked before mutex write', {
          workerId: req.user.userId, employerId: legacyEmpId
        });
        res.status(403).json({ error: t('error_not_linked_employer', req.lang || 'en') });
        return;
      }

      // High-2: Re-check employer verification inside mutex.
      const lockedEmployer = (dbLocked.employers || []).find(e => e.id === legacyEmpId);
      if (!lockedEmployer || lockedEmployer.verificationStatus !== 'verified') {
        logger.warn('[/payment-requests legacy] Employer no longer verified inside mutex', {
          workerId: req.user.userId, employerId: legacyEmpId
        });
        res.status(403).json({ error: t('error_employer_unverified', req.lang || 'en') });
        return;
      }

      // Authoritative rate-limit check inside mutex (fresh snapshot).
      if (!dbLocked.paymentRequestsRateLimit) dbLocked.paymentRequestsRateLimit = {};
      if (!dbLocked.paymentRequestsRateLimit[rlKey2]) dbLocked.paymentRequestsRateLimit[rlKey2] = [];
      dbLocked.paymentRequestsRateLimit[rlKey2] = dbLocked.paymentRequestsRateLimit[rlKey2]
        .filter(ts => now2 - ts < 60 * 60 * 1000);
      if (dbLocked.paymentRequestsRateLimit[rlKey2].length >= 5) {
        res.status(429).json({ error: t('error_duplicate_request', req.lang || 'en'), retryAfter: 3600 });
        return;
      }

      // Authoritative duplicate check inside mutex — both field names, normalized currency.
      const normalizedLegacyCur = (currency || '').toUpperCase();
      const dupCheck = (dbLocked.paymentRequests || []).filter(r =>
        (r.requesterId === req.user.userId || r.userId === req.user.userId) &&
        (r.targetEmployerId === legacyEmpId || r.employerId === legacyEmpId) &&
        r.amount === amount &&
        (r.currency || '').toUpperCase() === normalizedLegacyCur &&
        r.status === 'pending' &&
        (now2 - r.createdAt) < 24 * 60 * 60 * 1000
      );
      if (dupCheck.length > 0) {
        res.status(400).json({
          error: t('error_duplicate_request', req.lang || 'en'),
          existingRequestId: dupCheck[0].id
        });
        return;
      }

      // High-1: Check funding balance including pending reservation for this employer + currency.
      const legacyFundingWallet = (dbLocked.wallets || []).find(w => w.id === lockedEmployer.fundingWalletId);
      const legacyFundingBalance = legacyFundingWallet &&
        (legacyFundingWallet.balances || []).find(b => b.currency === normalizedLegacyCur);
      const legacyReserved = (dbLocked.paymentRequests || [])
        .filter(r =>
          r.status === 'pending' &&
          r.type === 'payroll_request' &&
          (r.employerId === legacyEmpId || r.targetEmployerId === legacyEmpId) &&
          (r.currency || '').toUpperCase() === normalizedLegacyCur
        )
        .reduce((sum, r) => sum + (r.amount || 0), 0);
      if (!legacyFundingBalance || legacyFundingBalance.amount < amount + legacyReserved) {
        logger.warn('[/payment-requests legacy] Funding balance insufficient after reservations', {
          workerId: req.user.userId, employerId: legacyEmpId,
          requested: amount, reserved: legacyReserved,
          available: legacyFundingBalance ? legacyFundingBalance.amount : 0
        });
        res.status(400).json({ error: t('error_employer_insufficient_balance', req.lang || 'en') });
        return;
      }

      // All checks pass — record rate-limit timestamp, persist, and respond.
      dbLocked.paymentRequestsRateLimit[rlKey2].push(now2);
      dbLocked.paymentRequests.push(request);
      saveDB(dbLocked);

      logger.info('Employer payment request created (legacy path)', {
        requestId: request.id, workerId: req.user.userId,
        employerId: employerRelationship.employerId, amount, currency,
        amountUSD: convertToUSD(minorToMajor(amount, currency), currency, dbLocked.rates)
      });

      const response = { request };
      if (idempotencyKey) idempotencyStore.set(idempotencyKey, { userId: req.user.userId, response, timestamp: Date.now() });
      res.json(response);
    }).catch(err => {
      logger.error('[/payment-requests employer] mutex error', { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    });
    return; // employer path handled fully inside mutex; prevent fall-through
  }

  // Non-employer (personal) request path — unchanged.
  db.paymentRequests.push(request);
  saveDB(db);

  if (recipientUserId) {
    const requester = db.users.find(u => u.id === req.user.userId);
    const requesterName = requester
      ? `${requester.firstName || ''} ${requester.lastName || ''}`.trim() || requester.email.split('@')[0]
      : 'Someone';
    const displayAmount = minorToMajor(amount, currency).toFixed(decimalsFor(currency));
    createNotification(
      db,
      recipientUserId,
      'payment_request',
      'Payment Request',
      `${requesterName} is requesting ${displayAmount} ${currency}`,
      { requestId: request.id, requesterId: req.user.userId, amount, currency, memo: memo || '' }
    );
    saveDB(db);
  }

  const response = { request };
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { userId: req.user.userId, response, timestamp: Date.now() });
  }
  res.json(response);
});

// List payment requests (created by user)
app.get('/payment-requests', authMiddleware, (req, res) => {
  const db = loadDB();
  const requests = db.paymentRequests
    .filter(r => r.requesterId === req.user.userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ requests });
});

// List incoming payment requests (where current user is the recipient)
app.get('/payment-requests/incoming', authMiddleware, (req, res) => {
  const db = loadDB();
  const requests = (db.paymentRequests || [])
    .filter(r => r.recipientUserId === req.user.userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(r => {
      const requester = db.users.find(u => u.id === r.requesterId);
      const requesterName = requester
        ? `${requester.firstName || ''} ${requester.lastName || ''}`.trim() || requester.email.split('@')[0]
        : 'Unknown';
      return { ...r, requesterName };
    });
  res.json({ requests });
});

// Get a single payment request by ID (public - shareable link)
app.get('/payment-requests/:id', (req, res) => {
  const db = loadDB();
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: t('error_request_not_found', req.lang || 'en') });
  
  const requester = db.users.find(u => u.id === request.requesterId);
  // Mask email on this public endpoint — only expose enough to identify the requester
  res.json({ 
    request: { id: request.id, amount: request.amount, currency: request.currency, note: request.note, status: request.status, expiresAt: request.expiresAt, requesterId: request.requesterId },
    requesterEmail: maskEmail(requester?.email || 'unknown')
  });
});

// Preview cost of paying a payment request (no transaction executed)
app.post('/payment-requests/:id/preview', authMiddleware, (req, res) => {
  const db = loadDB();
  const { fromWalletId } = req.body;
  if (!fromWalletId) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: t('error_request_not_found', req.lang || 'en') });
  if (request.status !== 'pending') return res.status(400).json({ error: t('error_request_processed', req.lang || 'en') });

  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: t('error_source_wallet_not_found', req.lang || 'en') });

  const rates = db.rates && db.rates.values ? db.rates.values : {};
  const reqCurrency = request.currency;
  const reqAmount = request.amount;

  let debitCurrency = reqCurrency;
  let debitAmount = reqAmount;
  let wasConverted = false;
  let fxFeeAmount = 0;

  const exactBalance = fromWallet.balances.find(b => b.currency === reqCurrency);
  if (!exactBalance || exactBalance.amount < reqAmount) {
    const richest = fromWallet.balances.reduce((best, b) => {
      const valUSD = minorToMajor(b.amount, b.currency) / (rates[b.currency] || 1);
      const bestUSD = best ? minorToMajor(best.amount, best.currency) / (rates[best.currency] || 1) : 0;
      return valUSD > bestUSD ? b : best;
    }, null);

    if (!richest) return res.status(400).json({ error: t('error_insufficient_funds', req.lang || 'en') });

    const reqMajor = minorToMajor(reqAmount, reqCurrency);
    const reqUSD = reqMajor / (rates[reqCurrency] || 1);
    const debitMajor = reqUSD * (rates[richest.currency] || 1);
    const baseDebit = majorToMinor(debitMajor, richest.currency);

    // Safety guard: reject if FX conversion produces a nonsensical result
    const fxGuard = fxSafetyCheck(baseDebit, richest.currency);
    if (!fxGuard.safe) {
      logger.error('[FX] Safety check failed in /preview', { reqCurrency, richest: richest.currency, reqAmount, baseDebit, reason: fxGuard.reason });
      return res.status(500).json({ error: 'FX conversion error — please retry' });
    }

    const fxFeeRate = 0.0115;
    fxFeeAmount = Math.round(baseDebit * fxFeeRate);
    debitAmount = baseDebit + fxFeeAmount;
    debitCurrency = richest.currency;
    wasConverted = true;
  }

  res.json({
    debitAmount,
    debitCurrency,
    creditAmount: reqAmount,
    creditCurrency: reqCurrency,
    wasConverted,
    fxFeeAmount,
    fxFeeRate: wasConverted ? 0.0115 : 0,
  });
});

// Pay a payment request
app.post('/payment-requests/:id/pay', authMiddleware, async (req, res) => {
  const { fromWalletId } = req.body;
  if (!fromWalletId) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });

  // Idempotency — prevents double-charge on timeout + client retry.
  const prClientKey = req.body.idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (!prClientKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  const prCached0 = idempotencyStore.get(prClientKey);
  if (prCached0 && prCached0.userId === req.user.userId && Date.now() - prCached0.timestamp < IDEMPOTENCY_EXPIRY)
    return res.status(200).json(prCached0.response);

  return withBalanceMutex(async () => {
  const db = loadDB();

  // Durable idempotency — survives restart (check DB after acquiring mutex).
  if (prClientKey) {
    const prDurableHit = checkDurableIdempotency(db, prClientKey, req.user.userId);
    if (prDurableHit) {
      idempotencyStore.set(prClientKey, { userId: req.user.userId, response: prDurableHit, timestamp: Date.now() });
      return res.status(200).json(prDurableHit);
    }
  }

  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: t('error_request_not_found', req.lang || 'en') });

  // Idempotent replay — payment already succeeded for this payer.
  if (request.status === 'paid') {
    if (request.paidBy === req.user.userId && request.transactionId) {
      const existingTx = db.transactions.find(tx => tx.id === request.transactionId);
      const replayBody = { request, transaction: existingTx, idempotentReplay: true };
      if (prClientKey) {
        saveDurableIdempotency(db, prClientKey, replayBody, req.user.userId);
        idempotencyStore.set(prClientKey, { userId: req.user.userId, response: replayBody, timestamp: Date.now() });
      }
      return res.status(200).json(replayBody);
    }
    return res.status(400).json({ error: t('error_request_processed', req.lang || 'en') });
  }
  if (request.status !== 'pending') return res.status(400).json({ error: t('error_request_processed', req.lang || 'en') });
  
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: t('error_source_wallet_not_found', req.lang || 'en') });
  
  const toWallet = db.wallets.find(w => w.id === request.walletId);
  if (!toWallet) return res.status(404).json({ error: t('error_destination_wallet_not_found', req.lang || 'en') });

  normalizeWalletBalances(fromWallet);
  normalizeWalletBalances(toWallet);

  const rates = db.rates && db.rates.values ? db.rates.values : {};
  const reqCurrency = request.currency;
  const reqAmount = request.amount; // in minor units

  // Determine which balance the payer will debit from.
  let payFromBalance = getWalletBalanceEntry(fromWallet, reqCurrency);
  let debitCurrency = reqCurrency;
  let debitAmount = reqAmount; // minor units in debitCurrency
  let wasConverted = false;
  let fxFeeAmount = 0;

  // High-3: payroll_request payments must be settled in the exact requested currency.
  // Cross-currency FX is not permitted for payroll — bulk-payment (POST /employer/bulk-payment)
  // enforces the same rule, and mixing paths must produce consistent compliance records.
  if (request.type === 'payroll_request') {
    const exactPayrollBalance = getWalletBalanceEntry(fromWallet, reqCurrency);
    if (!exactPayrollBalance || exactPayrollBalance.amount < reqAmount) {
      logger.warn('[/payment-requests/pay] Payroll pay rejected — no exact-currency balance on funding wallet', {
        requestId: request.id, reqCurrency, reqAmount,
        available: exactPayrollBalance ? exactPayrollBalance.amount : 0,
      });
      return res.status(400).json({
        error: `Payroll payments require an exact ${reqCurrency} balance on the funding wallet. FX conversion is not permitted for payroll.`,
      });
    }
    // Pre-assign payFromBalance to bypass the FX block entirely.
    payFromBalance = exactPayrollBalance;
  }

  if (!payFromBalance || payFromBalance.amount < reqAmount) {
    // Try cross-currency: pick payer's richest balance (highest USD value)
    const richest = fromWallet.balances.reduce((best, b) => {
      const valUSD = minorToMajor(b.amount, b.currency) / (rates[b.currency] || 1);
      const bestUSD = best ? minorToMajor(best.amount, best.currency) / (rates[best.currency] || 1) : 0;
      return valUSD > bestUSD ? b : best;
    }, null);

    if (!richest) return res.status(400).json({ error: t('error_insufficient_funds', req.lang || 'en') });

    // Convert request amount (reqCurrency → USD → richest currency) to find how much to debit
    const reqMajor = minorToMajor(reqAmount, reqCurrency);
    const reqUSD = reqMajor / (rates[reqCurrency] || 1);
    const debitMajor = reqUSD * (rates[richest.currency] || 1);
    debitAmount = majorToMinor(debitMajor, richest.currency);

    // Safety guard: reject if FX conversion produces a nonsensical result
    const fxGuard = fxSafetyCheck(debitAmount, richest.currency);
    if (!fxGuard.safe) {
      logger.error('[FX] Safety check failed in /pay', { reqCurrency, richest: richest.currency, reqAmount, debitAmount, reason: fxGuard.reason });
      return res.status(500).json({ error: 'FX conversion error — please retry' });
    }

    if (richest.amount < debitAmount) {
      return res.status(400).json({ error: t('error_insufficient_funds', req.lang || 'en') });
    }

    payFromBalance = richest;
    debitCurrency = richest.currency;
    wasConverted = true;
    // FX fee (1.15%) is charged ON TOP of the debit — sender pays more, receiver gets full amount.
    const fxFeeRate = 0.0115;
    fxFeeAmount = Math.round(debitAmount * fxFeeRate); // in sender's currency minor units
    debitAmount = debitAmount + fxFeeAmount; // sender pays reqAmount equivalent + fee
  }

  // Check balance (covers both exact-match and cross-currency paths)
  if (!payFromBalance || payFromBalance.amount < debitAmount) {
    return res.status(400).json({ error: t('error_insufficient_funds', req.lang || 'en') });
  }

  // Block cross-currency pay in production when FX rates are stale — before any balance mutation
  if (wasConverted && NODE_ENV === 'production') {
    const prRatesAgeMs = Date.now() - (db.rates?.updatedAt || 0);
    if (prRatesAgeMs > FX_STALE_THRESHOLD_MS) {
      logger.error('[/payment-requests/pay] Stale FX rates — blocking cross-currency pay in production', {
        ageHours: (prRatesAgeMs / 3600000).toFixed(1),
        reqCurrency,
        debitCurrency,
      });
      return res.status(503).json({
        error: 'FX rates are outdated. Cross-currency payment is temporarily unavailable. Please try again shortly.',
      });
    }
  }

  // KYC tier limits — same enforcement as POST /transactions and POST /exchange.
  // Uses debitAmount (the full cost to the payer in their currency, including any FX fee).
  const prPayerUser = db.users.find(u => u.id === req.user.userId);
  if (!prPayerUser) return res.status(404).json({ error: t('error_sender_not_found', req.lang || 'en') });
  const prDebitMajor = minorToMajor(debitAmount, debitCurrency);
  const prDebitUSD   = prDebitMajor / ((rates[debitCurrency]) || 1);
  const prLimitCheck = checkKYCLimits(prPayerUser, prDebitUSD, db);
  if (!prLimitCheck.allowed) {
    return res.status(403).json({
      code:                'LIMIT_EXCEEDED',
      error:               prLimitCheck.message,
      limitType:           prLimitCheck.limitType,
      remainingDailyUSD:   prLimitCheck.remainingDailyUSD,
      remainingWeeklyUSD:  prLimitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: prLimitCheck.remainingMonthlyUSD,
      tierLevel:           prLimitCheck.tierLevel,
      nextTier:            prLimitCheck.nextTier,
    });
  }

  // C-1 (defense-in-depth): reject non-positive stored amounts before any mutation.
  // The creation path now blocks this, but old records or manual DB edits could slip through.
  if (!Number.isInteger(reqAmount) || reqAmount <= 0) {
    logger.error('[/payment-requests/pay] Non-positive reqAmount blocked', { requestId: request.id, reqAmount });
    return res.status(400).json({ error: 'Payment request has an invalid amount.' });
  }

  // Payroll AML limits — apply the employer's separate daily/monthly cap when
  // this is a worker-initiated payroll request.  Mirrors POST /employer/bulk-payment.
  // Resolve employer ID from all field names used across legacy and new create paths:
  //   - request.employerId        — new POST /employer/payment-request path
  //   - request.targetEmployerId  — legacy POST /payment-requests employer branch
  //   - request.payrollMetadata.employerId — fallback stored on creation
  let prPayrollEmployer = null;
  let prPayrollAmountUSD = 0;
  if (request.type === 'payroll_request') {
    const payrollEmployerId = request.employerId
      || request.targetEmployerId
      || request.payrollMetadata?.employerId;

    // H-2: If we cannot resolve the employer, refuse the payment rather than
    // silently skipping payroll AML checks.
    if (!payrollEmployerId) {
      logger.error('[/payment-requests/pay] payroll_request has no resolvable employerId', { requestId: request.id });
      return res.status(403).json({ error: 'Payroll request has no associated employer. Payment blocked.' });
    }

    prPayrollEmployer = (db.employers || []).find(e => e.id === payrollEmployerId);

    if (!prPayrollEmployer) {
      logger.error('[/payment-requests/pay] payroll_request employer not found', { requestId: request.id, payrollEmployerId });
      return res.status(403).json({ error: 'Employer record not found. Payment blocked.' });
    }

    // H-1: Only the employer (the account that owns the employer record) may pay
    // a payroll_request.  Any other payer would debit personal wallet funds and
    // skew the employer's payroll AML limit tracking.
    if (req.user.userId !== prPayrollEmployer.userId) {
      logger.warn('[/payment-requests/pay] Non-employer attempted to pay payroll_request', {
        requestId: request.id,
        payerId: req.user.userId,
        employerUserId: prPayrollEmployer.userId,
      });
      return res.status(403).json({ error: 'Only the employer may fulfill a payroll payment request.' });
    }

    // High-1: Re-check active employer-worker linkage at pay time.
    // The worker may have been removed or suspended after the request was created.
    // request.userId holds the worker's userId on the new POST /employer/payment-request path;
    // request.requesterId holds it on the legacy POST /payment-requests employer branch.
    const prWorkerUserId = request.requesterId || request.userId;
    const prActiveLinkage = (db.employerEmployees || []).find(ee =>
      ee.employerId === prPayrollEmployer.id &&
      ee.workerId === prWorkerUserId &&
      ee.status === 'active'
    );
    if (!prActiveLinkage) {
      logger.warn('[/payment-requests/pay] Worker no longer actively linked to employer at pay time', {
        requestId: request.id,
        employerId: prPayrollEmployer.id,
        workerUserId: prWorkerUserId,
      });
      return res.status(403).json({
        error: 'Worker is no longer actively linked to this employer. Payment blocked.',
      });
    }

    // H-3: Re-verify employer status at pay time — employer may have been
    // suspended/rejected after the payroll request was created.
    if (prPayrollEmployer.verificationStatus !== 'verified') {
      logger.warn('[/payment-requests/pay] Employer no longer verified at pay time', {
        requestId: request.id,
        employerId: prPayrollEmployer.id,
        verificationStatus: prPayrollEmployer.verificationStatus,
      });
      return res.status(403).json({
        error: 'Employer is no longer verified. Payment cannot be processed.',
      });
    }
    prPayrollAmountUSD = convertToUSD(minorToMajor(reqAmount, reqCurrency), reqCurrency, db.rates);
    const prPayrollCheck = checkPayrollLimits(prPayrollEmployer, prPayrollAmountUSD, req.lang || 'en');
    if (!prPayrollCheck.allowed) {
      logger.warn('[/payment-requests/pay] Payroll limit exceeded for payroll_request', {
        requestId: request.id,
        employerId: prPayrollEmployer.id,
        prPayrollAmountUSD: prPayrollAmountUSD.toFixed(2),
        limitType: prPayrollCheck.limitType,
      });
      return res.status(403).json({
        code:                prPayrollCheck.code,
        error:               prPayrollCheck.message,
        limitType:           prPayrollCheck.limitType,
        remainingDailyUSD:   prPayrollCheck.remainingDailyUSD,
        remainingMonthlyUSD: prPayrollCheck.remainingMonthlyUSD,
      });
    }

    // High-4: Payroll payments must be debited from the employer's dedicated funding
    // wallet, not a personal wallet.  This preserves payroll accounting integrity and
    // prevents the employer from using personal funds to satisfy a payroll obligation
    // while the funding wallet balance remains untouched.
    if (prPayrollEmployer.fundingWalletId && fromWallet.id !== prPayrollEmployer.fundingWalletId) {
      logger.warn('[/payment-requests/pay] Employer attempted payroll pay from non-funding wallet', {
        requestId: request.id,
        employerId: prPayrollEmployer.id,
        fromWalletId: fromWallet.id,
        fundingWalletId: prPayrollEmployer.fundingWalletId,
      });
      return res.status(403).json({
        error: 'Payroll payments must be made from the employer funding wallet.',
      });
    }

    // 24-hour per-worker settlement guard — mirrors the same check in bulk-payment.
    // Prevents double payment when:
    //   (a) employer already bulk-paid worker W and W creates a new request (bulk→request)
    //   (b) employer already paid one request for W and W opens a second one (request→request)
    const prWorkerToCheck = request.userId || request.requesterId;
    const prSettleWindow = 24 * 60 * 60 * 1000;
    const prNowSettle = Date.now();
    const prAlreadyPaidViaRequest = (db.paymentRequests || []).some(pr =>
      pr.id !== request.id &&
      pr.type === 'payroll_request' &&
      pr.status === 'paid' &&
      (pr.userId === prWorkerToCheck || pr.requesterId === prWorkerToCheck) &&
      (pr.employerId === prPayrollEmployer.id || pr.targetEmployerId === prPayrollEmployer.id) &&
      pr.paidAt && (prNowSettle - pr.paidAt) < prSettleWindow
    );
    const prAlreadyPaidViaBulk = (db.transactions || []).some(tx =>
      tx.type === 'payroll' &&
      tx.status === 'completed' &&
      tx.payrollMetadata?.employerId === prPayrollEmployer.id &&
      tx.payrollMetadata?.workerId === prWorkerToCheck &&
      tx.timestamp && (prNowSettle - tx.timestamp) < prSettleWindow
    );
    if (prAlreadyPaidViaRequest || prAlreadyPaidViaBulk) {
      logger.warn('[/payment-requests/pay] Payroll worker already settled within 24h', {
        requestId: request.id,
        employerId: prPayrollEmployer.id,
        workerUserId: prWorkerToCheck,
        via: prAlreadyPaidViaBulk ? 'bulk' : 'request',
      });
      return res.status(409).json({
        error: 'This worker was already paid by this employer within the last 24 hours. Wait 24 hours or verify the payment.',
      });
    }
  }

  // Deduct from payer (in their currency, including FX fee if converted)
  const originalPayFromAmount = payFromBalance.amount;
  let destBalance = getWalletBalanceEntry(toWallet, reqCurrency);
  const originalDestAmount = destBalance ? destBalance.amount : null;

  payFromBalance.amount -= debitAmount;

  // Receiver always gets the exact requested amount — fee came from sender
  const creditAmount = reqAmount;
  if (destBalance) destBalance.amount += creditAmount;
  else {
    destBalance = { currency: reqCurrency, amount: creditAmount };
    toWallet.balances.push(destBalance);
  }

  // Integrity: payer must lose funds; receiver must gain funds.
  if (payFromBalance.amount >= originalPayFromAmount || creditAmount <= 0) {
    logger.error('[/payment-requests/pay] INTEGRITY FAIL — payer balance did not decrease', {
      requestId: request.id, originalPayFromAmount, debitAmount,
    });
    payFromBalance.amount = originalPayFromAmount;
    if (destBalance && originalDestAmount !== null) destBalance.amount = originalDestAmount;
    else if (destBalance) toWallet.balances = toWallet.balances.filter(b => b !== destBalance);
    return res.status(500).json({ error: t('error_transaction_persist', req.lang || 'en') });
  }
  
  // Create transaction with proper tagging
  const tx = {
    id: uuidv4(),
    fromWalletId,
    toWalletId: request.walletId,
    amount: debitAmount,
    currency: debitCurrency,
    receivedAmount: creditAmount,
    receivedCurrency: reqCurrency,
    wasConverted,
    fxFeeAmount,
    sendFeeAmount: 0,
    memo: `Payment for request: ${request.memo}`,
    status: 'completed',
    timestamp: Date.now(),
    type: request.type || 'personal', // Tag as payroll_request or personal_request
  };
  
  // Add payroll metadata if this is an employer request payment
  if (request.type === 'payroll_request' && request.payrollMetadata) {
    tx.payrollMetadata = request.payrollMetadata;
    tx.complianceFlags = request.complianceFlags;
    
    // Audit log for employer payments
    logger.info('Employer payment request fulfilled', {
      requestId: request.id,
      transactionId: tx.id,
      employerId: request.payrollMetadata.employerId,
      workerId: request.payrollMetadata.workerId,
      paidBy: req.user.userId,
      amount: request.amount,
      currency: request.currency
    });
  }
  
  db.transactions.push(tx);

  // Update request
  request.status = 'paid';
  request.paidAt = Date.now();
  request.paidBy = req.user.userId;
  request.transactionId = tx.id;

  // Increment KYC limit tracking — prPayerUser is a reference inside db.users,
  // so saveDB below persists the updated counters atomically with the balance change.
  updateLimitTracking(prPayerUser, prDebitUSD);

  // H-1: Increment employer payroll limit tracking for payroll_request payments.
  // prPayrollEmployer is a reference inside db.employers — persisted by saveDB below.
  if (prPayrollEmployer) {
    updatePayrollLimitTracking(prPayrollEmployer, prPayrollAmountUSD);
  }

  // Build response and save idempotency record atomically with the balance mutation.
  // A crash after saveDB leaves a durable record — replay returns cached response.
  const prResponseBody = { request, transaction: tx };
  if (prClientKey) saveDurableIdempotency(db, prClientKey, prResponseBody, req.user.userId);

  saveDB(db); // commits balances + transaction + request.status + idempotency atomically

  if (prClientKey) idempotencyStore.set(prClientKey, { userId: req.user.userId, response: prResponseBody, timestamp: Date.now() });

  // Notify payer
  const payerUser = db.users.find(u => u.id === req.user.userId);
  createNotification(db, req.user.userId, 'money_sent',
    'Payment Sent',
    `You paid ${minorToMajor(request.amount, request.currency).toFixed(decimalsFor(request.currency))} ${request.currency}${request.memo ? ` for "${request.memo}"` : ''}`,
    { transactionId: tx.id, requestId: request.id, amount: request.amount, currency: request.currency });

  // Notify requester (wallet owner)
  const requesterUser = db.users.find(u => u.id === toWallet.userId);
  createNotification(db, toWallet.userId, 'money_received',
    'Payment Received',
    `You received ${minorToMajor(request.amount, request.currency).toFixed(decimalsFor(request.currency))} ${request.currency} from ${payerUser?.fullName || payerUser?.username || payerUser?.email || 'someone'}${request.memo ? ` for "${request.memo}"` : ''}`,
    { transactionId: tx.id, requestId: request.id, amount: request.amount, currency: request.currency });

  saveDB(db);

  res.json(prResponseBody);
  }); // withBalanceMutex
});

// Cancel a payment request
app.post('/payment-requests/:id/cancel', authMiddleware, (req, res) => {
  const db = loadDB();
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: t('error_request_not_found', req.lang || 'en') });
  // High-1: new-path creates store userId (not requesterId); accept either field.
  const cancelOwnerId = request.requesterId || request.userId;
  if (cancelOwnerId !== req.user.userId) return res.status(403).json({ error: t('error_unauthorized', req.lang || 'en') });
  if (request.status !== 'pending') return res.status(400).json({ error: t('error_request_processed', req.lang || 'en') });
  
  request.status = 'cancelled';
  saveDB(db);
  res.json({ request });
});

// ==================== VIRTUAL CARDS ====================
// Create virtual card
app.post('/virtual-cards', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, currency, label, idempotencyKey } = req.body;
  if (!walletId || !currency) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached && cached.userId === req.user.userId) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  
  // Check card limit (max 5 cards per user)
  const userCards = (db.virtualCards || []).filter(c => c.userId === req.user.userId && c.status !== 'deleted');
  if (userCards.length >= 5) return res.status(400).json({ error: t('error_max_cards', req.lang || 'en') });
  
  // Generate card details — full PAN/CVV are NEVER written to db.json
  const cardNumber = '4' + Math.floor(Math.random() * 1e15).toString().padStart(15, '0');
  const cvv = Math.floor(Math.random() * 900 + 100).toString();
  const last4 = cardNumber.slice(-4);
  const now = new Date();
  const expiryMonth = (now.getMonth() + 1).toString().padStart(2, '0');
  const expiryYear = (now.getFullYear() + 3).toString().slice(-2);
  
  // Persist only non-sensitive fields — last4 is sufficient for display
  const card = {
    id: uuidv4(),
    userId: req.user.userId,
    walletId,
    last4,
    expiryMonth,
    expiryYear,
    currency,
    label: label || 'Virtual Card',
    status: 'active', // active, frozen, deleted
    createdAt: Date.now(),
    spentToday: 0,
    dailyLimit: majorToMinor(1000, currency) // $1000 daily limit
  };
  
  if (!db.virtualCards) db.virtualCards = [];
  db.virtualCards.push(card);
  saveDB(db);
  
  // Return full PAN/CVV exactly once in the creation response — they cannot be retrieved later
  const response = { card: { ...card, cardNumber, cvv } };

  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { userId: req.user.userId, response, timestamp: Date.now() });
  }

  res.json(response);
});

// List virtual cards
app.get('/virtual-cards', authMiddleware, (req, res) => {
  const db = loadDB();
  const cards = (db.virtualCards || [])
    .filter(c => c.userId === req.user.userId && c.status !== 'deleted')
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ cards: cards.map(sanitizeCard) });
});

// Get single card
app.get('/virtual-cards/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: t('error_card_not_found', req.lang || 'en') });
  res.json({ card: sanitizeCard(card) });
});

// Freeze/unfreeze card
app.post('/virtual-cards/:id/toggle-freeze', authMiddleware, (req, res) => {
  const db = loadDB();
  const { idempotencyKey } = req.body;
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached && cached.userId === req.user.userId) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: t('error_card_not_found', req.lang || 'en') });
  if (card.status === 'deleted') return res.status(400).json({ error: t('error_card_deleted', req.lang || 'en') });
  
  card.status = card.status === 'active' ? 'frozen' : 'active';
  saveDB(db);

  const response = { card: sanitizeCard(card) };

  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { userId: req.user.userId, response, timestamp: Date.now() });
  }

  res.json(response);
});

// Delete card
app.delete('/virtual-cards/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: t('error_card_not_found', req.lang || 'en') });
  
  card.status = 'deleted';
  saveDB(db);
  res.json({ success: true });
});

// ==================== QR CODES & PAYMENT REQUESTS ====================
// Generate static QR (user identity - permanent)
app.get('/qr/static', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  if (userWallets.length === 0) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  
  // Static QR payload - never expires, always points to user
  const qrPayload = {
    v: '1',
    type: 'static',
    userId: req.user.userId,
    walletId: userWallets[0].id,
    displayName: user.email.split('@')[0],
    timestamp: Date.now()
  };
  
  // HMAC-sign the static QR so /qr/pay can verify the userId was issued by this server
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`static-qr:${req.user.userId}`)
    .digest('hex')
    .slice(0, 32);
  const qrString = `egwallet://pay/${req.user.userId}?sig=${sig}`;
  
  res.json({
    qrCode: qrString,
    payload: qrPayload,
    displayText: `Pay ${user.email.split('@')[0]}`
  });
});

// Generate dynamic QR (payment request with amount - expires)
app.post('/qr/dynamic', authMiddleware, (req, res) => {
  const db = loadDB();
  const { amount, currency, memo, expiryMinutes } = req.body;
  
  if (!amount || !currency) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }

  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  if (userWallets.length === 0) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  
  // Create dynamic QR with expiry
  const qrId = uuidv4();
  const expiry = Date.now() + ((expiryMinutes || 15) * 60 * 1000); // Default 15 min
  const nonce = crypto.randomBytes(16).toString('hex');
  
  // Create payment request object
  const request = {
    id: qrId,
    requesterId: req.user.userId,
    walletId: userWallets[0].id,
    amount,
    currency,
    memo: memo || '',
    status: 'pending',
    type: 'qr_dynamic',
    createdAt: Date.now(),
    expiry,
    nonce,
    paidAt: null,
    paidBy: null,
    transactionId: null
  };
  
  if (!db.paymentRequests) db.paymentRequests = [];
  db.paymentRequests.push(request);
  
  // QR payload with signature
  const qrPayload = {
    v: '1',
    type: 'dynamic',
    requestId: qrId,
    userId: req.user.userId,
    amount,
    currency,
    memo: memo || '',
    expiry,
    nonce
  };
  
  // Sign payload (simplified - in production use HMAC)
  const payloadString = JSON.stringify(qrPayload);
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadString)
    .digest('hex');
  
  qrPayload.signature = signature;
  
  if (!db.qrCodes) db.qrCodes = [];
  db.qrCodes.push({
    id: qrId,
    userId: req.user.userId,
    type: 'dynamic',
    payload: qrPayload,
    createdAt: Date.now(),
    expiry,
    used: false
  });
  
  saveDB(db);
  
  const qrString = `egwallet://pay?r=${qrId}&a=${amount}&c=${currency}&s=${signature.substring(0, 16)}`;
  
  res.json({
    qrCode: qrString,
    requestId: qrId,
    payload: qrPayload,
    expiresAt: expiry,
    displayText: `${amount} ${currency}${memo ? ` - ${memo}` : ''}`
  });
});

// Validate QR code
app.post('/qr/validate', authMiddleware, (req, res) => {
  const db = loadDB();
  const { qrString } = req.body;
  
  if (!qrString) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  
  // Parse QR string
  if (qrString.startsWith('egwallet://pay/')) {
    // Static QR
    const userId = qrString.replace('egwallet://pay/', '');
    const user = db.users.find(u => u.id === userId);
    
    if (!user) {
      return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en'), valid: false });
    }
    
    const userWallet = db.wallets.find(w => w.userId === userId);
    
    return res.json({
      valid: true,
      type: 'static',
      userId: userId,
      walletId: userWallet?.id,
      displayName: user.email.split('@')[0],
      requiresAmount: true
    });
  }
  
  // Dynamic QR
  const url = new URL(qrString);
  const requestId = url.searchParams.get('r');
  
  if (!requestId) {
    return res.status(400).json({ error: t('error_invalid_qr_format', req.lang || 'en'), valid: false });
  }
  
  const qrCode = db.qrCodes?.find(qr => qr.id === requestId);
  const request = db.paymentRequests?.find(r => r.id === requestId);
  
  if (!qrCode || !request) {
    return res.status(404).json({ error: t('error_qr_not_found', req.lang || 'en'), valid: false });
  }
  
  // Check expiry
  if (Date.now() > qrCode.expiry) {
    return res.json({
      valid: false,
      error: t('error_qr_expired', req.lang || 'en'),
      expiredAt: qrCode.expiry
    });
  }
  
  // Check if already used
  if (qrCode.used || request.status !== 'pending') {
    return res.json({
      valid: false,
      error: t('error_qr_used', req.lang || 'en'),
      status: request.status
    });
  }
  
  // Verify signature
  const payloadString = JSON.stringify({
    v: qrCode.payload.v,
    type: qrCode.payload.type,
    requestId: qrCode.payload.requestId,
    userId: qrCode.payload.userId,
    amount: qrCode.payload.amount,
    currency: qrCode.payload.currency,
    memo: qrCode.payload.memo,
    expiry: qrCode.payload.expiry,
    nonce: qrCode.payload.nonce
  });
  
  const expectedSignature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadString)
    .digest('hex');
  
  if (qrCode.payload.signature !== expectedSignature) {
    return res.json({
      valid: false,
      error: t('error_qr_fraud', req.lang || 'en')
    });
  }
  
  const requester = db.users.find(u => u.id === request.requesterId);
  
  res.json({
    valid: true,
    type: 'dynamic',
    requestId: request.id,
    amount: request.amount,
    currency: request.currency,
    memo: request.memo,
    requester: {
      userId: requester.id,
      displayName: requester.email.split('@')[0]
    },
    expiresAt: qrCode.expiry,
    requiresAmount: false
  });
});

// Pay via QR code
app.post('/qr/pay', authMiddleware, async (req, res) => {
  const { qrString, fromWalletId, amount, currency, idempotencyKey } = req.body;

  if (!qrString || !fromWalletId) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }

  // ── Idempotency check (same pattern as POST /transactions) ─────────────
  const clientKey = idempotencyKey ||
    req.headers['idempotency-key'] ||
    req.headers['x-idempotency-key'];
  if (!clientKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  const cached0 = idempotencyStore.get(clientKey);
  if (cached0 && cached0.userId === req.user.userId && Date.now() - cached0.timestamp < IDEMPOTENCY_EXPIRY) {
    return res.status(200).json(cached0.response);
  }

  return withBalanceMutex(async () => {
  const db = loadDB();

  // Durable idempotency — survives restart
  if (clientKey) {
    const durableHit = checkDurableIdempotency(db, clientKey, req.user.userId);
    if (durableHit) {
      idempotencyStore.set(clientKey, { userId: req.user.userId, response: durableHit, timestamp: Date.now() });
      return res.status(200).json(durableHit);
    }
  }

  // Validate QR first
  let targetUserId, targetWalletId, paymentAmount, paymentCurrency, requestId, memo;
  
  if (qrString.startsWith('egwallet://pay/')) {
    // Static QR — requires amount from payer and server-issued HMAC signature
    if (!amount || !currency) {
      return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
    }
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
      return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
    }

    const sepIdx = qrString.indexOf('?');
    targetUserId = qrString.slice('egwallet://pay/'.length, sepIdx === -1 ? undefined : sepIdx);
    const sigParam = sepIdx !== -1 ? new URLSearchParams(qrString.slice(sepIdx + 1)).get('sig') : null;

    // Verify HMAC — unsigned or tampered QR strings are rejected
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`static-qr:${targetUserId}`)
      .digest('hex')
      .slice(0, 32);
    const sigBuf = Buffer.from(sigParam || '');
    const expBuf = Buffer.from(expectedSig);
    const sigValid = sigBuf.length === expBuf.length &&
      crypto.timingSafeEqual(sigBuf, expBuf);
    if (!sigValid) {
      logger.warn('Static QR signature invalid or missing', { userId: req.user.userId, targetUserId });
      return res.status(400).json({ error: 'Invalid or unsigned QR code. Ask the recipient to re-generate their QR from the app.' });
    }

    const targetUser = db.users.find(u => u.id === targetUserId);
    if (!targetUser) return res.status(404).json({ error: t('error_recipient_not_found', req.lang || 'en') });

    targetWalletId = db.wallets.find(w => w.userId === targetUserId)?.id;
    paymentAmount = amount;
    paymentCurrency = currency;
    memo = 'QR Payment';

  } else {
    // Dynamic QR - amount embedded
    const url = new URL(qrString);
    requestId = url.searchParams.get('r');
    
    const request = db.paymentRequests?.find(r => r.id === requestId);
    if (!request) return res.status(404).json({ error: t('error_request_not_found', req.lang || 'en') });
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: t('error_request_processed', req.lang || 'en') });
    }
    
    const qrCode = db.qrCodes?.find(qr => qr.id === requestId);
    if (!qrCode) return res.status(404).json({ error: t('error_qr_not_found', req.lang || 'en') });
    
    if (Date.now() > qrCode.expiry) {
      return res.status(400).json({ error: t('error_qr_expired', req.lang || 'en') });
    }
    
    targetUserId = request.requesterId;
    targetWalletId = request.walletId;
    paymentAmount = request.amount;
    paymentCurrency = request.currency;
    memo = request.memo || 'QR Payment';
  }
  
  // Verify payer wallet
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: t('error_source_wallet_not_found', req.lang || 'en') });
  
  const toWallet = db.wallets.find(w => w.id === targetWalletId);
  if (!toWallet) return res.status(404).json({ error: t('error_destination_wallet_not_found', req.lang || 'en') });
  
  // Check balance
  normalizeWalletBalances(fromWallet);
  normalizeWalletBalances(toWallet);
  const debitEntry = getWalletBalanceEntry(fromWallet, paymentCurrency);
  if (!debitEntry || debitEntry.amount < paymentAmount) {
    return res.status(400).json({ error: t('error_insufficient_funds', req.lang || 'en') });
  }

  // KYC tier limits — same enforcement as POST /transactions and POST /exchange
  const qrPayingUser = db.users.find(u => u.id === req.user.userId);
  if (!qrPayingUser) return res.status(404).json({ error: t('error_sender_not_found', req.lang || 'en') });
  const qrAmountMajor = minorToMajor(paymentAmount, paymentCurrency);
  const qrAmountUSD = qrAmountMajor / ((db.rates?.values || {})[paymentCurrency] || 1);
  const qrLimitCheck = checkKYCLimits(qrPayingUser, qrAmountUSD, db);
  if (!qrLimitCheck.allowed) {
    return res.status(403).json({
      code: 'LIMIT_EXCEEDED',
      error: qrLimitCheck.message,
      limitType: qrLimitCheck.limitType,
      remainingDailyUSD: qrLimitCheck.remainingDailyUSD,
      remainingWeeklyUSD: qrLimitCheck.remainingWeeklyUSD,
      remainingMonthlyUSD: qrLimitCheck.remainingMonthlyUSD,
      tierLevel: qrLimitCheck.tierLevel,
    });
  }

  // Process payment
  const originalQrFromAmount = debitEntry.amount;
  let qrDestBalance = getWalletBalanceEntry(toWallet, paymentCurrency);
  const originalQrDestAmount = qrDestBalance ? qrDestBalance.amount : null;

  debitEntry.amount -= paymentAmount;

  if (qrDestBalance) qrDestBalance.amount += paymentAmount;
  else {
    qrDestBalance = { currency: paymentCurrency, amount: paymentAmount };
    toWallet.balances.push(qrDestBalance);
  }

  if (debitEntry.amount >= originalQrFromAmount) {
    logger.error('[/qr/pay] INTEGRITY FAIL — payer balance did not decrease', { originalQrFromAmount, paymentAmount });
    debitEntry.amount = originalQrFromAmount;
    if (qrDestBalance && originalQrDestAmount !== null) qrDestBalance.amount = originalQrDestAmount;
    else if (qrDestBalance) toWallet.balances = toWallet.balances.filter(b => b !== qrDestBalance);
    return res.status(500).json({ error: t('error_transaction_persist', req.lang || 'en') });
  }
  
  // Create transaction
  const tx = {
    id: uuidv4(),
    fromWalletId,
    toWalletId: targetWalletId,
    amount: paymentAmount,
    currency: paymentCurrency,
    receivedAmount: paymentAmount,
    receivedCurrency: paymentCurrency,
    wasConverted: false,
    memo: memo,
    type: 'qr_payment',
    status: 'completed',
    timestamp: Date.now()
  };
  
  if (!db.transactions) db.transactions = [];
  db.transactions.push(tx);
  
  // Mark QR as used if dynamic
  if (requestId) {
    const qrCode = db.qrCodes.find(qr => qr.id === requestId);
    if (qrCode) qrCode.used = true;

    const request = db.paymentRequests.find(r => r.id === requestId);
    if (request) {
      request.status = 'paid';
      request.paidAt = Date.now();
      request.paidBy = req.user.userId;
      request.transactionId = tx.id;
    }
  }

  // Increment KYC limit tracking — qrPayingUser is a reference inside db.users,
  // persisted atomically with the balance change by saveDB below.
  updateLimitTracking(qrPayingUser, qrAmountUSD);

  // Notify payer
  const displayAmt = minorToMajor(paymentAmount, paymentCurrency).toFixed(decimalsFor(paymentCurrency));
  createNotification(db, req.user.userId, 'money_sent',
    'Payment Sent',
    `You paid ${displayAmt} ${paymentCurrency} via QR${memo && memo !== 'QR Payment' ? ` — ${memo}` : ''}`,
    { transactionId: tx.id, amount: paymentAmount, currency: paymentCurrency }
  );

  // Notify receiver
  const payerUser = db.users.find(u => u.id === req.user.userId);
  const payerName = payerUser
    ? `${payerUser.firstName || ''} ${payerUser.lastName || ''}`.trim() || payerUser.email.split('@')[0]
    : 'Someone';
  createNotification(db, targetUserId, 'money_received',
    'Payment Received',
    `${payerName} paid you ${displayAmt} ${paymentCurrency} via QR${memo && memo !== 'QR Payment' ? ` — ${memo}` : ''}`,
    { transactionId: tx.id, amount: paymentAmount, currency: paymentCurrency }
  );

  // Build response before saveDB so idempotency is committed with the financial mutation.
  const responseBody = {
    success: true,
    transaction: tx,
    message: 'Payment successful',
  };
  if (clientKey) saveDurableIdempotency(db, clientKey, responseBody, req.user.userId);

  saveDB(db); // commits balances + tx + QR state + limit tracking + idempotency atomically

  if (clientKey) idempotencyStore.set(clientKey, { userId: req.user.userId, response: responseBody, timestamp: Date.now() });

  logger.info('QR payment completed', {
    transactionId: tx.id,
    fromUserId: req.user.userId,
    toUserId: targetUserId,
    amount: paymentAmount,
    currency: paymentCurrency,
    qrType: requestId ? 'dynamic' : 'static'
  });

  res.json(responseBody);
  }); // withBalanceMutex
});

// ==================== BUDGETS ====================
// Create or update budget
app.post('/budgets', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, currency, monthlyLimit, categoryLimits, idempotencyKey } = req.body;
  if (!walletId || !currency || typeof monthlyLimit === 'undefined') {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached && cached.userId === req.user.userId) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  
  if (!db.budgets) db.budgets = [];
  
  // Check if budget already exists for this wallet+currency
  let budget = db.budgets.find(b => b.walletId === walletId && b.currency === currency && b.userId === req.user.userId);
  
  if (budget) {
    // Update existing
    budget.monthlyLimit = monthlyLimit;
    budget.categoryLimits = categoryLimits || {};
    budget.updatedAt = Date.now();
  } else {
    // Create new
    budget = {
      id: uuidv4(),
      userId: req.user.userId,
      walletId,
      currency,
      monthlyLimit,
      categoryLimits: categoryLimits || {}, // { 'Food': 500, 'Transport': 200, etc }
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    db.budgets.push(budget);
  }
  
  saveDB(db);
  
  const response = { budget };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { userId: req.user.userId, response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// Get budgets
app.get('/budgets', authMiddleware, (req, res) => {
  const db = loadDB();
  const budgets = (db.budgets || []).filter(b => b.userId === req.user.userId);
  res.json({ budgets });
});

// Get budget analytics
app.get('/budgets/:id/analytics', authMiddleware, (req, res) => {
  const db = loadDB();
  const budget = (db.budgets || []).find(b => b.id === req.params.id && b.userId === req.user.userId);
  if (!budget) return res.status(404).json({ error: t('error_budget_not_found', req.lang || 'en') });
  
  // Calculate spending for current month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime();
  
  const monthlyTxs = db.transactions.filter(t => 
    t.fromWalletId === budget.walletId &&
    t.currency === budget.currency &&
    t.timestamp >= monthStart &&
    t.timestamp <= monthEnd &&
    t.status === 'completed'
  );
  
  const totalSpent = monthlyTxs.reduce((sum, t) => sum + t.amount, 0);
  const percentUsed = (minorToMajor(totalSpent, budget.currency) / minorToMajor(budget.monthlyLimit, budget.currency)) * 100;
  
  res.json({
    budget,
    analytics: {
      monthlyLimit: budget.monthlyLimit,
      totalSpent,
      remaining: Math.max(0, budget.monthlyLimit - totalSpent),
      percentUsed: Math.min(100, percentUsed),
      transactionCount: monthlyTxs.length,
      month: `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`
    }
  });
});

// Delete budget
app.delete('/budgets/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const idx = (db.budgets || []).findIndex(b => b.id === req.params.id && b.userId === req.user.userId);
  if (idx === -1) return res.status(404).json({ error: t('error_budget_not_found', req.lang || 'en') });
  
  db.budgets.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// Get user's trusted devices
app.get('/devices', authMiddleware, (req, res) => {
  const db = loadDB();
  if (!db.devices) db.devices = [];
  
  const userDevices = db.devices.filter(d => d.userId === req.user.userId);
  
  // Don't send the full fingerprint to client
  const sanitizedDevices = userDevices.map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    trusted: d.trusted
  }));
  
  res.json(sanitizedDevices);
});

// Remove a trusted device
app.delete('/devices/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  if (!db.devices) db.devices = [];
  
  const idx = db.devices.findIndex(d => d.id === req.params.id && d.userId === req.user.userId);
  if (idx === -1) return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  
  db.devices.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// Trust a device
app.post('/devices/:id/trust', authMiddleware, (req, res) => {
  const db = loadDB();
  if (!db.devices) db.devices = [];
  
  const device = db.devices.find(d => d.id === req.params.id && d.userId === req.user.userId);
  if (!device) return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  
  device.trusted = true;
  saveDB(db);
  res.json({ success: true });
});

// Get KYC status
app.get('/kyc/status', authMiddleware, (req, res) => {
  const db = loadDB();
  if (!db.kyc) db.kyc = [];
  
  const userKyc = db.kyc.find(k => k.userId === req.user.userId);
  if (!userKyc) {
    return res.json({ status: 'not_started', documents: [] });
  }
  
  res.json({
    status: userKyc.status,
    documents: userKyc.documents || []
  });
});

// Upload KYC document (simplified for demo)
app.post('/kyc/upload', authMiddleware, (req, res) => {
  const db = loadDB();
  if (!db.kyc) db.kyc = [];
  
  const { documentType } = req.body;
  if (!documentType) return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  
  let userKyc = db.kyc.find(k => k.userId === req.user.userId);
  if (!userKyc) {
    userKyc = {
      userId: req.user.userId,
      status: 'under_review',
      documents: []
    };
    db.kyc.push(userKyc);
  }
  
  const newDoc = {
    id: uuidv4(),
    type: documentType,
    status: 'under_review',
    uploadedAt: Date.now()
  };
  
  userKyc.documents.push(newDoc);
  userKyc.status = 'under_review';
  
  saveDB(db);
  res.json({ success: true, document: newDoc });
});

// ==================== SMILE IDENTITY KYC VERIFICATION ====================
// POST /kyc/verify
// Body: { idType, idNumber, country, firstName?, lastName?, selfieBase64? }
// Calls Smile Identity Basic KYC (job_type 5 — ID verification, no selfie required).
// Falls back to manual review queue when SMILE_PARTNER_ID / SMILE_API_KEY not set.
//
// Required env vars:
//   SMILE_PARTNER_ID  — your Smile Identity partner ID
//   SMILE_API_KEY     — your Smile Identity API key
//   SMILE_API_BASE    — (optional) override base URL; default = sandbox

const SMILE_PARTNER_ID = process.env.SMILE_PARTNER_ID || null;
const SMILE_API_KEY    = process.env.SMILE_API_KEY    || null;
const SMILE_API_BASE   = process.env.SMILE_API_BASE   || 'https://testapi.smileidentity.com/v1';

// HMAC-SHA256 signature as required by Smile Identity REST API
function computeSmileSignature(timestamp, partnerId, apiKey) {
  return crypto.createHmac('sha256', apiKey)
    .update(`${timestamp}${partnerId}`)
    .digest('base64');
}

// Normalise Smile Identity result codes to our internal status
function smileResultToStatus(resultCode) {
  if (resultCode === '0810') return 'approved';
  if (['0811', '0812', '0813', '0814'].includes(resultCode)) return 'rejected';
  return 'under_review';
}

const kycVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: req => req.user?.userId || req.clientIP,
  handler: (req, res) => res.status(429).json({ error: t('error_too_many_kyc', req.lang || 'en') }),
});

app.post('/kyc/verify',
  authMiddleware,
  kycVerifyLimiter,
  validateInput([
    body('idType').trim().notEmpty(),
    body('idNumber').trim().notEmpty(),
    body('country').trim().isLength({ min: 2, max: 3 }),
  ]),
  async (req, res) => {
    const { idType, idNumber, country, firstName, lastName } = req.body;
    const jobId = uuidv4();

    // Compute the canonical identity hash up front — shared across all three phases.
    // Raw ID numbers are never stored; only this one-way hash is persisted.
    const kycIdHash = crypto
      .createHash('sha256')
      .update(`${country.toUpperCase()}:${idType.toUpperCase()}:${idNumber.trim()}`)
      .digest('hex');

    // ── Phase 1 (inside kycMutex): check + atomically reserve the identity hash ─
    // Serialises the read-check-write so no two concurrent requests can both pass
    // the dedup check before either writes the reservation (TOCTOU prevention).
    let p1Err = null;
    await withKycMutex(async () => {
      const db = loadDB();
      const user = db.users.find(u => u.id === req.user.userId);
      if (!user) {
        p1Err = { status: 404, body: { error: t('error_user_not_found', req.lang || 'en') } };
        return;
      }

      if (user.kycDeviceBlocked) {
        logger.warn('KYC verify blocked — kycDeviceBlocked flag set', { userId: user.id, ip: req.clientIP });
        p1Err = {
          status: 403,
          body: {
            error: 'Automated KYC verification is not available for this account. Please contact support for manual review.',
            code: 'KYC_DEVICE_BLOCKED',
          },
        };
        return;
      }

      // Cross-account identity dedup using the persistent kycIdentityClaims table.
      // This is authoritative: it survives rejection/error without clearing the hash,
      // preventing Account B from claiming an ID that Account A has ever submitted.
      if (!db.kycIdentityClaims) db.kycIdentityClaims = {};
      const existingClaim = db.kycIdentityClaims[kycIdHash];
      if (existingClaim && existingClaim.userId !== req.user.userId) {
        logger.warn('KYC identity already claimed by another account', {
          userId: req.user.userId, kycIdHash, claimedBy: existingClaim.userId, claimStatus: existingClaim.status,
        });
        p1Err = {
          status: 409,
          body: { error: 'This identity document is already linked to another account.', code: 'KYC_IDENTITY_CLAIMED' },
        };
        return;
      }

      // Upsert the claim — same-account retries update the existing entry.
      // Status 'pending' blocks concurrent requests for other users immediately.
      const now = Date.now();
      db.kycIdentityClaims[kycIdHash] = {
        userId:    req.user.userId,
        status:    'pending',
        claimedAt: existingClaim?.claimedAt || now,
        updatedAt: now,
      };

      // Write reservation on the user record too (for direct per-user lookups).
      user.kycIdHash = kycIdHash;
      user.kycStatus = 'pending_verification';
      user.kycUpdatedAt = Date.now();
      saveDB(db);
    });

    if (p1Err) return res.status(p1Err.status).json(p1Err.body);

    // ── Manual review fallback (no Smile credentials) ─────────────────────────
    if (!SMILE_PARTNER_ID || !SMILE_API_KEY) {
      await withKycMutex(async () => {
        const db = loadDB();
        const user = db.users.find(u => u.id === req.user.userId);
        if (!user) return;
        user.kycStatus = 'under_review';
        user.kycUpdatedAt = Date.now();
        if (!user.kycDocuments) user.kycDocuments = {};
        user.kycDocuments.pendingVerification = { idType, country, submittedAt: Date.now(), jobId };
        saveDB(db);
      });
      logger.warn('Smile Identity not configured — KYC queued for manual review', {
        userId: req.user.userId, jobId, idType, country,
      });
      return res.json({
        status: 'under_review',
        message: 'Your verification has been submitted and is under manual review.',
        provider: 'manual',
        jobId,
      });
    }

    // ── Phase 2: Call Smile Identity API — mutex NOT held ────────────────────
    // The kycMutex is intentionally released before this await so unrelated KYC
    // requests are not blocked for the full 30-second Smile timeout.
    // The reservation written in Phase 1 is already durable in db.json.
    const timestamp = new Date().toISOString();
    const signature = computeSmileSignature(timestamp, SMILE_PARTNER_ID, SMILE_API_KEY);
    const smilePayload = {
      source_sdk: 'rest_api',
      source_sdk_version: '1.0.0',
      smile_client_id: req.user.userId,
      partner_params: { job_id: jobId, user_id: req.user.userId, job_type: 5 },
      id_info: {
        first_name:  (firstName  || '').toUpperCase(),
        last_name:   (lastName   || '').toUpperCase(),
        country:     country.toUpperCase(),
        id_type:     idType.toUpperCase(),
        id_number:   idNumber,
        entered:     true,
      },
      partner_id: SMILE_PARTNER_ID,
      timestamp,
      signature,
    };

    let smileData = null;
    let smileErr  = null;
    try {
      const smileRes = await axios.post(
        `${SMILE_API_BASE}/id_verification`,
        smilePayload,
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );
      smileData = smileRes.data;
    } catch (err) {
      smileErr = err;
    }

    // ── Phase 3 (inside kycMutex): finalise result with a fresh DB load ──────
    let finalStatus, finalTier, finalResultCode;
    await withKycMutex(async () => {
      const db = loadDB();
      const user = db.users.find(u => u.id === req.user.userId);
      if (!user) return;

      if (!db.kycIdentityClaims) db.kycIdentityClaims = {};

      if (smileErr || !smileData) {
        // Smile call failed — mark claim as 'error' and queue for manual review.
        // kycIdHash is intentionally NOT cleared: keeping the claim in the table
        // prevents Account B from immediately claiming the same ID after A's Smile error.
        logger.error('Smile Identity API error', {
          userId: user.id,
          jobId,
          httpStatus: smileErr?.response?.status,
          errorCode: smileErr?.response?.data?.Code,
          error: smileErr?.message,
          // responseData intentionally omitted — may contain government ID / PII
        });
        user.kycStatus    = 'under_review';
        user.kycSmileJobId = jobId;
        user.kycUpdatedAt  = Date.now();
        // Update claim status — other accounts are still blocked
        if (db.kycIdentityClaims[kycIdHash]?.userId === req.user.userId) {
          db.kycIdentityClaims[kycIdHash].status    = 'error';
          db.kycIdentityClaims[kycIdHash].updatedAt = Date.now();
        }
        saveDB(db);
        finalStatus = 'under_review';
        return;
      }

      const result     = smileData?.result || {};
      const resultCode = result.ResultCode || '';
      const actions    = result.Actions    || {};
      const kycStatus  = smileResultToStatus(resultCode);
      const newTier    = kycStatus === 'approved' ? Math.max(user.kycTier || 0, 1) : (user.kycTier || 0);

      user.kycStatus    = kycStatus;
      user.kycTier      = newTier;
      user.kycSmileJobId = jobId;
      user.kycUpdatedAt  = Date.now();
      // kycIdHash stays on the user in all outcomes. The claim table is authoritative
      // and blocks other accounts regardless of whether this result is approved or rejected.
      if (!user.kycDocuments) user.kycDocuments = {};
      user.kycDocuments.smileResult = {
        resultCode, actions, country, idType, verifiedAt: Date.now(), jobId,
      };
      // Update claim table to reflect the final outcome
      if (db.kycIdentityClaims[kycIdHash]?.userId === req.user.userId) {
        db.kycIdentityClaims[kycIdHash].status    = kycStatus; // 'approved' | 'rejected' | 'under_review'
        db.kycIdentityClaims[kycIdHash].updatedAt = Date.now();
      }
      saveDB(db);

      logger.info('Smile Identity KYC completed', {
        userId: user.id, kycStatus, resultCode, kycTier: newTier, jobId,
      });
      finalStatus     = kycStatus;
      finalTier       = newTier;
      finalResultCode = resultCode;
    });

    if (smileErr) {
      return res.json({
        status:   'under_review',
        jobId,
        message:  'Verification submitted. Our team will review it shortly.',
        provider: 'manual_fallback',
      });
    }

    return res.json({
      status:     finalStatus,
      resultCode: finalResultCode,
      kycTier:    finalTier,
      jobId,
      message: finalStatus === 'approved'
        ? 'Identity verified successfully.'
        : finalStatus === 'rejected'
          ? 'We could not verify your identity. Please check your details and try again.'
          : 'Verification submitted and under review.',
    });
  }
);

// AI Chat endpoint (Rule-based with safety guardrails)
app.post('/ai/chat', 
  authMiddleware, 
  aiChatLimiter,
  validateInput([
    body('message').trim().notEmpty().isLength({ max: 2000 })
  ]),
  async (req, res) => {
  const { message, conversationHistory, structuredData, language } = req.body;
  
  const db = loadDB();
  const lowerMessage = message.toLowerCase();
  let response = '';
  let suggestions = [];
  let actions = [];
  let ticketCreated = null;
  let needsMoreInfo = null;
  
  // ===== GET ACCOUNT-AWARE CONTEXT (Revolut-level personalization) =====
  const userContext = getUserContext(req.user.userId, db);
  const requestedLang = language || userContext.language || 'en';
  const detectedLang = detectLanguageFromMessage(message);
  const lang = detectedLang || requestedLang; // Detected language from message takes priority
  
  // ===== CHECK FRAUD VELOCITY (prevent abuse) =====
  const escalation = detectEscalation(message);
  if (escalation.escalate && (escalation.category === 'fraud_security' || escalation.isFraudTheft)) {
    const velocityCheck = checkFraudVelocity(req.user.userId);
    if (velocityCheck.suspicious) {
      logger.warn('Suspicious fraud query velocity', { 
        userId: req.user.userId, 
        activityCount: velocityCheck.activityCount,
        ip: req.clientIP
      });
      // Still process but flag for review
      escalation.velocitySuspicious = true;
    }
  }
  
  // Log AI interaction with IP tracking
  logAIInteraction(req.user.userId, 'AI_CHAT', ['user_message'], null, req);
  
  // ===== CHECK IF WE NEED STRUCTURED DATA COLLECTION =====
  const dataNeeds = needsStructuredData(message);
  if ((dataNeeds.needsTransactionId || dataNeeds.needsAmount || dataNeeds.needsDate) && !structuredData) {
    needsMoreInfo = {
      fields: [],
      reason: t('data_collection_reason', lang)
    };
    
    if (dataNeeds.needsTransactionId) {
      needsMoreInfo.fields.push({
        name: 'transactionId',
        label: 'Transaction ID',
        type: 'text',
        required: true,
        hint: 'Find this in your transaction history'
      });
    }
    if (dataNeeds.needsAmount) {
      needsMoreInfo.fields.push({
        name: 'amount',
        label: 'Transaction Amount',
        type: 'number',
        required: true
      });
    }
    if (dataNeeds.needsDate) {
      needsMoreInfo.fields.push({
        name: 'date',
        label: 'Transaction Date',
        type: 'date',
        required: true
      });
    }
    
    needsMoreInfo.fields.push({
      name: 'device',
      label: 'Device Used',
      type: 'text',
      required: false,
      hint: 'iPhone, Android, Web, etc.'
    });
    
    response = `${needsMoreInfo.reason}\n\n${t('data_collection_help', lang)}`;
    suggestions = [t('provide_details', lang), t('skip_ticket', lang)];
    
    return res.json({ response, suggestions, needsMoreInfo });
  }
  
  // ===== ESCALATION DETECTION (PRIORITY) =====
  // (already declared earlier for fraud velocity check)
  
  if (escalation.escalate) {
    // Auto-create ticket for serious issues
    if (!db.supportTickets) db.supportTickets = [];
    
    const tags = ['auto-escalated', escalation.category, 'ai-detected'];
    
    // Add sentiment tag for priority routing
    if (escalation.sentiment === 'threatening' || escalation.sentiment === 'angry') {
      tags.push('high-emotion', escalation.sentiment);
    }
    
    // Add velocity flag if detected
    if (escalation.velocitySuspicious) {
      tags.push('velocity-suspicious', 'high-frequency');
    }
    
    const ticket = {
      id: `TKT-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`,
      userId: req.user.userId,
      subject: `Auto-escalated: ${escalation.category}`,
      description: message,
      category: escalation.category,
      priority: escalation.priority,
      status: 'open',
      sla: escalation.sla,
      escalated: true,
      sentiment: escalation.sentiment,
      structuredData: structuredData || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastFollowUp: null,
      tags,
      ipAddress: req.clientIP,
      userAgent: req.headers['user-agent'] || 'unknown',
      freshdeskId: null
    };
    
    db.supportTickets.push(ticket);
    saveDB(db);
    ticketCreated = ticket.id;
    
    // ===== CREATE FRESHDESK TICKET (ASYNC) =====
    const user = db.users.find(u => u.id === req.user.userId);
    createFreshdeskTicket(ticket, { email: user?.email }).then(freshdeskResult => {
      if (freshdeskResult.success && freshdeskResult.freshdeskId) {
        // Update local ticket with Freshdesk ID
        const localTicket = db.supportTickets.find(t => t.id === ticket.id);
        if (localTicket) {
          localTicket.freshdeskId = freshdeskResult.freshdeskId;
          saveDB(db);
          logger.info('Ticket synced to Freshdesk', { 
            localId: ticket.id, 
            freshdeskId: freshdeskResult.freshdeskId 
          });
        }
      }
    }).catch(err => {
      logger.error('Freshdesk sync error', { error: err.message, ticketId: ticket.id });
    });
    
    logAIInteraction(req.user.userId, 'AUTO_ESCALATE', [escalation.category, escalation.sentiment], ticket.id, req);
    
    // ===== REVOLUT-LEVEL FRAUD/THEFT RESPONSE =====
    if (escalation.isFraudTheft) {
      // Get recent transactions to check for suspicious activity
      const userTransactions = (db.transactions || [])
        .filter(t => t.userId === req.user.userId)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10); // Last 10 transactions
      
      // Check for multiple suspicious transactions in last 24h
      const last24h = Date.now() - (24 * 60 * 60 * 1000);
      const recentSuspicious = userTransactions.filter(t => 
        t.timestamp >= last24h && t.type === 'send' && t.amount > 100
      );
      
      // Build Revolut-level fraud response
      response = t('fraud_theft_alert', lang, { ticketId: ticket.id }) + '\n\n';
      
      // IMMEDIATE SECURITY LOCKDOWN STEPS
      response += t('security_lockdown_title', lang) + '\n';
      response += t('security_step_password', lang) + '\n';
      response += t('security_step_2fa', lang) + '\n';
      response += t('security_step_logout', lang) + '\n';
      response += t('security_step_bank', lang) + '\n';
      response += t('security_step_otp', lang) + '\n\n';
      
      // Alert for multiple suspicious transactions
      if (recentSuspicious.length > 1) {
        response += t('multiple_suspicious', lang) + '\n\n';
      }
      
      // Show recent transactions for user to identify
      if (userTransactions.length > 0) {
        response += t('fraud_investigation_help', lang) + '\n\n';
        response += 'Recent transactions:\n';
        userTransactions.slice(0, 5).forEach((tx, idx) => {
          const status = tx.status === 'pending' ? '⏳ PENDING' : tx.status === 'completed' ? '✓' : '✗';
          const amount = typeof tx.amount === 'number' ? `${minorToMajor(Math.abs(tx.amount), tx.currency || 'USD').toFixed(decimalsFor(tx.currency || 'USD'))} ${tx.currency || ''}`.trim() : tx.amount;
          const txId = maskTransactionId(tx.id);
          response += `${idx + 1}. ${status} ${amount} - ${txId}\n`;
        });
        response += '\n';
      }
      
      // SLA messaging
      response += t('fraud_sla', lang) + '\n';
      response += t('fraud_ticket_id', lang, { ticketId: ticket.id }) + '\n\n';
      
      // Suggestions focused on security actions
      suggestions = ['Change password', 'View transactions', 'Report fraud', t('contact_support', lang)];
      
      // Return with transaction data for frontend to display
      return res.json({
        response,
        suggestions,
        ticketCreated: {
          ticketId: ticket.id,
          priority: ticket.priority,
          sla: ticket.sla,
          escalated: true,
          isFraudAlert: true
        },
        recentTransactions: userTransactions.slice(0, 10).map(tx => ({
          id: maskTransactionId(tx.id),
          fullId: tx.id, // For selection
          amount: tx.amount,
          currency: tx.currency || 'USD',
          type: tx.type,
          status: tx.status,
          timestamp: tx.timestamp,
          recipient: tx.recipientEmail ? maskEmail(tx.recipientEmail) : 'N/A'
        })),
        fraudQuestions: [
          { id: 'q1', question: t('fraud_q1', lang), type: 'transaction_select' },
          { id: 'q2', question: t('fraud_q2', lang), type: 'datetime' },
          { id: 'q3', question: t('fraud_q3', lang), type: 'yes_no' }
        ]
      });
    }
    
    // ===== STANDARD ESCALATION RESPONSE (non-fraud) =====
    const escalationKey = escalation.category === 'fraud_security' ? 'escalated_fraud' :
                         escalation.category === 'account_security' ? 'escalated_security' :
                         escalation.category === 'legal' ? 'escalated_legal' : 'escalated_general';
    
    response = t(escalationKey, lang, { ticketId: ticket.id }) + '\n\n';
    
    // SLA Automation (Revolut-level) - Translated
    if (escalation.priority === 'urgent') {
      response += t('sla_urgent', lang) + '\n\n';
    } else if (escalation.priority === 'high') {
      response += t('sla_high', lang) + '\n\n';
    } else {
      response += t('sla_normal', lang) + '\n\n';
    }
    
    response += t('email_updates', lang) + '\n';
    response += t('track_status', lang) + '\n\n';
    
    if (escalation.category === 'fraud_security' || escalation.category === 'account_security') {
      response += t('security_email', lang);
    }
    
    suggestions = [t('check_ticket', lang), t('view_ticket', lang), t('contact_support', lang)];
    
    return res.json({ 
      response, 
      suggestions, 
      ticketCreated: {
        ticketId: ticket.id,
        priority: ticket.priority,
        sla: ticket.sla,
        escalated: true
      }
    });
  }
  
  // ===== SAFE INTENT DETECTION (No DB access, use support API concepts) =====
  
  // Transaction queries
  if (lowerMessage.includes('transaction') || lowerMessage.includes('payment') || lowerMessage.includes('transfer')) {
    if (lowerMessage.includes('latest') || lowerMessage.includes('last') || lowerMessage.includes('recent')) {
      response = t('tx_latest', lang);
      suggestions = [t('tx_latest_s1', lang), t('tx_latest_s2', lang), t('tx_latest_s3', lang)];
    } else if (lowerMessage.includes('failed') || lowerMessage.includes('problem') || lowerMessage.includes('issue')) {
      response = t('tx_issue', lang) + t('tx_issue_note', lang, { sla: escalation.sla || '24-48h' });
      suggestions = [t('tx_issue_s1', lang), t('tx_issue_s2', lang), t('tx_issue_s3', lang)];
      actions = [
        { label: lang === 'fr' ? 'Réessayer' : lang === 'es' ? 'Reintentar' : 'Retry transaction', type: 'retry', icon: 'refresh' },
        { label: lang === 'fr' ? 'Voir transactions' : lang === 'es' ? 'Ver transacciones' : 'View transactions', type: 'view_transaction', icon: 'list-outline' },
        { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
      ];
    } else {
      response = t('tx_general', lang);
      suggestions = [t('tx_general_s1', lang), t('tx_general_s2', lang), t('tx_general_s3', lang)];
    }
  }
  
  // Balance queries (ACCOUNT-AWARE - Revolut-level)
  else if (lowerMessage.includes('balance') || lowerMessage.includes('money') || lowerMessage.includes('funds')) {
    response = t('balance_general', lang) + '\n\n';
    
    // Show personalized limit info
    if (lowerMessage.includes('limit')) {
      response += t('account_limits', lang, {
        dailyLimit: userContext.dailyLimit,
        dailySpent: userContext.dailySpent,
        dailyRemaining: userContext.dailyRemaining
      }) + '\n\n';
      
      if (userContext.kycTier === 'unverified') {
        response += t('get_verified', lang);
        suggestions = [t('balance_limit_s1', lang), t('balance_limit_s2', lang), t('balance_limit_s3', lang)];
      } else if (userContext.kycTier === 'pending') {
        response += t('verification_pending', lang);
        suggestions = [t('balance_limit_s4', lang), t('balance_limit_s2', lang)];
      } else {
        suggestions = [t('balance_limit_s2', lang), t('tx_latest_s1', lang)];
      }
    } else {
      // Show real balance from client context if available
      const clientCtx = req.body.userCtx || {};
      const clientBals = clientCtx.balances || {};
      const balEntries = Object.entries(clientBals).filter(([, v]) => Number(v) > 0);
      if (balEntries.length > 0) {
        const [topCur, topAmt] = balEntries[0];
        const readableAmt = minorToMajor(Number(topAmt), topCur).toFixed(decimalsFor(topCur));
        response = lang === 'fr'
          ? `Votre solde disponible est de ${topCur} ${readableAmt}.\n\n`
          : lang === 'es'
          ? `Su saldo disponible es ${topCur} ${readableAmt}.\n\n`
          : `Your available balance is ${topCur} ${readableAmt}.\n\n`;
        response += t('balance_incorrect', lang);
      } else {
        response += t('balance_incorrect', lang);
      }
      actions = [
        { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
      ];
      suggestions = [t('balance_s1', lang), t('balance_s2', lang), t('balance_s3', lang)];
    }
  }
  
  // Virtual cards
  else if (lowerMessage.includes('card') || lowerMessage.includes('virtual card')) {
    if (lowerMessage.includes('create') || lowerMessage.includes('make') || lowerMessage.includes('new')) {
      response = t('card_create', lang);
      suggestions = [t('card_create_s1', lang), t('card_create_s2', lang), t('card_create_s3', lang)];
    } else if (lowerMessage.includes('frozen') || lowerMessage.includes('locked') || lowerMessage.includes('blocked')) {
      response = t('card_frozen', lang);
      suggestions = [t('card_frozen_s1', lang), t('card_frozen_s2', lang), t('card_frozen_s3', lang)];
    } else {
      response = t('card_general', lang);
      suggestions = [t('card_general_s1', lang), t('card_general_s2', lang), t('card_general_s3', lang)];
    }
  }
  
  // KYC/Verification (ACCOUNT-AWARE)
  else if (lowerMessage.includes('verify') || lowerMessage.includes('kyc') || lowerMessage.includes('identity')) {
    if (userContext.kycTier === 'verified') {
      response = t('verified_status', lang);
      suggestions = [t('tx_general_s1', lang), t('tx_latest_s3', lang)];
    } else if (userContext.kycTier === 'pending') {
      response = t('kyc_pending_response', lang, { currentLimit: userContext.dailyLimit.toLocaleString() });
      suggestions = [t('kyc_pending_s1', lang), t('kyc_pending_s2', lang), t('kyc_pending_s3', lang)];
    } else {
      response = t('kyc_unverified', lang) + t('kyc_unverified_current', lang, { currentLimit: userContext.dailyLimit.toLocaleString() });
      suggestions = [t('kyc_unverified_s1', lang), t('kyc_unverified_s2', lang), t('kyc_unverified_s3', lang)];
    }
  }
  
  // Security concerns
  else if (lowerMessage.includes('security') || lowerMessage.includes('safe') || lowerMessage.includes('protect')) {
    response = t('security_response', lang);
    suggestions = [t('security_s1', lang), t('security_s2', lang), t('security_s3', lang)];
  }
  
  // Refund/reversal requests (MUST NOT PROMISE)
  else if (lowerMessage.includes('refund') || lowerMessage.includes('reverse') || lowerMessage.includes('cancel')) {
    response = t('refund_response', lang);
    suggestions = [t('refund_s1', lang), t('refund_s2', lang), t('refund_s3', lang)];
  }
  
  // Help / FAQ
  else if (lowerMessage.includes('help') || lowerMessage.includes('how') || lowerMessage.includes('what') || lowerMessage.includes('faq')) {
    response = t('help_response', lang);
    suggestions = [t('help_s1', lang), t('help_s2', lang), t('help_s3', lang)];
  }
  
  // Fees
  else if (lowerMessage.includes('fee') || lowerMessage.includes('charge') || lowerMessage.includes('cost')) {
    response = t('fees_response', lang);
    suggestions = [t('fees_s1', lang), t('fees_s2', lang), t('fees_s3', lang)];
  }
  
  // Dispute/complaint
  else if (lowerMessage.includes('dispute') || lowerMessage.includes('complaint') || lowerMessage.includes('problem')) {
    response = t('dispute_response', lang);
    suggestions = [t('dispute_s1', lang), t('dispute_s2', lang), t('dispute_s3', lang)];
  }
  
  // Greeting
  else if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey') || lowerMessage.includes('hola') || lowerMessage.includes('bonjour') || lowerMessage.includes('olá') || lowerMessage.includes('привет') || lowerMessage.includes('こんにちは')) {
    const hasUserHistory = (conversationHistory || []).some(m => m.sender === 'user');
    response = hasUserHistory ? t('greeting_return', lang) : t('greeting', lang);
    suggestions = [t('tx_general_s1', lang), t('tx_latest_s3', lang), t('help_s1', lang)];
  }
  
  // Default fallback
  else {
    response = t('default_response', lang);
    suggestions = [t('default_s1', lang), t('default_s2', lang), t('default_s3', lang)];
  }
  
  res.json({ response, suggestions, ticketCreated, actions });
});

// Update user language preference
app.post('/user/language', authMiddleware, (req, res) => {
  const { language } = req.body;
  
  const supportedLanguages = ['en', 'es', 'fr', 'pt', 'zh', 'ja', 'ru', 'de'];
  
  if (!language || !supportedLanguages.includes(language)) {
    return res.status(400).json({ 
      error: 'Invalid language. Supported: en, es, fr, pt, zh, ja, ru, de' 
    });
  }
  
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  user.language = language;
  saveDB(db);
  
  res.json({ success: true, language });
});

// ==================== POST /ai-assistant (Smart Financial Assistant) ====================
const AI_SUPPORTED_EVENTS = ['transaction_failed', 'withdrawal_pending', 'suspicious_activity', 'new_recipient'];
const AI_SUPPORTED_LANGS  = ['en', 'es', 'fr', 'pt', 'zh', 'ja', 'ru', 'de'];
const AI_KNOWN_CURRENCIES = new Set([
  'USD','EUR','GBP','XAF','XOF','NGN','GHS','ZAR','KES','EGP','MAD','TZS','UGX',
  'INR','CNY','JPY','KRW','HKD','SGD','THB','IDR','MYR','PHP','VND','PKR',
  'BRL','ARS','COP','MXN','CLP','PEN','AUD','CAD','NZD','CHF','SEK','NOK',
  'DKK','PLN','CZK','HUF','RON','BGN','RUB','UAH','TRY','AED','SAR','QAR',
]);

/** Sanitise a currency code: uppercase, alphanumeric only, 2-5 chars, known list. */
function sanitiseCurrency(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  return AI_KNOWN_CURRENCIES.has(s) ? s : null;
}

/** Sanitise an amount: must be a finite positive number <= 1e9 minor units. */
function sanitiseAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return null;
  return n;
}

/** Sanitise a pending-withdrawals object from the client: only known currencies, positive numbers. */
function sanitisePendingWithdrawals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const safe = {};
  for (const [k, v] of Object.entries(raw)) {
    const cur = sanitiseCurrency(k);
    const amt = sanitiseAmount(v);
    if (cur && amt !== null && amt > 0) safe[cur] = amt;
    if (Object.keys(safe).length >= 10) break; // never more than 10 entries
  }
  return safe;
}

app.post('/ai-assistant',
  authMiddleware,
  aiChatLimiter,
  validateInput([
    body('language').optional().isString().isIn(AI_SUPPORTED_LANGS),
    body('event').optional().isString().isIn(AI_SUPPORTED_EVENTS),
    body('message').optional().trim().isLength({ max: 2000 }),
  ]),
  async (req, res) => {
    const { message, language, event, eventContext = {}, userContext: clientCtx = {} } = req.body;
    const db = loadDB();
    const userId = req.user.userId;

    const detectedLang = message ? detectLanguageFromMessage(message) : null;
    // Whitelist the language — fall back to 'en' for unknown values
    const requestedLang = AI_SUPPORTED_LANGS.includes(language) ? language : 'en';
    const lang = (detectedLang && AI_SUPPORTED_LANGS.includes(detectedLang)) ? detectedLang : requestedLang;

    const serverCtx = getUserContext(userId, db);
    logAIInteraction(userId, 'AI_ASSISTANT', ['event', 'context'], null, req);

    let response = '';
    let actions = [];
    let suggestions = [];

    // ─── EVENT: Transaction Failed ──────────────────────────────────────────────
    if (event === 'transaction_failed') {
      // Only use failureReason if it matches a known whitelist key; never embed raw client input
      const KNOWN_REASONS = ['insufficient_funds', 'limit_exceeded', 'invalid_recipient', 'network_error', 'blocked_account'];
      const rawReason = eventContext.failureReason || serverCtx.lastFailedReason || '';
      const failReason = KNOWN_REASONS.includes(String(rawReason)) ? String(rawReason) : 'unknown';

      // Sanitise amount and currency from client
      const txAmount   = sanitiseAmount(eventContext.amount);
      const txCurrency = sanitiseCurrency(eventContext.currency) || serverCtx.currency;
      const amtStr = (txAmount !== null && txAmount > 0)
        ? `${txCurrency} ${minorToMajor(txAmount, txCurrency).toFixed(decimalsFor(txCurrency))}` : '';

      const reasonMap = {
        insufficient_funds: lang === 'fr' ? `fonds insuffisants — solde disponible\u00a0: ${serverCtx.currency}\u00a0${serverCtx.balance}`
          : lang === 'es' ? `fondos insuficientes — saldo disponible: ${serverCtx.currency} ${serverCtx.balance}`
          : `insufficient funds — your available balance is ${serverCtx.currency} ${serverCtx.balance}`,
        limit_exceeded: lang === 'fr' ? 'limite journali\u00e8re d\u00e9pass\u00e9e' : lang === 'es' ? 'l\u00edmite diario excedido' : 'daily limit exceeded',
        invalid_recipient: lang === 'fr' ? 'destinataire introuvable' : lang === 'es' ? 'destinatario no encontrado' : 'recipient not found',
        network_error: lang === 'fr' ? 'erreur r\u00e9seau temporaire' : lang === 'es' ? 'error de red temporal' : 'temporary network error',
        blocked_account: lang === 'fr' ? 'restriction temporaire du compte' : lang === 'es' ? 'restricci\u00f3n temporal de la cuenta' : 'temporary account restriction',
        unknown: lang === 'fr' ? 'une erreur inattendue' : lang === 'es' ? 'un error inesperado' : 'an unexpected error',
      };
      // readableReason is ALWAYS from the whitelist map — raw client input is never interpolated
      const readableReason = reasonMap[failReason];
      if (lang === 'fr') {
        response = `Votre transaction${amtStr ? ` de ${amtStr}` : ''} a \u00e9chou\u00e9 en raison de ${readableReason}.\n\nSolde disponible\u00a0: ${serverCtx.currency}\u00a0${serverCtx.balance}.\n\nVous pouvez r\u00e9essayer ou contacter notre support pour obtenir de l\u2019aide.`;
      } else if (lang === 'es') {
        response = `Su transacci\u00f3n${amtStr ? ` de ${amtStr}` : ''} fall\u00f3 por ${readableReason}.\n\nSaldo disponible: ${serverCtx.currency} ${serverCtx.balance}.\n\nPuede reintentar o contactar soporte para obtener ayuda.`;
      } else {
        response = `Your transaction${amtStr ? ` of ${amtStr}` : ''} failed because of ${readableReason}.\n\nYour available balance: ${serverCtx.currency} ${serverCtx.balance}.\n\nYou can retry or contact support for assistance.`;
      }
      actions = [
        { label: lang === 'fr' ? 'R\u00e9essayer' : lang === 'es' ? 'Reintentar' : 'Retry transaction', type: 'retry', icon: 'refresh' },
        { label: lang === 'fr' ? 'Voir transactions' : lang === 'es' ? 'Ver transacciones' : 'View transactions', type: 'view_transaction', icon: 'list-outline' },
        { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
      ];

    // ─── EVENT: Withdrawal Pending ─────────────────────────────────────────────
    } else if (event === 'withdrawal_pending') {
      // Sanitise client-supplied pending amounts before embedding in response
      const pending = sanitisePendingWithdrawals(clientCtx.pendingWithdrawals);
      const pendingLines = Object.entries(pending)
        .filter(([, amt]) => Number(amt) > 0)
        .map(([cur, amt]) => `${cur} ${minorToMajor(Number(amt), cur).toFixed(decimalsFor(cur))}`)
        .join(', ');
      if (lang === 'fr') {
        response = `Votre retrait${pendingLines ? ` de ${pendingLines}` : ''} est en cours de traitement.\n\nLes retraits prennent g\u00e9n\u00e9ralement 3 \u00e0 5 jours ouvr\u00e9s selon votre banque. Vous recevrez une notification par e-mail d\u00e8s que le virement sera effectu\u00e9.\n\nID de portefeuille\u00a0: ${serverCtx.walletId}`;
      } else if (lang === 'es') {
        response = `Su retiro${pendingLines ? ` de ${pendingLines}` : ''} est\u00e1 siendo procesado.\n\nLos retiros generalmente tardan 3 a 5 d\u00edas h\u00e1biles seg\u00fan su banco. Recibir\u00e1 una notificaci\u00f3n por correo cuando se complete la transferencia.\n\nID de billetera: ${serverCtx.walletId}`;
      } else {
        response = `Your withdrawal${pendingLines ? ` of ${pendingLines}` : ''} is being processed.\n\nWithdrawals typically take 3\u20135 business days depending on your bank. You\u2019ll receive an email notification once the transfer is complete.\n\nWallet ID: ${serverCtx.walletId}`;
      }
      actions = [
        { label: lang === 'fr' ? 'Voir transactions' : lang === 'es' ? 'Ver transacciones' : 'View transactions', type: 'view_transaction', icon: 'list-outline' },
        { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
      ];

    // ─── EVENT: Suspicious Activity ────────────────────────────────────────────
    } else if (event === 'suspicious_activity') {
      if (lang === 'fr') {
        response = `\u26a0\ufe0f Activit\u00e9 suspecte d\u00e9tect\u00e9e sur votre compte (${serverCtx.walletId}).\n\nVeuillez\u00a0:\n1. V\u00e9rifier vos transactions r\u00e9centes\n2. Changer votre mot de passe imm\u00e9diatement\n3. Activer la double authentification\n\nSi vous ne reconnaissez pas cette activit\u00e9, contactez notre support imm\u00e9diatement.`;
      } else if (lang === 'es') {
        response = `\u26a0\ufe0f Actividad sospechosa detectada en su cuenta (${serverCtx.walletId}).\n\nPor favor:\n1. Revise sus transacciones recientes\n2. Cambie su contrase\u00f1a inmediatamente\n3. Active la autenticaci\u00f3n de dos factores\n\nSi no reconoce esta actividad, contacte soporte inmediatamente.`;
      } else {
        response = `\u26a0\ufe0f Suspicious activity detected on your account (${serverCtx.walletId}).\n\nPlease:\n1. Review your recent transactions\n2. Change your password immediately\n3. Enable two-factor authentication\n\nIf you don\u2019t recognize this activity, contact our support immediately.`;
      }
      actions = [
        { label: lang === 'fr' ? 'Voir transactions' : lang === 'es' ? 'Ver transacciones' : 'View transactions', type: 'view_transaction', icon: 'list-outline' },
        { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
      ];

    // ─── EVENT: New Recipient Security Warning ─────────────────────────────────
    } else if (event === 'new_recipient') {
      // Strip to alphanumeric + limited punctuation to prevent injection; cap at 30 chars
      const recipientId = String(eventContext.recipientId || '')
        .replace(/[^a-zA-Z0-9@._\-]/g, '')
        .substring(0, 30);
      if (lang === 'fr') {
        response = `\u26a0\ufe0f Avertissement de s\u00e9curit\u00e9\n\nVous envoyez de l\u2019argent \u00e0 un nouveau destinataire${recipientId ? ` (${recipientId})` : ''}.\n\nV\u00e9rifiez soigneusement l\u2019identit\u00e9 du destinataire avant de confirmer. EGWallet ne peut pas r\u00e9cup\u00e9rer les fonds envoy\u00e9s \u00e0 la mauvaise personne.\n\nSolde disponible\u00a0: ${serverCtx.currency}\u00a0${serverCtx.balance}`;
      } else if (lang === 'es') {
        response = `\u26a0\ufe0f Advertencia de seguridad\n\nEst\u00e1 enviando dinero a un nuevo destinatario${recipientId ? ` (${recipientId})` : ''}.\n\nVerifique cuidadosamente la identidad del destinatario antes de confirmar. EGWallet no puede recuperar fondos enviados a la persona equivocada.\n\nSaldo disponible: ${serverCtx.currency} ${serverCtx.balance}`;
      } else {
        response = `\u26a0\ufe0f Security Warning\n\nYou are sending money to a new recipient${recipientId ? ` (${recipientId})` : ''}.\n\nPlease carefully verify the recipient\u2019s identity before confirming. EGWallet cannot recover funds sent to the wrong person.\n\nAvailable balance: ${serverCtx.currency} ${serverCtx.balance}`;
      }
      actions = [
        { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
      ];

    // ─── FREE-FORM MESSAGE with real context ──────────────────────────────────
    } else if (message) {
      const lower = message.toLowerCase();
      // Sanitise client-supplied pending amounts before embedding in response
      const pending = sanitisePendingWithdrawals(clientCtx.pendingWithdrawals);
      const hasPending = Object.values(pending).some(v => Number(v) > 0);
      const pendingStr = Object.entries(pending).filter(([, v]) => Number(v) > 0)
        .map(([c, v]) => `${c} ${minorToMajor(Number(v), c).toFixed(decimalsFor(c))}`).join(', ');

      if (lower.includes('insufficient') || lower.includes('fonds insuffisant') || lower.includes('fondos insuficiente') ||
          (lower.includes('failed') && (lower.includes('balance') || lower.includes('fund')))) {
        if (lang === 'fr') {
          response = `Votre solde disponible est de ${serverCtx.currency}\u00a0${serverCtx.balance}.\n\nSi votre transaction a \u00e9chou\u00e9 pour fonds insuffisants, veuillez ajouter des fonds avant de r\u00e9essayer.`;
        } else if (lang === 'es') {
          response = `Su saldo disponible es ${serverCtx.currency} ${serverCtx.balance}.\n\nSi su transacci\u00f3n fall\u00f3 por fondos insuficientes, a\u00f1ada fondos antes de reintentar.`;
        } else {
          response = `Your available balance is ${serverCtx.currency} ${serverCtx.balance}.\n\nIf your transaction failed due to insufficient funds, please add funds before retrying.`;
        }
        actions = [
          { label: lang === 'fr' ? 'R\u00e9essayer' : lang === 'es' ? 'Reintentar' : 'Retry transaction', type: 'retry', icon: 'refresh' },
          { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
        ];
      } else if (hasPending && (lower.includes('pending') || lower.includes('withdrawal') || lower.includes('retrait') || lower.includes('retiro'))) {
        if (lang === 'fr') {
          response = `Vous avez un retrait en cours${pendingStr ? ` de ${pendingStr}` : ''}. Les retraits prennent 3 \u00e0 5 jours ouvr\u00e9s.`;
        } else if (lang === 'es') {
          response = `Tiene un retiro pendiente${pendingStr ? ` de ${pendingStr}` : ''}. Los retiros tardan 3 a 5 d\u00edas h\u00e1biles.`;
        } else {
          response = `You have a pending withdrawal${pendingStr ? ` of ${pendingStr}` : ''}. Withdrawals take 3\u20135 business days.`;
        }
        actions = [
          { label: lang === 'fr' ? 'Voir transactions' : lang === 'es' ? 'Ver transacciones' : 'View transactions', type: 'view_transaction', icon: 'list-outline' },
          { label: lang === 'fr' ? 'Contacter support' : lang === 'es' ? 'Contactar soporte' : 'Contact support', type: 'contact_support', icon: 'headset' },
        ];
      } else {
        // Not a context-specific query — let frontend fall back to /ai/chat
        return res.json({ response: null, actions: [], suggestions: [], forwardToChat: true });
      }
    } else {
      return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
    }

    return res.json({ response, actions, suggestions, language: lang });
  }
);

// Get supported languages
app.get('/user/languages', (req, res) => {
  res.json({
    languages: [
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'es', name: 'Spanish', nativeName: 'Español' },
      { code: 'fr', name: 'French', nativeName: 'Français' },
      { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
      { code: 'zh', name: 'Chinese', nativeName: '中文' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語' },
      { code: 'ru', name: 'Russian', nativeName: 'Русский' },
      { code: 'de', name: 'German', nativeName: 'Deutsch' }
    ]
  });
});

// ==================== SUPPORT API ENDPOINTS (READ-ONLY) ====================

// Get user context for AI support
app.get('/support/context', authMiddleware, (req, res) => {
  const db = loadDB();
  
  // Log AI access
  logAIInteraction(req.user.userId, 'GET /support/context', ['user_profile', 'kyc_status', 'account_limits']);
  
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  const wallet = (db.wallets || []).find(w => w.userId === req.user.userId);
  const userKyc = (db.kyc || []).find(k => k.userId === req.user.userId);
  
  // Masked user data
  const context = {
    user: {
      id: user.id,
      email: maskEmail(user.email),
      region: user.region,
      accountAge: Math.floor((Date.now() - user.createdAt) / (1000 * 60 * 60 * 24)) + ' days',
      createdAt: user.createdAt
    },
    kyc: {
      status: userKyc?.status || 'not_started',
      tier: userKyc?.status === 'approved' ? 'verified' : 'basic',
      documentsCount: userKyc?.documents?.length || 0
    },
    limits: {
      transactionLimit: wallet?.maxLimitUSD || 2500,
      tier: userKyc?.status === 'approved' ? 'premium' : 'standard',
      description: userKyc?.status === 'approved' 
        ? 'Verified account with higher limits' 
        : 'Standard account - verify identity for higher limits'
    },
    accountStatus: {
      active: true,
      locked: false,
      suspiciousActivity: false
    }
  };
  
  res.json(context);
});

// Get recent transactions (masked)
app.get('/support/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const range = req.query.range || '30d';
  
  logAIInteraction(req.user.userId, 'GET /support/transactions', [`transactions_${range}`]);
  
  const wallet = (db.wallets || []).find(w => w.userId === req.user.userId);
  if (!wallet) return res.json({ transactions: [] });
  
  // Calculate range in milliseconds
  const rangeDays = parseInt(range) || 30;
  const rangeMs = rangeDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - rangeMs;
  
  const transactions = (db.transactions || [])
    .filter(t => t.fromWalletId === wallet.id || t.toWalletId === wallet.id)
    .filter(t => t.createdAt > cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50) // Max 50 transactions
    .map(t => ({
      id: maskTransactionId(t.id),
      type: t.type,
      amount: maskAmount(t.amount), // Rounded for privacy
      currency: t.currency,
      status: t.status,
      date: new Date(t.createdAt).toLocaleDateString(),
      timestamp: t.createdAt,
      // No recipient/sender details for privacy
    }));
  
  res.json({ transactions, count: transactions.length, range });
});

// Get single transaction details
app.get('/support/transaction/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const transactionId = req.params.id;
  
  logAIInteraction(req.user.userId, 'GET /support/transaction/:id', [`transaction_${transactionId}`]);
  
  const wallet = (db.wallets || []).find(w => w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
  
  const transaction = (db.transactions || []).find(t => 
    t.id.startsWith(transactionId.replace('...', '')) && 
    (t.fromWalletId === wallet.id || t.toWalletId === wallet.id)
  );
  
  if (!transaction) return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  
  // Masked transaction details
  const details = {
    id: maskTransactionId(transaction.id),
    type: transaction.type,
    amount: minorToMajor(transaction.amount, transaction.currency).toFixed(decimalsFor(transaction.currency)),
    currency: transaction.currency,
    status: transaction.status,
    createdAt: transaction.createdAt,
    date: new Date(transaction.createdAt).toLocaleString(),
    timeline: [
      { stage: 'initiated', timestamp: transaction.createdAt, status: 'completed' },
      { stage: 'processing', timestamp: transaction.createdAt + 1000, status: 'completed' },
      { stage: 'completed', timestamp: transaction.createdAt + 2000, status: transaction.status === 'completed' ? 'completed' : 'pending' }
    ],
    memo: transaction.memo || null,
    // No full recipient details
    direction: transaction.fromWalletId === wallet.id ? 'outgoing' : 'incoming'
  };
  
  res.json(details);
});

// Get card status (masked)
app.get('/support/cards', authMiddleware, (req, res) => {
  const db = loadDB();
  
  logAIInteraction(req.user.userId, 'GET /support/cards', ['virtual_cards']);
  
  const cards = (db.virtualCards || [])
    .filter(c => c.userId === req.user.userId)
    .map(c => ({
      id: c.id,
      last4: c.cardNumber ? maskCardNumber(c.cardNumber) : '****',
      status: c.status,
      spendingLimit: c.spendingLimit,
      currency: c.currency,
      createdAt: c.createdAt,
      // No full card number, CVV, or expiry
    }));
  
  res.json({ cards, count: cards.length });
});

// Create support ticket (with escalation)
app.post('/support/ticket', authMiddleware, (req, res) => {
  const db = loadDB();
  const { subject, description, category } = req.body;
  
  if (!subject || !description) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  
  // Detect escalation
  const escalation = detectEscalation(description);
  
  if (!db.supportTickets) db.supportTickets = [];
  
  const ticket = {
    id: `TKT-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`,
    userId: req.user.userId,
    subject,
    description,
    category: escalation.escalate ? escalation.category : (category || 'general'),
    priority: escalation.escalate ? escalation.priority : 'normal',
    status: 'open',
    sla: escalation.escalate ? escalation.sla : '24-48h',
    escalated: escalation.escalate,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    assignedTo: null,
    tags: escalation.escalate ? ['auto-escalated', escalation.category] : []
  };
  
  db.supportTickets.push(ticket);
  saveDB(db);
  
  // Log ticket creation
  logAIInteraction(req.user.userId, 'POST /support/ticket', ['ticket_created'], ticket.id);
  
  // Return ticket info
  res.json({
    success: true,
    ticket: {
      id: ticket.id,
      priority: ticket.priority,
      sla: ticket.sla,
      escalated: ticket.escalated,
      message: escalation.escalate 
        ? `Your issue requires urgent attention. We've escalated this to our ${escalation.category.replace('_', ' ')} team.`
        : 'Your ticket has been created successfully.'
    }
  });
});

// Get AI audit logs (admin only - in production add admin auth)
app.get('/support/audit-logs', authMiddleware, (req, res) => {
  // In production: check if user is admin
  const userLogs = aiAuditLogs
    .filter(log => log.userId === req.user.userId)
    .slice(-100); // Last 100 logs
  
  res.json({ logs: userLogs, count: userLogs.length });
});

// ==================== FOLLOW-UP AUTOMATION (Revolut-level) ====================

// Check and send automated follow-ups for tickets without response
function checkAndSendFollowUps() {
  const db = loadDB();
  if (!db.supportTickets) return;
  
  const now = Date.now();
  const FOLLOWUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  let followUpsSent = 0;
  
  db.supportTickets.forEach(ticket => {
    // Only follow up on open/pending tickets
    if (ticket.status !== 'open' && ticket.status !== 'pending') return;
    
    const timeSinceCreation = now - ticket.createdAt;
    const timeSinceLastUpdate = now - (ticket.lastFollowUp || ticket.createdAt);
    
    // Send follow-up if:
    // 1. No response in 24h after creation
    // 2. No follow-up sent yet OR last follow-up was >24h ago
    if (timeSinceCreation >= FOLLOWUP_INTERVAL && timeSinceLastUpdate >= FOLLOWUP_INTERVAL) {
      // Mark as followed up
      ticket.lastFollowUp = now;
      ticket.followUpCount = (ticket.followUpCount || 0) + 1;
      
      // In production: send actual email/notification
      console.log(`[FOLLOW-UP] Ticket ${ticket.id} - User ${ticket.userId} - Count: ${ticket.followUpCount}`);
      
      followUpsSent++;
      
      // Auto-escalate priority if multiple follow-ups needed
      if (ticket.followUpCount >= 2 && ticket.priority === 'normal') {
        ticket.priority = 'high';
        console.log(`[AUTO-ESCALATE] Ticket ${ticket.id} upgraded to HIGH priority due to multiple follow-ups`);
      }
    }
  });
  
  if (followUpsSent > 0) {
    saveDB(db);
    console.log(`[FOLLOW-UP SYSTEM] Sent ${followUpsSent} automated follow-ups`);
  }
}

// Manual follow-up check endpoint — admin only (mirrors cron automation)
app.post('/support/process-followups', authMiddleware, adminMiddleware, (req, res) => {
  checkAndSendFollowUps();
  res.json({ success: true, message: 'Follow-ups processed' });
});

// Get ticket status with follow-up info
app.get('/support/ticket/:ticketId', authMiddleware, (req, res) => {
  const db = loadDB();
  const ticket = (db.supportTickets || []).find(t => t.id === req.params.ticketId);
  
  if (!ticket) {
    return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  }
  
  // Verify user owns this ticket (or is admin)
  if (ticket.userId !== req.user.userId) {
    return res.status(403).json({ error: t('error_access_denied', req.lang || 'en') });
  }
  
  logAIInteraction(req.user.userId, 'TICKET_STATUS_CHECK', [ticket.id]);
  
  // Calculate expected response time
  const now = Date.now();
  const slaHours = parseInt(ticket.sla) || 48;
  const slaDeadline = ticket.createdAt + (slaHours * 60 * 60 * 1000);
  const timeRemaining = slaDeadline - now;
  const hoursRemaining = Math.max(0, Math.floor(timeRemaining / (60 * 60 * 1000)));
  
  res.json({
    ticket: {
      id: ticket.id,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      sla: ticket.sla,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      escalated: ticket.escalated,
      sentiment: ticket.sentiment,
      followUpCount: ticket.followUpCount || 0,
      lastFollowUp: ticket.lastFollowUp
    },
    slaInfo: {
      deadline: slaDeadline,
      hoursRemaining,
      status: hoursRemaining > 0 ? 'within_sla' : 'sla_breach'
    }
  });
});

// Start follow-up automation (runs every hour)
setInterval(checkAndSendFollowUps, 60 * 60 * 1000);
console.log('[FOLLOW-UP SYSTEM] Automated follow-up checker started (runs every 60 min)');

// Submit dispute
app.post('/disputes', authMiddleware, (req, res) => {
  const db = loadDB();
  const { transactionId, reason, description } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!transactionId || !reason || !description) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }

  const VALID_REASONS = ['unauthorized', 'wrong_amount', 'not_received', 'duplicate', 'other'];
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${VALID_REASONS.join(', ')}` });
  }

  if (typeof description !== 'string' || description.trim().length < 10 || description.trim().length > 2000) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }

  // ── Resolve authenticated user's email from DB (never trust client) ───────
  const dbUser = (db.users || []).find(u => u.id === req.user.userId);
  const resolvedEmail = dbUser?.email || null;

  if (!db.disputes) db.disputes = [];

  // Generate ticket number server-side (never from client)
  const ticketNumber = `EGW-${Math.floor(10000 + Math.random() * 90000)}`;

  const dispute = {
    id: uuidv4(),
    ticketNumber,
    userId: req.user.userId,
    userEmail: resolvedEmail,
    notifyEmail: (process.env.SUPPORT_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL || 'support@egwalletfinance.com').toLowerCase(),
    transactionId: String(transactionId).slice(0, 100), // cap length
    reason,
    description: description.trim(),
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  db.disputes.push(dispute);
  saveDB(db);

  res.json({ success: true, dispute: { id: dispute.id, ticketNumber: dispute.ticketNumber, status: dispute.status } });
});

// Report payroll fraud/dispute (auto-creates Freshdesk ticket)
app.post('/payroll/report-fraud', authMiddleware, async (req, res) => {
  const db = loadDB();
  const { transactionId, type, details, expectedAmount, receivedAmount } = req.body;
  
  if (!transactionId || !type || !details) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  
  const validTypes = ['unauthorized', 'wrong_amount', 'missing_payment', 'duplicate', 'fraud', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }
  
  // Find transaction
  const transaction = db.transactions.find(t => t.id === transactionId);
  if (!transaction) {
    return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  }
  
  // Verify user is involved in transaction
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId).map(w => w.id);
  if (!userWallets.includes(transaction.fromWalletId) && !userWallets.includes(transaction.toWalletId)) {
    return res.status(403).json({ error: t('error_unauthorized', req.lang || 'en') });
  }
  
  const user = db.users.find(u => u.id === req.user.userId);
  
  // Create fraud report
  const report = {
    id: uuidv4(),
    userId: req.user.userId,
    transactionId,
    type,
    details,
    expectedAmount: expectedAmount || null,
    receivedAmount: receivedAmount || null,
    status: 'under_review',
    priority: (type === 'unauthorized' || type === 'fraud') ? 'high' : 'medium',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    freshdeskTicketId: null
  };
  
  if (!db.fraudReports) db.fraudReports = [];
  db.fraudReports.push(report);
  
  // Add to audit log
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.push({
    id: uuidv4(),
    type: 'fraud_report_created',
    userId: req.user.userId,
    reportId: report.id,
    transactionId,
    fraudType: type,
    timestamp: Date.now(),
    ipAddress: req.clientIP || 'unknown',
    metadata: {
      transactionAmount: transaction.amount,
      transactionCurrency: transaction.currency,
      payrollType: transaction.type === 'payroll' || transaction.type === 'payroll_request'
    }
  });
  
  saveDB(db);
  
  // Auto-create Freshdesk ticket if configured
  let ticketCreated = false;
  let ticketId = null;
  
  if (FRESHDESK_ENABLED) {
    try {
      const ticketSubject = `[PAYROLL ${type.toUpperCase()}] ${user.email} - Transaction ${transactionId.substring(0, 8)}`;
      const ticketDescription = `
**Fraud Report - Priority: ${report.priority.toUpperCase()}**

**User**: ${user.email} (ID: ${req.user.userId})
**Transaction ID**: ${transactionId}
**Type**: ${type}
**Status**: Under Review

**Details**:
${details}

**Transaction Info**:
- Amount: ${transaction.amount} ${transaction.currency}
- Type: ${transaction.type || 'standard'}
- Timestamp: ${new Date(transaction.timestamp).toISOString()}
${transaction.payrollMetadata ? `- Employer: ${transaction.payrollMetadata.employerName} (ID: ${transaction.payrollMetadata.employerId})` : ''}
${transaction.payrollMetadata ? `- Payroll Period: ${transaction.payrollMetadata.payrollPeriod}` : ''}

${expectedAmount ? `**Expected Amount**: ${expectedAmount} ${transaction.currency}` : ''}
${receivedAmount ? `**Received Amount**: ${receivedAmount} ${transaction.currency}` : ''}

**User Statement**:
"${details}"

**Action Required**: Investigate and resolve within 24 hours for fraud cases.
      `.trim();
      
      const ticketPayload = {
        subject: ticketSubject,
        description: ticketDescription,
        email: user.email,
        priority: report.priority === 'high' ? 3 : 2,
        status: 2, // Open
        tags: ['payroll', type, 'fraud_report', 'auto_created'],
        custom_fields: {
          cf_transaction_id: transactionId,
          cf_user_id: req.user.userId,
          cf_fraud_type: type
        }
      };
      
      const response = await fetch(`https://${FRESHDESK_DOMAIN}.freshdesk.com/api/v2/tickets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(FRESHDESK_API_KEY + ':X').toString('base64')
        },
        body: JSON.stringify(ticketPayload)
      });
      
      if (response.ok) {
        const ticket = await response.json();
        ticketId = ticket.id;
        ticketCreated = true;
        
        // Update report with ticket ID
        report.freshdeskTicketId = ticketId;
        saveDB(db);
        
        logger.info('Freshdesk ticket auto-created for fraud report', {
          reportId: report.id,
          ticketId,
          type,
          userId: req.user.userId,
          transactionId
        });
      } else {
        logger.error('Failed to create Freshdesk ticket for fraud report', {
          reportId: report.id,
          status: response.status,
          statusText: response.statusText
        });
      }
    } catch (error) {
      logger.error('Error creating Freshdesk ticket for fraud report', {
        reportId: report.id,
        error: error.message
      });
    }
  }
  
  logger.warn('Payroll fraud report created', {
    reportId: report.id,
    userId: req.user.userId,
    type,
    transactionId,
    priority: report.priority,
    ticketCreated,
    ticketId
  });
  
  res.json({
    success: true,
    report: {
      id: report.id,
      status: report.status,
      priority: report.priority,
      createdAt: report.createdAt
    },
    ticket: ticketCreated ? {
      created: true,
      ticketId,
      message: 'Support ticket created - our team will investigate within 24 hours'
    } : {
      created: false,
      message: 'Report submitted - please contact support for urgent issues'
    }
  });
});

// Get fraud reports (user view)
app.get('/payroll/fraud-reports', authMiddleware, (req, res) => {
  const db = loadDB();
  
  const reports = (db.fraudReports || [])
    .filter(r => r.userId === req.user.userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(r => ({
      id: r.id,
      transactionId: r.transactionId,
      type: r.type,
      status: r.status,
      priority: r.priority,
      createdAt: r.createdAt,
      freshdeskTicketId: r.freshdeskTicketId
    }));
  
  res.json({ reports });
});

// Report employer fraud/abuse
app.post('/employer/report', authMiddleware, (req, res) => {
  const db = loadDB();
  const { employerId, type, details } = req.body;
  
  if (!employerId || !type || !details) {
    return res.status(400).json({ error: t('error_missing_fields', req.lang || 'en') });
  }
  
  const validTypes = ['fraud', 'scam', 'fake_payroll', 'harassment', 'spam', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }
  
  const employer = db.employers.find(e => e.id === employerId);
  if (!employer) {
    return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
  }
  
  const user = db.users.find(u => u.id === req.user.userId);
  
  // Create employer report
  const report = {
    id: uuidv4(),
    reporterId: req.user.userId,
    employerId,
    employerName: employer.companyName,
    type,
    details,
    status: 'under_review',
    priority: (type === 'fraud' || type === 'scam') ? 'high' : 'medium',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    actionTaken: null
  };
  
  if (!db.employerReports) db.employerReports = [];
  db.employerReports.push(report);
  
  // Add to audit log
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.push({
    id: uuidv4(),
    type: 'employer_report_created',
    userId: req.user.userId,
    reportId: report.id,
    employerId,
    reportType: type,
    timestamp: Date.now(),
    ipAddress: req.clientIP || 'unknown'
  });
  
  saveDB(db);
  
  logger.warn('Employer fraud/abuse report created', {
    reportId: report.id,
    reporterId: req.user.userId,
    employerId,
    type,
    priority: report.priority
  });
  
  res.json({
    success: true,
    report: {
      id: report.id,
      status: report.status,
      priority: report.priority,
      createdAt: report.createdAt
    },
    message: 'Report submitted - compliance team will investigate'
  });
});

// ==================== GDPR COMPLIANCE ENDPOINTS ====================

// Export user data (GDPR Article 20 - Data Portability)
app.get('/gdpr/export', authMiddleware, (req, res) => {
  const db = loadDB();
  const userId = req.user.userId;
  
  logger.info('GDPR data export requested', { userId, ip: req.clientIP });
  
  const userData = {
    user: db.users.find(u => u.id === userId),
    wallets: (db.wallets || []).filter(w => w.userId === userId),
    transactions: (db.transactions || []).filter(t => t.userId === userId),
    virtualCards: (db.virtualCards || []).filter(c => c.userId === userId).map(sanitizeCard),
    paymentRequests: (db.paymentRequests || []).filter(pr => pr.from === userId || pr.to === userId),
    kyc: (db.kyc || []).find(k => k.userId === userId),
    supportTickets: (db.supportTickets || []).filter(t => t.userId === userId),
    devices: (db.devices || []).filter(d => d.userId === userId),
    exportedAt: new Date().toISOString(),
    exportFormat: 'JSON'
  };
  
  // Remove sensitive data from export
  if (userData.user) {
    delete userData.user.passwordHash;
  }
  
  auditLogger.info('GDPR_EXPORT', { userId, ip: req.clientIP });
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="egwallet-data-${userId}-${Date.now()}.json"`);
  res.json(userData);
});

// Delete user account (GDPR Article 17 - Right to be Forgotten)
app.delete('/gdpr/delete-account', authMiddleware, async (req, res) => {
  const db = loadDB();
  const userId = req.user.userId;
  const { confirmEmail, confirmPassword } = req.body;
  
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  // Require email and password confirmation
  if (user.email !== confirmEmail) {
    return res.status(400).json({ error: t('error_email_confirm_mismatch', req.lang || 'en') });
  }
  
  if (!confirmPassword || !bcrypt.compareSync(confirmPassword, user.passwordHash)) {
    return res.status(400).json({ error: t('error_password_confirm_invalid', req.lang || 'en') });
  }
  
  // Block deletion if the user still holds funds — prevent permanent balance loss
  const userWallets = (db.wallets || []).filter(w => w.userId === userId);
  const hasFunds = userWallets.some(
    w => (w.balances || []).some(b => (b.amount || 0) > 0) ||
         Object.values(w.holdBalance || {}).some(amt => (amt || 0) > 0)
  );
  if (hasFunds) {
    return res.status(400).json({
      error: 'Account cannot be deleted while wallet balance or pending holds are above zero. Please withdraw all funds first.',
    });
  }

  logger.warn('Account deletion requested', { userId, email: maskEmail(user.email), ip: req.clientIP });
  
  // Anonymize instead of hard delete (for compliance)
  user.email = `deleted-${userId}@egwallet.deleted`;
  user.passwordHash = '';
  user.status = 'deleted';
  user.deletedAt = Date.now();
  user.deletionIP = req.clientIP;
  // Invalidate all JWTs immediately (C2: deleted user cannot keep valid access)
  user.tokenVersion = (user.tokenVersion || 0) + 1;

  // Remove all refresh tokens so re-issuance is impossible
  if (!db.refreshTokens) db.refreshTokens = [];
  db.refreshTokens = db.refreshTokens.filter(t => t.userId !== userId);
  
  // Anonymize personal data in KYC
  const kyc = (db.kyc || []).find(k => k.userId === userId);
  if (kyc) {
    kyc.status = 'deleted';
    kyc.fullName = '[DELETED]';
    kyc.dateOfBirth = '[DELETED]';
    kyc.address = '[DELETED]';
    kyc.documents = [];
  }
  
  // Mark cards as deleted
  (db.virtualCards || []).filter(c => c.userId === userId).forEach(card => {
    card.status = 'deleted';
  });

  // H-1 (GDPR Art. 17): Redact encrypted PII from withdrawal records.
  // Non-PII audit fields (id, userId, amount, currency, status, timestamps) are
  // kept for financial reconciliation; all identifying bank/account data is erased.
  (db.withdrawals || []).filter(w => w.userId === userId).forEach(w => {
    w.accountNumber     = null;
    w.iban              = null;
    w.swiftBic          = null;
    w.accountHolderName = null;
    w.bankName          = null;
    w.accountMask       = '[DELETED]';
    w.bankNameDisplay   = '[DELETED]';
  });

  saveDB(db);
  
  auditLogger.warn('ACCOUNT_DELETED', { 
    userId, 
    email: maskEmail(user.email), 
    ip: req.clientIP,
    timestamp: Date.now()
  });
  
  res.json({ 
    success: true, 
    message: 'Account has been deleted. All personal data has been anonymized.' 
  });
});

// Get data processing consent status
app.get('/gdpr/consent', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  res.json({
    userId: user.id,
    consents: user.consents || {
      marketing: false,
      analytics: false,
      dataProcessing: true, // Required for service
      thirdPartySharing: false
    },
    lastUpdated: user.consentsUpdatedAt || user.createdAt
  });
});

// Update data processing consent
app.post('/gdpr/consent', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  
  if (!user) return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
  
  const { marketing, analytics, thirdPartySharing } = req.body;
  
  user.consents = {
    marketing: marketing === true,
    analytics: analytics === true,
    dataProcessing: true, // Always true (required for service)
    thirdPartySharing: thirdPartySharing === true
  };
  user.consentsUpdatedAt = Date.now();
  
  saveDB(db);
  
  auditLogger.info('CONSENT_UPDATED', { 
    userId: user.id, 
    consents: user.consents, 
    ip: req.clientIP 
  });
  
  res.json({ success: true, consents: user.consents });
});

// ==================== ADMIN/MONITORING ENDPOINTS ====================

// Get audit logs (admin only)
app.get('/admin/audit-logs', authMiddleware, adminMiddleware, (req, res) => {
  const { limit = 100, userId, action } = req.query;
  
  let logs = [...aiAuditLogs];
  
  if (userId) {
    logs = logs.filter(log => log.userId === userId);
  }
  
  if (action) {
    logs = logs.filter(log => log.action === action);
  }
  
  logs = logs.slice(-parseInt(limit));
  
  res.json({ 
    logs, 
    total: logs.length,
    inMemory: true,
    note: 'Full audit logs available in audit.log file'
  });
});

// System health check (detailed, admin only)
app.get('/admin/health/detailed', authMiddleware, adminMiddleware, (req, res) => {
  const db = loadDB();
  
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    version: '1.0.0',
    database: {
      connected: fs.existsSync(DB_FILE),
      users: db.users?.length || 0,
      wallets: db.wallets?.length || 0,
      transactions: db.transactions?.length || 0,
      tickets: db.supportTickets?.length || 0,
      devices: db.devices?.length || 0
    },
    integrations: {
      freshdesk: !!(FRESHDESK_DOMAIN && FRESHDESK_API_KEY)
    },
    features: {
      rateLimit: true,
      auditLogs: process.env.ENABLE_AUDIT_LOGS !== 'false',
      helmet: process.env.ENABLE_HELMET !== 'false',
      gdpr: process.env.ENABLE_GDPR_FEATURES !== 'false'
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    }
  };
  
  res.json(health);
});

// Fraud velocity status (admin only)
app.get('/admin/fraud-velocity', authMiddleware, adminMiddleware, (req, res) => {
  const velocityStats = [];
  
  for (const [userId, timestamps] of fraudVelocityTracker.entries()) {
    velocityStats.push({
      userId,
      activityCount: timestamps.length,
      oldestActivity: new Date(Math.min(...timestamps)).toISOString(),
      newestActivity: new Date(Math.max(...timestamps)).toISOString(),
      suspicious: timestamps.length >= FRAUD_VELOCITY_THRESHOLD
    });
  }
  
  res.json({ 
    threshold: FRAUD_VELOCITY_THRESHOLD,
    timeWindow: FRAUD_TIME_WINDOW,
    trackedUsers: velocityStats.length,
    suspicious: velocityStats.filter(s => s.suspicious).length,
    details: velocityStats
  });
});

// ==================== PAYROLL & EMPLOYER ENDPOINTS ====================

// Configure multer for CSV file uploads (in-memory storage)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// ════════════════════════════════════════════════════════════════
// KYC TIER LIMIT SYSTEM
// ════════════════════════════════════════════════════════════════
//
// All limits are stored and enforced in USD.
//
// Storage:  user.limitTracking  — persisted to db.json per user.
//   {
//     dailyUsedUSD:    number,   // USD sent in current calendar day (UTC)
//     weeklyUsedUSD:   number,   // USD sent in current Mon-Sun week (UTC)
//     monthlyUsedUSD:  number,   // USD sent in current calendar month (UTC)
//     dayKey:          string,   // 'YYYY-MM-DD'  — resets daily bucket when changed
//     weekKey:         string,   // 'YYYY-WW'     — resets weekly bucket when changed
//     monthKey:        string,   // 'YYYY-MM'     — resets monthly bucket when changed
//   }
//
// Conversion: amount (minor units, any currency) → major → USD
//   amountUSD = minorToMajor(amount, currency) / rates[currency]
//   This conversion is done by the caller before calling checkKYCLimits.

const KYC_TIERS = {
  0: { name: 'Starter',   dailyLimit: 300,   weeklyLimit: 1000,  monthlyLimit: 2000  },
  1: { name: 'Basic KYC', dailyLimit: 2000,  weeklyLimit: 5000,  monthlyLimit: 10000 },
  2: { name: 'Verified',  dailyLimit: 10000, weeklyLimit: 25000, monthlyLimit: 50000 },
};

/** Returns today's UTC calendar key: 'YYYY-MM-DD' */
function getDayKey()   { return new Date().toISOString().slice(0, 10); }
/** Returns current ISO week key: 'YYYY-WW' (Monday anchor) */
function getWeekKey() {
  const d = new Date();
  const day = d.getUTCDay() || 7; // Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  const year = d.getUTCFullYear();
  const week = Math.ceil((((d - Date.UTC(year, 0, 1)) / 86400000) + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}
/** Returns current UTC month key: 'YYYY-MM' */
function getMonthKey() { return new Date().toISOString().slice(0, 7); }

/**
 * Initialise limitTracking on a user object if missing.
 * Mutates the user object in place — caller must saveDB.
 */
function ensureLimitTracking(user) {
  if (!user.limitTracking) {
    user.limitTracking = {
      dailyUsedUSD:   0,
      weeklyUsedUSD:  0,
      monthlyUsedUSD: 0,
      dayKey:         getDayKey(),
      weekKey:        getWeekKey(),
      monthKey:       getMonthKey(),
    };
  }
}

/**
 * Apply calendar resets to limitTracking.
 * If the day/week/month key has changed since last transaction, the
 * corresponding bucket resets to 0.
 * Mutates user.limitTracking in place — caller must saveDB.
 */
function applyLimitResets(user) {
  ensureLimitTracking(user);
  const lt = user.limitTracking;
  const dk = getDayKey(), wk = getWeekKey(), mk = getMonthKey();
  if (lt.dayKey   !== dk) { lt.dailyUsedUSD   = 0; lt.dayKey   = dk; }
  if (lt.weekKey  !== wk) { lt.weeklyUsedUSD  = 0; lt.weekKey  = wk; }
  if (lt.monthKey !== mk) { lt.monthlyUsedUSD = 0; lt.monthKey = mk; }
}

/**
 * Check KYC tier limits for a prospective send of `amountUSD`.
 * Does NOT mutate the user record — call updateLimitTracking on success.
 *
 * Returns on BLOCK:
 *   { allowed: false, code: 'LIMIT_EXCEEDED', limitType, message,
 *     remainingDailyUSD, remainingWeeklyUSD, remainingMonthlyUSD,
 *     tierLevel, nextTier }
 *
 * Returns on ALLOW:
 *   { allowed: true,
 *     remainingDailyUSD, remainingWeeklyUSD, remainingMonthlyUSD,
 *     tierLevel }
 */
function checkKYCLimits(user, amountUSD, _db) {
  // _db kept for signature compatibility; not needed with stored tracking
  applyLimitResets(user); // apply calendar resets (read-only side-effect on in-memory object)

  const tierLevel = user.kycTier || 0;
  const tier      = KYC_TIERS[tierLevel] || KYC_TIERS[0];
  const lt        = user.limitTracking;
  const lang      = user.language || 'en';

  const dailyUsed   = lt.dailyUsedUSD   || 0;
  const weeklyUsed  = lt.weeklyUsedUSD  || 0;
  const monthlyUsed = lt.monthlyUsedUSD || 0;

  const remDay   = Math.max(0, tier.dailyLimit   - dailyUsed);
  const remWeek  = Math.max(0, tier.weeklyLimit  - weeklyUsed);
  const remMonth = Math.max(0, tier.monthlyLimit - monthlyUsed);

  const nextTier = KYC_TIERS[tierLevel + 1] || null;

  if (dailyUsed + amountUSD > tier.dailyLimit) {
    return {
      allowed: false,
      code: 'LIMIT_EXCEEDED',
      limitType: 'daily',
      message: t('limit_daily_reached', lang, { limit: '$' + tier.dailyLimit.toLocaleString() }),
      remainingDailyUSD:   remDay,
      remainingWeeklyUSD:  remWeek,
      remainingMonthlyUSD: remMonth,
      tierLevel,
      nextTier,
    };
  }

  if (weeklyUsed + amountUSD > tier.weeklyLimit) {
    return {
      allowed: false,
      code: 'LIMIT_EXCEEDED',
      limitType: 'weekly',
      message: t('limit_weekly_reached', lang, { limit: '$' + tier.weeklyLimit.toLocaleString() }),
      remainingDailyUSD:   remDay,
      remainingWeeklyUSD:  remWeek,
      remainingMonthlyUSD: remMonth,
      tierLevel,
      nextTier,
    };
  }

  if (monthlyUsed + amountUSD > tier.monthlyLimit) {
    return {
      allowed: false,
      code: 'LIMIT_EXCEEDED',
      limitType: 'monthly',
      message: t('limit_monthly_reached', lang, { limit: '$' + tier.monthlyLimit.toLocaleString() }),
      remainingDailyUSD:   remDay,
      remainingWeeklyUSD:  remWeek,
      remainingMonthlyUSD: remMonth,
      tierLevel,
      nextTier,
    };
  }

  // Allowed — report remaining AFTER this transaction
  return {
    allowed: true,
    remainingDailyUSD:   Math.max(0, remDay   - amountUSD),
    remainingWeeklyUSD:  Math.max(0, remWeek  - amountUSD),
    remainingMonthlyUSD: Math.max(0, remMonth - amountUSD),
    tierLevel,
  };
}

/**
 * Increment stored USD usage buckets after a successful send.
 * Applies calendar resets first, then adds amountUSD.
 * Mutates user.limitTracking in place — caller must saveDB.
 */
function updateLimitTracking(user, amountUSD) {
  applyLimitResets(user);
  const lt = user.limitTracking;
  lt.dailyUsedUSD   = (lt.dailyUsedUSD   || 0) + amountUSD;
  lt.weeklyUsedUSD  = (lt.weeklyUsedUSD  || 0) + amountUSD;
  lt.monthlyUsedUSD = (lt.monthlyUsedUSD || 0) + amountUSD;
}

// Helper: Convert amount to USD for limit checking
function convertToUSD(amount, currency, rates) {
  const rate = (rates && rates.values) ? (rates.values[currency] || 1) : 1;
  return amount / rate;
}

// ════════════════════════════════════════════════════════════════
// PAYROLL LIMIT SYSTEM — separate from personal KYC tier limits
// ════════════════════════════════════════════════════════════════
//
// Payroll transactions use a dedicated daily/monthly limit tied to the
// employer record, NOT the sender's personal KYC tier limits.
// Personal sends still use checkKYCLimits() / KYC_TIERS as before.

const PAYROLL_DAILY_LIMIT_USD  = parseInt(process.env.PAYROLL_DAILY_LIMIT_USD)  || 50000;
const PAYROLL_MONTHLY_LIMIT_USD = parseInt(process.env.PAYROLL_MONTHLY_LIMIT_USD) || 500000;

/**
 * Ensure payroll limit tracking fields exist on an employer record.
 * Mutates employer in place — caller must saveDB.
 */
function ensurePayrollLimitTracking(employer) {
  if (!employer.payrollLimitTracking) {
    employer.payrollLimitTracking = {
      dailyUsedUSD:   0,
      monthlyUsedUSD: 0,
      dayKey:         getDayKey(),
      monthKey:       getMonthKey(),
    };
  }
}

/**
 * Apply calendar resets to payroll limit tracking.
 * Mutates employer.payrollLimitTracking in place.
 */
function applyPayrollLimitResets(employer) {
  ensurePayrollLimitTracking(employer);
  const plt = employer.payrollLimitTracking;
  const dk  = getDayKey(), mk = getMonthKey();
  if (plt.dayKey   !== dk) { plt.dailyUsedUSD   = 0; plt.dayKey   = dk; }
  if (plt.monthKey !== mk) { plt.monthlyUsedUSD = 0; plt.monthKey = mk; }
}

/**
 * Check payroll-specific limits for a prospective batch of `amountUSD`.
 *
 * Conditions for payroll limits to apply (ALL must be true):
 *   1. Transaction is initiated from a payroll flow (employer/bulk-payment endpoint)
 *   2. Sender is a registered employer (db.employers record exists)
 *   3. Employer has verificationStatus === 'verified'
 *
 * Returns { allowed, code?, limitType?, message?, remainingDailyUSD, remainingMonthlyUSD }
 */
function checkPayrollLimits(employer, amountUSD, lang = 'en') {
  applyPayrollLimitResets(employer);
  const plt = employer.payrollLimitTracking;

  const dailyUsed   = plt.dailyUsedUSD   || 0;
  const monthlyUsed = plt.monthlyUsedUSD || 0;

  const dailyLimit  = employer.payrollDailyLimitUSD  || PAYROLL_DAILY_LIMIT_USD;
  const monthlyLimit = employer.payrollMonthlyLimitUSD || PAYROLL_MONTHLY_LIMIT_USD;

  const remDay   = Math.max(0, dailyLimit   - dailyUsed);
  const remMonth = Math.max(0, monthlyLimit - monthlyUsed);

  if (dailyUsed + amountUSD > dailyLimit) {
    return {
      allowed: false,
      code: 'PAYROLL_LIMIT_EXCEEDED',
      limitType: 'daily',
      message: t('limit_daily_reached', lang, { limit: '$' + dailyLimit.toLocaleString() }),
      remainingDailyUSD:   remDay,
      remainingMonthlyUSD: remMonth,
    };
  }

  if (monthlyUsed + amountUSD > monthlyLimit) {
    return {
      allowed: false,
      code: 'PAYROLL_LIMIT_EXCEEDED',
      limitType: 'monthly',
      message: t('limit_monthly_reached', lang, { limit: '$' + monthlyLimit.toLocaleString() }),
      remainingDailyUSD:   remDay,
      remainingMonthlyUSD: remMonth,
    };
  }

  return {
    allowed: true,
    remainingDailyUSD:   Math.max(0, remDay   - amountUSD),
    remainingMonthlyUSD: Math.max(0, remMonth - amountUSD),
  };
}

/**
 * Increment payroll usage buckets after a successful batch.
 * Mutates employer.payrollLimitTracking — caller must saveDB.
 */
function updatePayrollLimitTracking(employer, amountUSD) {
  applyPayrollLimitResets(employer);
  const plt = employer.payrollLimitTracking;
  plt.dailyUsedUSD   = (plt.dailyUsedUSD   || 0) + amountUSD;
  plt.monthlyUsedUSD = (plt.monthlyUsedUSD || 0) + amountUSD;
}

// ════════════════════════════════════════════════════════════════

// Register employer
app.post('/employer/register',
  authMiddleware,
  validateInput([
    body('companyName').trim().notEmpty().isLength({ max: 200 }),
    body('taxId').trim().notEmpty().isLength({ max: 100 }),
    body('businessLicense').optional().trim(),
    body('employeeCount').isInt({ min: 1 }),
    body('fundingCurrency').optional().isString()
  ]),
  async (req, res) => {
    const db = loadDB();
    
    // Check if user already has an employer account
    const existing = db.employers.find(e => e.userId === req.user.userId);
    if (existing) {
      return res.status(400).json({ error: t('error_employer_exists', req.lang || 'en') });
    }
    
    // User must be at least Tier 2 to register as employer
    const user = db.users.find(u => u.id === req.user.userId);
    if (!user || user.kycTier < 2) {
      return res.status(403).json({ 
        error: 'Insufficient KYC tier',
        message: 'You must complete Tier 2 KYC verification to register as an employer',
        currentTier: user?.kycTier || 0,
        requiredTier: 2
      });
    }
    
    const { companyName, taxId, businessLicense, employeeCount, fundingCurrency } = req.body;
    
    const employer = {
      id: `EMP-${uuidv4()}`,
      userId: req.user.userId,
      companyName,
      taxId,
      businessLicense: businessLicense || null,
      employeeCount,
      verificationStatus: 'pending', // pending | verified | rejected
      verifiedAt: null,
      verifiedBy: null,
      createdAt: Date.now(),
      totalPayrollSent: 0,
      totalBatches: 0,
      fundingWalletId: null
    };
    
    // Create dedicated funding wallet for employer
    const fundingWallet = {
      id: `WALLET-${employer.id}`,
      userId: req.user.userId,
      employerId: employer.id,
      type: 'employer_funding',
      balances: [{ currency: fundingCurrency || 'XAF', amount: 0 }],
      createdAt: Date.now(),
      maxLimitUSD: Infinity // Employers have no limit on funding wallet
    };
    
    employer.fundingWalletId = fundingWallet.id;
    
    db.employers.push(employer);
    db.wallets.push(fundingWallet);
    saveDB(db);
    
    logAIInteraction(req.user.userId, 'EMPLOYER_REGISTERED', [employer.id], null, req);
    logger.info('Employer registered', { employerId: employer.id, companyName, userId: req.user.userId });
    
    res.json({ 
      success: true, 
      employer: {
        id: employer.id,
        companyName: employer.companyName,
        verificationStatus: employer.verificationStatus,
        fundingWalletId: employer.fundingWalletId
      }
    });
  }
);

// Get employer profile
app.get('/employer/profile', authMiddleware, (req, res) => {
  const db = loadDB();
  const employer = db.employers.find(e => e.userId === req.user.userId);
  
  if (!employer) {
    return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
  }
  
  const fundingWallet = db.wallets.find(w => w.id === employer.fundingWalletId);
  
  res.json({
    ...employer,
    fundingWallet: fundingWallet ? {
      id: fundingWallet.id,
      balances: fundingWallet.balances
    } : null
  });
});

// Upload and parse payroll CSV
app.post('/employer/upload-payroll',
  authMiddleware,
  upload.single('payrollFile'),
  async (req, res) => {
    const db = loadDB();
    
    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) {
      return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
    }
    
    if (employer.verificationStatus !== 'verified') {
      return res.status(403).json({ 
        error: 'Employer not verified',
        message: 'Your employer account must be verified before sending payroll'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: t('error_no_file_uploaded', req.lang || 'en') });
    }
    
    try {
      // Parse CSV
      const csvContent = req.file.buffer.toString('utf-8');
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
      
      if (records.length === 0) {
        return res.status(400).json({ error: t('error_csv_empty', req.lang || 'en') });
      }
      
      // Validate CSV structure (required columns: worker_id or email, amount, currency)
      const requiredColumns = ['amount', 'currency'];
      const firstRecord = records[0];
      const hasWorkerId = 'worker_id' in firstRecord || 'workerID' in firstRecord || 'workerId' in firstRecord;
      const hasEmail = 'email' in firstRecord;
      
      if (!hasWorkerId && !hasEmail) {
        return res.status(400).json({ 
          error: 'Invalid CSV format',
          message: 'CSV must contain either "worker_id" or "email" column'
        });
      }
      
      for (const col of requiredColumns) {
        if (!(col in firstRecord)) {
          return res.status(400).json({ 
            error: 'Invalid CSV format',
            message: `CSV must contain "${col}" column`
          });
        }
      }
      
      // Process and validate each row
      const payrollItems = [];
      const errors = [];
      
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2; // +2 because index starts at 0 and row 1 is header
        
        const workerId = row.worker_id || row.workerID || row.workerId;
        const email = row.email;
        const amount = parseFloat(row.amount);
        const currency = row.currency?.toUpperCase();
        const memo = row.memo || row.description || `Payroll payment for ${employer.companyName}`;
        
        // Find worker
        let workerUser = null;
        if (workerId) {
          workerUser = db.users.find(u => u.id === workerId);
        } else if (email) {
          workerUser = db.users.find(u => u.email === email);
        }
        
        if (!workerUser) {
          errors.push({ row: rowNum, error: t('error_worker_not_found', req.lang || 'en') });
          continue;
        }
        
        // Find worker's wallet
        const workerWallet = db.wallets.find(w => w.userId === workerUser.id && w.type !== 'employer_funding');
        if (!workerWallet) {
          errors.push({ row: rowNum, error: t('error_wallet_not_found', req.lang || 'en') });
          continue;
        }
        
        // Validate amount
        if (isNaN(amount) || amount <= 0) {
          errors.push({ row: rowNum, error: `Invalid amount: ${row.amount}` });
          continue;
        }
        
        // Validate currency
        if (!currency || !db.rates.values[currency]) {
          errors.push({ row: rowNum, error: `Invalid currency: ${row.currency}` });
          continue;
        }
        
        // CSV amounts are in major units (e.g. 1000 NGN = 1,000 NGN).
        // Wallet balances and all downstream operations use minor units,
        // so convert here — after both amount and currency have been validated.
        const amountMinor = majorToMinor(amount, currency);
        payrollItems.push({
          rowNum,
          workerId: workerUser.id,
          workerEmail: workerUser.email,
          workerName: row.name || workerUser.email,
          walletId: workerWallet.id,
          amount: amountMinor,
          currency,
          memo
        });
      }
      
      // Return preview
      res.json({
        success: true,
        totalRows: records.length,
        validItems: payrollItems.length,
        errors: errors.length,
        errorDetails: errors,
        preview: payrollItems.slice(0, 10), // First 10 items
        totalAmount: payrollItems.reduce((sum, item) => {
          // item.amount is in minor units after M1 fix; convert before USD calculation
          const usdAmount = convertToUSD(minorToMajor(item.amount, item.currency), item.currency, db.rates);
          return sum + usdAmount;
        }, 0)
      });
      
    } catch (error) {
      logger.error('CSV parsing error', { error: error.message, employerId: employer.id });
      res.status(400).json({ 
        error: t('error_invalid_csv', req.lang || 'en'),
        message: error.message
      });
    }
  }
);

// Process bulk payroll payment
app.post('/employer/bulk-payment',
  authMiddleware,
  validateInput([
    body('payrollItems').isArray({ min: 1, max: 1000 }),
    body('payrollItems.*.workerId').isString(),
    body('payrollItems.*.walletId').isString(),
    body('payrollItems.*.amount').isInt({ min: 1 }),
    body('payrollItems.*.currency').isString()
  ]),
  async (req, res) => {
    // ── Idempotency check (same pattern as POST /transactions) ─────────────
    const clientKey = req.body.idempotencyKey ||
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'];
    if (!clientKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
    const cached0 = idempotencyStore.get(clientKey);
    if (cached0 && cached0.userId === req.user.userId && Date.now() - cached0.timestamp < IDEMPOTENCY_EXPIRY) {
      return res.status(200).json(cached0.response);
    }

    return withBalanceMutex(async () => {
    const db = loadDB();

    // Durable idempotency — survives restart
    if (clientKey) {
      const durableHit = checkDurableIdempotency(db, clientKey, req.user.userId);
      if (durableHit) {
        idempotencyStore.set(clientKey, { userId: req.user.userId, response: durableHit, timestamp: Date.now() });
        return res.status(200).json(durableHit);
      }
    }

    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
    if (employer.verificationStatus !== 'verified') return res.status(403).json({ error: t('error_employer_not_verified', req.lang || 'en') });

    const { payrollItems, payPeriod, notes } = req.body;

    const fundingWallet = db.wallets.find(w => w.id === employer.fundingWalletId);
    if (!fundingWallet) return res.status(500).json({ error: t('error_employer_not_found', req.lang || 'en') });

    // ── PHASE 1: PRE-VALIDATE ALL ITEMS (no money moves yet) ──────────────────
    // Resolve every worker wallet up-front. If any are missing, reject the
    // entire batch before touching a single balance.
    const resolvedItems = [];
    const validationErrors = [];

    const employerUser = db.users.find(u => u.id === employer.userId);
    const employerCountry = employerUser?.region || 'GQ';

    for (const item of payrollItems) {
      const workerWallet = db.wallets.find(w => w.id === item.walletId);
      if (!workerWallet) {
        validationErrors.push(`Worker ${item.workerEmail || item.workerId}: wallet ${item.walletId} not found`);
        continue;
      }
      // Wallet must belong to the claimed worker — prevents misdirecting funds to arbitrary wallets
      if (workerWallet.userId !== item.workerId) {
        validationErrors.push(`Worker ${item.workerEmail || item.workerId}: wallet ${item.walletId} does not belong to this worker`);
        continue;
      }
      // Worker must be active and linked to this employer — prevents paying
      // suspended or terminated employees.
      const isLinked = (db.employerEmployees || []).some(
        ee => ee.employerId === employer.id && ee.workerId === item.workerId &&
              ee.status === 'active'
      );
      if (!isLinked) {
        validationErrors.push(`Worker ${item.workerEmail || item.workerId}: not linked to this employer`);
        continue;
      }
      resolvedItems.push({ ...item, workerWallet });
    }

    // High-2: Reject batches with duplicate workerIds — a copy-paste error or
    // malicious input could otherwise debit the employer twice for the same worker
    // in a single saveDB call.
    const batchWorkerIdCounts = new Map();
    for (const item of resolvedItems) {
      batchWorkerIdCounts.set(item.workerId, (batchWorkerIdCounts.get(item.workerId) || 0) + 1);
    }
    const duplicateBatchWorkers = [...batchWorkerIdCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([wid]) => wid);
    if (duplicateBatchWorkers.length > 0) {
      return res.status(400).json({
        error: 'Batch contains duplicate worker entries. Each worker may appear only once per batch.',
        duplicateWorkerIds: duplicateBatchWorkers,
      });
    }

    if (validationErrors.length > 0) {
      logger.error('Payroll batch rejected — validation failed', {
        employerId: employer.id,
        validationErrors,
      });
      return res.status(400).json({
        error: t('error_payroll_validation', req.lang || 'en'),
        validationErrors,
      });
    }

    // Cross-flow settlement guard (request→bulk direction): reject bulk items where a
    // payroll_request for that worker+employer was already paid via /payment-requests/:id/pay
    // within the last 24 hours.  This prevents a worker from being paid twice when the
    // employer forgets to remove them from a bulk run after their request was already settled.
    const BULK_DEDUPE_WINDOW = 24 * 60 * 60 * 1000;
    const bulkNow = Date.now();

    // High-1: Extend the dedupe set to cover both channels:
    //   (a) payroll_request records paid via /payment-requests/:id/pay
    //   (b) payroll transactions created by a prior /employer/bulk-payment run
    // This blocks bulk→bulk and post-bulk-new-request double payment within 24 hours.
    const settledViaRequest = (db.paymentRequests || [])
      .filter(pr =>
        pr.type === 'payroll_request' &&
        pr.status === 'paid' &&
        (pr.employerId === employer.id || pr.targetEmployerId === employer.id) &&
        pr.paidAt && (bulkNow - pr.paidAt) < BULK_DEDUPE_WINDOW
      )
      .map(pr => pr.userId || pr.requesterId)
      .filter(Boolean);

    const settledViaBulk = (db.transactions || [])
      .filter(tx =>
        tx.type === 'payroll' &&
        tx.status === 'completed' &&
        tx.payrollMetadata?.employerId === employer.id &&
        tx.timestamp && (bulkNow - tx.timestamp) < BULK_DEDUPE_WINDOW
      )
      .map(tx => tx.payrollMetadata?.workerId)
      .filter(Boolean);

    const recentlySettledWorkerIds = new Set([...settledViaRequest, ...settledViaBulk]);
    const alreadyPaidItems = resolvedItems.filter(item =>
      recentlySettledWorkerIds.has(item.workerId)
    );
    if (alreadyPaidItems.length > 0) {
      logger.warn('[/employer/bulk-payment] Bulk batch blocked — workers already paid via request-pay within 24h', {
        employerId: employer.id,
        blockedWorkerIds: alreadyPaidItems.map(i => i.workerId),
      });
      return res.status(409).json({
        error: 'One or more workers in this batch were already paid via a payment request within the last 24 hours. Remove them from the batch or wait 24 hours.',
        blockedWorkerIds: alreadyPaidItems.map(i => i.workerId),
      });
    }

    // Check total funding balance per currency — all at once, before any debit.
    // High-3: Include pending payroll_request reservation so bulk-payment cannot
    // spend funds already notionally reserved by worker-initiated pending requests.
    const totalsNeeded = {};
    for (const item of resolvedItems) {
      totalsNeeded[item.currency] = (totalsNeeded[item.currency] || 0) + item.amount;
    }
    for (const [bulkCurrency, total] of Object.entries(totalsNeeded)) {
      const balance = fundingWallet.balances.find(b => b.currency === bulkCurrency);
      const pendingReserved = (db.paymentRequests || [])
        .filter(r =>
          r.status === 'pending' &&
          r.type === 'payroll_request' &&
          (r.employerId === employer.id || r.targetEmployerId === employer.id) &&
          (r.currency || '').toUpperCase() === bulkCurrency.toUpperCase()
        )
        .reduce((sum, r) => sum + (r.amount || 0), 0);
      const effectivelyAvailable = (balance?.amount || 0) - pendingReserved;
      if (!balance || effectivelyAvailable < total) {
        logger.error('Payroll batch rejected — insufficient funds after pending reservations', {
          employerId: employer.id, currency: bulkCurrency, needed: total,
          available: balance?.amount || 0, pendingReserved, effectivelyAvailable,
        });
        return res.status(400).json({
          error: t('error_insufficient_funds_payroll', req.lang || 'en'),
          currency: bulkCurrency,
          needed: total,
          available: balance?.amount || 0,
          pendingReserved,
        });
      }
    }

    // ── PAYROLL LIMIT CHECK ─────────────────────────────────────────────────
    // Uses the separate payroll daily/monthly limit (NOT personal KYC limits).
    // All three conditions are already met at this point:
    //   1. This is the payroll flow (employer/bulk-payment endpoint)
    //   2. Sender is a registered employer (employer record found above)
    //   3. Employer is verified (verificationStatus check above)
    const batchTotalUSD = resolvedItems.reduce((sum, item) => {
      // item.amount is in minor units; convert to major before USD calculation
      return sum + convertToUSD(minorToMajor(item.amount, item.currency), item.currency, db.rates);
    }, 0);

    const payrollLimitCheck = checkPayrollLimits(employer, batchTotalUSD, req.lang || 'en');
    if (!payrollLimitCheck.allowed) {
      logger.error('Payroll batch rejected — payroll limit exceeded', {
        employerId: employer.id,
        batchTotalUSD: batchTotalUSD.toFixed(2),
        limitType: payrollLimitCheck.limitType,
        remainingDailyUSD: payrollLimitCheck.remainingDailyUSD,
        remainingMonthlyUSD: payrollLimitCheck.remainingMonthlyUSD,
      });
      return res.status(403).json({
        code:                payrollLimitCheck.code,
        error:               payrollLimitCheck.message,
        limitType:           payrollLimitCheck.limitType,
        remainingDailyUSD:   payrollLimitCheck.remainingDailyUSD,
        remainingMonthlyUSD: payrollLimitCheck.remainingMonthlyUSD,
      });
    }

    // ── PHASE 2: EXECUTE ALL PAYMENTS ATOMICALLY ──────────────────────────────
    // All validations passed. Apply every debit and credit in memory using the
    // same logic as POST /transactions, then write to disk exactly once.
    const batchId = `BATCH-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const batch = {
      id: batchId,
      employerId: employer.id,
      employerName: employer.companyName,
      payPeriod: payPeriod || new Date().toISOString().substring(0, 7),
      status: 'completed',
      totalItems: resolvedItems.length,
      successCount: 0,
      failureCount: 0,
      createdAt: Date.now(),
      completedAt: null,
      transactions: [],
      notes: notes || null,
    };

    const results = [];

    logger.info('Payroll batch starting', {
      batchId, employerId: employer.id, itemCount: resolvedItems.length,
    });

    for (const item of resolvedItems) {
      // Debit employer funding wallet (same as fromBalance.amount -= amount in /transactions)
      const fundingBalance = fundingWallet.balances.find(b => b.currency === item.currency);
      fundingBalance.amount -= item.amount;

      // Credit worker wallet — same currency (FX conversion not applied in payroll; employer
      // chooses the currency explicitly). Matches the receivedAmount logic in /transactions.
      const { workerWallet } = item;
      const worker = db.users.find(u => u.id === item.workerId);
      const workerCountry = worker?.region || 'GQ';
      const isCrossBorder = employerCountry !== workerCountry;

      let workerBalance = workerWallet.balances.find(b => b.currency === item.currency);
      if (!workerBalance) {
        workerBalance = { currency: item.currency, amount: 0 };
        workerWallet.balances.push(workerBalance);
      }
      workerBalance.amount += item.amount;

      // Build transaction record — same shape as POST /transactions output
      const txn = {
        id: uuidv4(),
        type: 'payroll',
        fromWalletId: fundingWallet.id,
        toWalletId: item.walletId,
        amount: item.amount,
        currency: item.currency,
        receivedAmount: item.amount,
        receivedCurrency: item.currency,
        wasConverted: false,
        fxFeeAmount: 0,
        sendFeeAmount: 0,
        memo: item.memo || notes || '',
        status: 'completed',
        timestamp: Date.now(),
        payrollMetadata: {
          employerId: employer.id,
          employerName: employer.companyName,
          employerCountry,
          workerCountry,
          isCrossBorder,
          taxTreaty: isCrossBorder ? 'CEMAC' : null,
          payPeriod: batch.payPeriod,
          payrollBatchId: batchId,
          workerId: item.workerId,
          workerEmail: item.workerEmail,
          isRecurring: false,
        },
        complianceFlags: {
          taxable: true,
          reportable: true,
          category: 'wages',
          crossBorder: isCrossBorder,
          currencyConverted: false,
        },
      };

      db.transactions.push(txn);

      // Cross-flow settlement (bulk→request direction): cancel ALL pending
      // payroll_request rows for this worker+employer regardless of currency.
      // Matching only the paid currency left cross-currency requests payable,
      // allowing a second payout in a different currency for the same obligation.
      const settlementTs = Date.now();
      (db.paymentRequests || []).forEach(pr => {
        if (
          pr.status === 'pending' &&
          pr.type === 'payroll_request' &&
          (pr.userId === item.workerId || pr.requesterId === item.workerId) &&
          (pr.employerId === employer.id || pr.targetEmployerId === employer.id)
        ) {
          pr.status = 'cancelled';
          pr.cancelledAt = settlementTs;
          pr.cancelReason = 'settled_via_bulk';
          pr.settledByTransactionId = txn.id;
        }
      });

      batch.transactions.push(txn.id);
      batch.successCount++;

      results.push({
        workerId: item.workerId,
        workerEmail: item.workerEmail,
        status: 'success',
        transactionId: txn.id,
        amount: item.amount,
        currency: item.currency,
      });

      // Notify worker immediately via bell icon
      const displayAmount = minorToMajor(item.amount, item.currency).toFixed(decimalsFor(item.currency));
      createNotification(
        db,
        item.workerId,
        'money_received',
        'Payroll Received',
        `You received ${displayAmount} ${item.currency} from ${employer.companyName}${item.memo ? ` — ${item.memo}` : ''}`,
        { transactionId: txn.id, batchId, employerId: employer.id, amount: item.amount, currency: item.currency }
      );

      logger.info('Payroll payment applied', {
        batchId,
        employerId: employer.id,
        workerId: item.workerId,
        transactionId: txn.id,
        amount: item.amount,
        currency: item.currency,
      });
    }

    batch.completedAt = Date.now();

    // Update employer stats
    employer.totalBatches = (employer.totalBatches || 0) + 1;
    const totalUSD = resolvedItems.reduce((sum, item) => {
      // item.amount is in minor units; convert to major before USD calculation
      return sum + convertToUSD(minorToMajor(item.amount, item.currency), item.currency, db.rates);
    }, 0);
    employer.totalPayrollSent = (employer.totalPayrollSent || 0) + totalUSD;

    // Update payroll limit tracking (separate from personal limits)
    updatePayrollLimitTracking(employer, totalUSD);

    if (!db.payrollBatches) db.payrollBatches = [];
    db.payrollBatches.push(batch);

    // Build response before saveDB so idempotency is committed with the financial mutation.
    const responseBody = {
      success: true,
      batchId: batch.id,
      totalItems: batch.totalItems,
      successCount: batch.successCount,
      failureCount: 0,
      status: 'completed',
      results,
    };
    if (clientKey) saveDurableIdempotency(db, clientKey, responseBody, req.user.userId);

    // Single atomic write — all debits, credits, batch record, and idempotency committed together
    saveDB(db);

    if (clientKey) idempotencyStore.set(clientKey, { userId: req.user.userId, response: responseBody, timestamp: Date.now() });

    logger.info('Payroll batch completed and saved', {
      batchId,
      employerId: employer.id,
      successCount: batch.successCount,
      totalAmountUSD: totalUSD.toFixed(2),
    });

    logAIInteraction(req.user.userId, 'BULK_PAYROLL_SENT', [batchId, batch.successCount], null, req);

    res.json(responseBody);
    }); // withBalanceMutex
  }
);

// Get payroll history
app.get('/employer/payroll-history', authMiddleware, (req, res) => {
  const db = loadDB();
  
  const employer = db.employers.find(e => e.userId === req.user.userId);
  if (!employer) {
    return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
  }
  
  const batches = db.payrollBatches
    .filter(b => b.employerId === employer.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  
  res.json({ batches });
});

// Get payroll batch details
app.get('/employer/payroll-batch/:batchId', authMiddleware, (req, res) => {
  const db = loadDB();
  
  const employer = db.employers.find(e => e.userId === req.user.userId);
  if (!employer) {
    return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
  }
  
  const batch = db.payrollBatches.find(b => 
    b.id === req.params.batchId && b.employerId === employer.id
  );
  
  if (!batch) {
    return res.status(404).json({ error: t('error_not_found', req.lang || 'en') });
  }
  
  // Get full transaction details
  const transactions = db.transactions.filter(t => batch.transactions.includes(t.id));
  
  res.json({
    ...batch,
    transactionDetails: transactions
  });
});

// ==================== EMPLOYER-EMPLOYEE RELATIONSHIPS ====================
// Add employee to employer (employer authorizes worker to request payments)
app.post('/employer/add-employee',
  authMiddleware,
  validateInput([
    body('workerEmail').isEmail(),
    body('workerName').optional().trim().isLength({ max: 200 }),
    body('position').optional().trim().isLength({ max: 100 }),
    body('maxRequestAmount').optional().isInt({ min: 0 })
  ]),
  (req, res) => {
    const db = loadDB();
    const { workerEmail, workerName, position, maxRequestAmount } = req.body;
    
    // Find employer
    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) {
      return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
    }
    
    // Must be verified employer
    if (employer.verificationStatus !== 'verified') {
      return res.status(403).json({ error: t('error_employer_not_verified', req.lang || 'en') });
    }
    
    // Find worker by email
    const worker = db.users.find(u => u.email === workerEmail);
    if (!worker) {
      return res.status(404).json({ error: t('error_worker_not_found', req.lang || 'en') });
    }
    
    // Check if relationship already exists
    const existing = db.employerEmployees.find(
      ee => ee.employerId === employer.id && ee.workerId === worker.id
    );
    if (existing) {
      return res.status(400).json({ error: t('error_employee_added', req.lang || 'en') });
    }
    
    // Create relationship
    const relationship = {
      id: uuidv4(),
      employerId: employer.id,
      employerName: employer.companyName,
      workerId: worker.id,
      workerEmail: worker.email,
      workerName: workerName || '',
      position: position || '',
      status: 'active', // active, suspended, terminated
      maxRequestAmount: maxRequestAmount || 10000, // Max amount per request (in minor units)
      addedAt: Date.now(),
      addedBy: req.user.userId
    };
    
    db.employerEmployees.push(relationship);
    saveDB(db);
    
    // Log audit
    logger.info('Employee added to employer', {
      employerId: employer.id,
      workerId: worker.id,
      addedBy: req.user.userId
    });
    
    res.json({
      success: true,
      relationship
    });
  }
);

// List employees (employer view)
app.get('/employer/employees', authMiddleware, (req, res) => {
  const db = loadDB();
  
  const employer = db.employers.find(e => e.userId === req.user.userId);
  if (!employer) {
    return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
  }
  
  const employees = db.employerEmployees
    .filter(ee => ee.employerId === employer.id)
    .map(ee => {
      const wallet = db.wallets.find(w => w.userId === ee.workerId && w.type !== 'employer_funding');
      return { ...ee, walletId: wallet?.id };
    });

  res.json({ employees });
});

// Fund employer wallet (demo/test endpoint — adds funds for payroll testing)
app.post('/employer/fund-wallet', authMiddleware, adminMiddleware, async (req, res) => {
  // C5: This endpoint mints balance without a real payment source.
  // Disabled in production to prevent fraudulent payroll funding.
  if (process.env.NODE_ENV === 'production') {
    logger.error('POST /employer/fund-wallet called in production — endpoint disabled', {
      userId: req.user.userId,
    });
    return res.status(503).json({
      error: 'Employer wallet funding is not available. Use a real payment source.',
    });
  }

  // Dev/staging only — validate amount before crediting anything.
  const { amount, currency = 'XAF' } = req.body;
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    return res.status(400).json({ error: 'amount must be a positive integer in minor units (max 1 000 000 000)' });
  }

  return withBalanceMutex(async () => {
    const db = loadDB();
    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
    const fundingWallet = db.wallets.find(w => w.id === employer.fundingWalletId);
    if (!fundingWallet) return res.status(500).json({ error: t('error_employer_not_found', req.lang || 'en') });
    let balance = fundingWallet.balances.find(b => b.currency === currency);
    if (!balance) {
      balance = { currency, amount: 0 };
      fundingWallet.balances.push(balance);
    }
    balance.amount += amount;
    saveDB(db);
    logger.info('Employer funding wallet topped up (dev/staging)', { employerId: employer.id, amount, currency });
    res.json({ success: true, balance: { currency: balance.currency, amount: balance.amount } });
  });
});

// Get linked employers (worker view)
app.get('/employer/linked', authMiddleware, (req, res) => {
  const db = loadDB();
  
  // Find all employer-employee relationships for this worker.
  // Records use workerId (correct field set by add-employee).
  // Legacy records that mistakenly stored userId are migrated at startup.
  const relationships = db.employerEmployees.filter(ee => ee.workerId === req.user.userId);
  
  // Get employer details for each relationship
  const employers = relationships.map(rel => {
    const employer = db.employers.find(e => e.id === rel.employerId);
    if (!employer) return null;
    
    return {
      relationshipId: rel.id,
      employerId: employer.id,
      employerName: employer.companyName,
      verificationStatus: employer.verificationStatus,
      linkedAt: rel.addedAt
    };
  }).filter(e => e !== null);
  
  res.json({ employers });
});

// Create payment request to employer (worker view)
app.post('/employer/payment-request',
  authMiddleware,
  validateInput([
    body('employerId').isString(),
    body('amount').isNumeric(),
    body('currency').isString()
  ]),
  (req, res) => {
    const { employerId, amount, memo } = req.body;
    // H-4: Normalize currency to uppercase.
    const cur = String(req.body.currency || '').toUpperCase().trim();

    // --- Fast-path validation (cheap read-only checks, no mutex needed) ---
    const amountMinor = majorToMinor(Number(amount), cur);

    // C-1: Reject zero or negative amounts early.
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      return res.status(400).json({ error: 'amount must be a positive value' });
    }

    // --- Critical section: rate-limit + duplicate + balance + create must be atomic.
    // High-3 fix: wrap in withBalanceMutex and do a fresh loadDB() inside so that
    // concurrent requests cannot both read the same snapshot and bypass the guards.
    withBalanceMutex(() => {
      const db = loadDB();
      const prNow = Date.now();

      // Re-check active linkage inside mutex (fresh snapshot).
      const relationship = (db.employerEmployees || []).find(ee =>
        ee.employerId === employerId && ee.workerId === req.user.userId && ee.status === 'active'
      );
      if (!relationship) {
        res.status(403).json({ error: t('error_not_linked_employer', req.lang || 'en') });
        return;
      }

      // Re-resolve employer inside mutex (may have been suspended since pre-flight).
      const employer = (db.employers || []).find(e => e.id === employerId);
      if (!employer) {
        res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
        return;
      }
      if (employer.verificationStatus !== 'verified') {
        res.status(403).json({ error: t('error_employer_not_verified', req.lang || 'en') });
        return;
      }

      // Per-worker request cap (stored in minor units).
      if (relationship.maxRequestAmount && amountMinor > relationship.maxRequestAmount) {
        res.status(403).json({
          error: t('error_request_exceeds_limit', req.lang || 'en',
            { limit: relationship.maxRequestAmount, currency: cur })
        });
        return;
      }

      // High-5 / High-1: Resolve employer's dedicated funding wallet via fundingWalletId
      // (same pattern as POST /employer/bulk-payment). Using userId instead could pick a
      // personal wallet when an employer holds multiple wallet records.
      const employerWallet = (db.wallets || []).find(w => w.id === employer.fundingWalletId);
      const empBalance = employerWallet && (employerWallet.balances || []).find(b => b.currency === cur);

      // High-1: Include reserved amount from all other pending payroll_request records for
      // this employer + currency so concurrent requests cannot over-commit the funding balance.
      const empReserved = (db.paymentRequests || [])
        .filter(r =>
          r.status === 'pending' &&
          r.type === 'payroll_request' &&
          (r.employerId === employerId || r.targetEmployerId === employerId) &&
          (r.currency || '').toUpperCase() === cur
        )
        .reduce((sum, r) => sum + (r.amount || 0), 0);

      if (!empBalance || empBalance.amount < amountMinor + empReserved) {
        logger.warn('[/employer/payment-request] Funding balance insufficient after reservations', {
          employerId, requested: amountMinor, reserved: empReserved,
          available: empBalance ? empBalance.amount : 0
        });
        res.status(400).json({ error: t('error_employer_insufficient_balance', req.lang || 'en') });
        return;
      }

      // Get worker's wallet (for walletId stored on the request record).
      const userWallet = (db.wallets || []).find(w => w.userId === req.user.userId);
      if (!userWallet) {
        res.status(404).json({ error: t('error_wallet_not_found', req.lang || 'en') });
        return;
      }

      // Rate limit — 5 payroll requests per worker/employer pair per hour.
      const PR_RATE_LIMIT_WINDOW = 60 * 60 * 1000;
      const PR_RATE_LIMIT_MAX = 5;
      if (!db.paymentRequestsRateLimit) db.paymentRequestsRateLimit = {};
      const prRateLimitKey = `${req.user.userId}_${employerId}`;
      if (!db.paymentRequestsRateLimit[prRateLimitKey]) db.paymentRequestsRateLimit[prRateLimitKey] = [];
      db.paymentRequestsRateLimit[prRateLimitKey] = db.paymentRequestsRateLimit[prRateLimitKey]
        .filter(ts => prNow - ts < PR_RATE_LIMIT_WINDOW);
      if (db.paymentRequestsRateLimit[prRateLimitKey].length >= PR_RATE_LIMIT_MAX) {
        logger.warn('[/employer/payment-request] Rate limit exceeded', { workerId: req.user.userId, employerId });
        res.status(429).json({ error: t('error_duplicate_request', req.lang || 'en'), retryAfter: 3600 });
        return;
      }

      // High-4 + High-2: Duplicate-pending guard — 24-hour window.
      // Match on both field names used by legacy (targetEmployerId) and new (employerId) create paths.
      const PR_DUPLICATE_WINDOW = 24 * 60 * 60 * 1000;
      const prDuplicate = (db.paymentRequests || []).find(r =>
        r.type === 'payroll_request' &&
        (r.userId === req.user.userId || r.requesterId === req.user.userId) &&
        (r.employerId === employerId || r.targetEmployerId === employerId) &&
        r.amount === amountMinor &&
        (r.currency || '').toUpperCase() === cur &&
        r.status === 'pending' &&
        (prNow - r.createdAt) < PR_DUPLICATE_WINDOW
      );
      if (prDuplicate) {
        logger.warn('[/employer/payment-request] Duplicate pending request detected', {
          workerId: req.user.userId, employerId, existingId: prDuplicate.id
        });
        res.status(409).json({
          error: t('error_duplicate_request', req.lang || 'en'),
          existingRequestId: prDuplicate.id
        });
        return;
      }

      // All checks passed — record rate-limit timestamp and create request.
      db.paymentRequestsRateLimit[prRateLimitKey].push(prNow);

      const request = {
        id: uuidv4(),
        walletId: userWallet.id,
        userId: req.user.userId,
        requesterId: req.user.userId, // High-1: align with cancel/pay auth checks
        employerId: employerId,
        amount: amountMinor,
        currency: cur,
        memo: memo || '',
        type: 'payroll_request',
        status: 'pending',
        createdAt: prNow,
        paidAt: null,
        payrollMetadata: {
          employerName: employer.companyName,
          employerId: employer.id,
          requestedByWorker: true
        }
      };

      db.paymentRequests.push(request);
      saveDB(db);

      logger.info('Employer payment request created', {
        requestId: request.id, employerId, userId: req.user.userId,
        amount: request.amount, currency: cur
      });

      res.json({
        success: true,
        request: { id: request.id, amount: request.amount, currency: request.currency, status: request.status }
      });
    }).catch(err => {
      logger.error('[/employer/payment-request] mutex error', { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    });
  }
);

// Confirm payroll payment — disabled pending correct implementation.
// This endpoint has a broken wallet schema and no employer debit logic.
// The correct payroll flow is POST /employer/bulk-payment.
app.post('/payroll/confirm-payment', authMiddleware, (req, res) => {
  logger.error('POST /payroll/confirm-payment called — endpoint disabled, use /employer/bulk-payment', {
    userId: req.user.userId,
    body: req.body,
  });
  return res.status(503).json({
    error: 'Payroll QR confirmation is not available. Contact your employer to process payment via the payroll dashboard.',
  });
});

// Remove employee
app.post('/employer/remove-employee/:relationshipId',
  authMiddleware,
  (req, res) => {
    const db = loadDB();
    
    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) {
      return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
    }
    
    const relationshipIndex = db.employerEmployees.findIndex(
      ee => ee.id === req.params.relationshipId && ee.employerId === employer.id
    );
    
    if (relationshipIndex === -1) {
      return res.status(404).json({ error: t('error_not_linked_employer', req.lang || 'en') });
    }
    
    const removed = db.employerEmployees.splice(relationshipIndex, 1)[0];

    // High-2: Auto-cancel pending payroll_request rows for this worker+employer pair.
    // Without this, orphaned pending records permanently reduce the employer's available
    // funding balance in the reservation sum and can never be paid (linkage check fails).
    let cancelledCount = 0;
    (db.paymentRequests || []).forEach(r => {
      if (
        r.status === 'pending' &&
        r.type === 'payroll_request' &&
        (r.userId === removed.workerId || r.requesterId === removed.workerId) &&
        (r.employerId === employer.id || r.targetEmployerId === employer.id)
      ) {
        r.status = 'cancelled';
        r.cancelledAt = Date.now();
        r.cancelReason = 'worker_removed';
        cancelledCount++;
      }
    });

    saveDB(db);
    
    logger.info('Employee removed from employer', {
      employerId: employer.id,
      workerId: removed.workerId,
      removedBy: req.user.userId,
      pendingRequestsCancelled: cancelledCount,
    });
    
    res.json({ success: true, removed });
  }
);

// Update KYC tier (admin endpoint - simplified for demo)
app.post('/admin/update-kyc-tier',
  authMiddleware,
  validateInput([
    body('userId').isString(),
    body('kycTier').isInt({ min: 0, max: 3 }),
    body('kycStatus').isIn(['approved', 'pending', 'rejected'])
  ]),
  (req, res) => {
    const db = loadDB();
    const requestingUser = db.users.find(u => u.id === req.user.userId);
    if (!requestingUser || requestingUser.role !== 'admin') {
      return res.status(403).json({ error: t('error_access_denied', req.lang || 'en') });
    }
    const { userId, kycTier, kycStatus } = req.body;
    
    const user = db.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: t('error_user_not_found', req.lang || 'en') });
    }
    
    user.kycTier = kycTier;
    user.kycStatus = kycStatus;

    saveDB(db);
    logAIInteraction(req.user.userId, 'KYC_TIER_UPDATED', [userId, kycTier], null, req);
    
    logger.info('KYC tier updated', { 
      userId, 
      kycTier, 
      kycStatus, 
      updatedBy: req.user.userId 
    });
    
    res.json({ 
      success: true, 
      user: {
        id: user.id,
        email: user.email,
        kycTier: user.kycTier,
        kycStatus: user.kycStatus,
        kycLimits: user.kycLimits
      }
    });
  }
);

// Verify employer (admin endpoint)
app.post('/admin/verify-employer',
  authMiddleware,
  validateInput([
    body('employerId').isString(),
    body('verificationStatus').isIn(['verified', 'rejected'])
  ]),
  (req, res) => {
    const db = loadDB();
    const requestingUser = db.users.find(u => u.id === req.user.userId);
    if (!requestingUser || requestingUser.role !== 'admin') {
      return res.status(403).json({ error: t('error_access_denied', req.lang || 'en') });
    }
    const { employerId, verificationStatus, notes } = req.body;
    
    const employer = db.employers.find(e => e.id === employerId);
    if (!employer) {
      return res.status(404).json({ error: t('error_employer_not_found', req.lang || 'en') });
    }
    
    employer.verificationStatus = verificationStatus;
    employer.verifiedAt = Date.now();
    employer.verifiedBy = req.user.userId;
    employer.verificationNotes = notes || null;
    
    saveDB(db);
    logAIInteraction(req.user.userId, 'EMPLOYER_VERIFIED', [employerId, verificationStatus], null, req);
    
    logger.info('Employer verification updated', {
      employerId,
      verificationStatus,
      verifiedBy: req.user.userId
    });
    
    res.json({ 
      success: true, 
      employer: {
        id: employer.id,
        companyName: employer.companyName,
        verificationStatus: employer.verificationStatus,
        verifiedAt: employer.verifiedAt
      }
    });
  }
);

// Get worker payroll history (for workers to see their received payroll)
app.get('/payroll/received', authMiddleware, (req, res) => {
  const db = loadDB();
  
  // Get all payroll transactions for this user
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  const walletIds = userWallets.map(w => w.id);
  
  const payrollTransactions = db.transactions
    .filter(t => 
      t.type === 'payroll' && 
      walletIds.includes(t.toWalletId)
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  
  res.json({ 
    payrollTransactions: payrollTransactions.map(t => ({
      id: t.id,
      amount: t.amount,
      currency: t.currency,
      employerName: t.payrollMetadata?.employerName,
      payPeriod: t.payrollMetadata?.payPeriod,
      receivedAt: t.timestamp,
      memo: t.memo
    }))
  });
});

// ==================== ERROR HANDLING ====================

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack, 
    path: req.path,
    method: req.method,
    ip: req.clientIP
  });
  
  if (NODE_ENV === 'production') {
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'An error occurred. Please try again later.',
      timestamp: Date.now()
    });
  } else {
    res.status(500).json({ 
      error: err.message, 
      stack: err.stack 
    });
  }
});

// 404 handler
app.use((req, res) => {
  const lang = req.lang || 'en';
  logger.warn('404 Not Found', { path: req.path, method: req.method, ip: req.clientIP });
  res.status(404).json({
    error: t('error_not_found', lang),
    errorCode: 'error_not_found',
    path: req.path,
  });
});

// ==================== SERVER STARTUP ====================

console.log('PORT from Railway:', process.env.PORT);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server bound to 0.0.0.0:${PORT} — ready for connections`);
  logger.info(`EGWallet backend started`, {
    port: PORT,
    environment: NODE_ENV,
    jwtConfigured: !!JWT_SECRET,
    freshdeskConfigured: !!(FRESHDESK_DOMAIN && FRESHDESK_API_KEY)
  });
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 EGWallet Backend - World-Class Payroll API`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📍 Server: http://0.0.0.0:${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔐 JWT: ${JWT_SECRET ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🎫 Freshdesk: ${(FRESHDESK_DOMAIN && FRESHDESK_API_KEY) ? '✅ Integrated' : '⚠️  Local only'}`);
  console.log(`🛡️  Security: Helmet ${process.env.ENABLE_HELMET !== 'false' ? '✅' : '❌'} | Rate Limit ✅`);
  console.log(`📊 Logging: Winston ✅ | Audit Logs ${process.env.ENABLE_AUDIT_LOGS !== 'false' ? '✅' : '❌'}`);
  console.log(`🔍 GDPR: ${process.env.ENABLE_GDPR_FEATURES !== 'false' ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`💼 Payroll: ✅ Enabled | KYC Tiers: 0-3`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n📝 Endpoints:`);
  console.log(`   Health: GET /health, /healthz`);
  console.log(`   Auth: POST /auth/register, /auth/login`);
  console.log(`   AI: POST /ai/chat (rate limit: ${process.env.AI_CHAT_RATE_LIMIT || 10}/min)`);
  console.log(`   GDPR: GET /gdpr/export, DELETE /gdpr/delete-account`);
  console.log(`   Admin: GET /admin/health/detailed, /admin/audit-logs`);
  console.log(`   Employer: POST /employer/register, /employer/add-employee, /employer/upload-payroll`);
  console.log(`   Payroll: POST /employer/bulk-payment, GET /payroll/received`);
  console.log(`   QR Codes: GET /qr/static, POST /qr/dynamic, POST /qr/validate, POST /qr/pay`);
  console.log(`   Fraud: POST /payroll/report-fraud, POST /employer/report`);
  console.log(`${'='.repeat(60)}\n`);
});

server.on('error', (err) => {
  console.error('SERVER LISTEN ERROR:', err.code, err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  }
  process.exit(1);
});

// ── Startup: migrate legacy withdrawal PII to encrypted format ────────────────
// Scrubs full card PANs to last4; encrypts plaintext bank PII; sets accountMask
// and bankNameDisplay display copies.  Safe to re-run — isEncrypted() guard is idempotent.
setImmediate(() => {
  try {
    const db = loadDB();
    let changed = 0;
    const PII_FIELDS = ['accountNumber', 'iban', 'swiftBic', 'accountHolderName', 'bankName'];
    for (const w of (db.withdrawals || [])) {
      let dirty = false;

      // Scrub full card PANs — must happen before encryption to avoid encrypting a full PAN.
      if ((w.method === 'debit' || w.method === 'credit') && w.accountNumber) {
        const raw = String(w.accountNumber);
        if (!isEncrypted(raw) && raw.replace(/\D/g, '').length > 4) {
          w.accountNumber = raw.replace(/\D/g, '').slice(-4) || null;
          dirty = true;
        }
      }

      // Encrypt any plaintext PII field that hasn't been migrated yet.
      for (const field of PII_FIELDS) {
        if (w[field] && !isEncrypted(w[field])) {
          w[field] = encryptPII(w[field]);
          dirty = true;
        }
      }

      // Back-fill display copies if missing.
      if (!w.accountMask && w.accountNumber) {
        // accountNumber may now be encrypted — compute mask from raw before encrypt if possible,
        // but for already-encrypted records we can only set a generic mask.
        w.accountMask = isEncrypted(w.accountNumber) ? '****' : maskAccountNumber(w.accountNumber);
        dirty = true;
      }
      if (!w.bankNameDisplay && w.bankName) {
        // bankName is now encrypted — display copy lost for legacy records; store generic label.
        w.bankNameDisplay = isEncrypted(w.bankName) ? null : w.bankName;
        dirty = true;
      }

      if (dirty) changed++;
    }
    if (changed > 0) {
      saveDB(db);
      logger.info(`[startup] Migrated PII fields for ${changed} legacy withdrawal(s)`);
    }
  } catch (e) {
    logger.warn('[startup] Withdrawal PII migration failed — non-fatal', { error: e.message });
  }
});

// ── Startup: migrate legacy employerEmployees records that used userId instead of workerId ──
// H-3: add-employee always wrote workerId, but two read paths mistakenly used ee.userId.
// Any records written during that window are corrected here.
setImmediate(() => {
  try {
    const db = loadDB();
    let migrated = 0;
    for (const ee of (db.employerEmployees || [])) {
      if (ee.userId && !ee.workerId) {
        ee.workerId = ee.userId;
        delete ee.userId;
        migrated++;
      }
    }
    if (migrated > 0) {
      saveDB(db);
      logger.info(`[startup] Migrated ${migrated} employerEmployee record(s): userId → workerId`);
    }
  } catch (e) {
    logger.warn('[startup] employerEmployee migration failed — non-fatal', { error: e.message });
  }
});

// ── Startup: migrate legacy plaintext refresh tokens to hashed format ─────────
// S-new-7: Records written before S-2 may still carry a raw `token` field.
// Hash them, strip the plaintext, and save once so subsequent loads are clean.
setImmediate(() => {
  try {
    const db = loadDB();
    let migrated = 0;
    db.refreshTokens = (db.refreshTokens || []).map(r => {
      if (!r.token) return r;
      const hash = r.tokenHash || hashToken(r.token);
      migrated++;
      return { tokenHash: hash, userId: r.userId, createdAt: r.createdAt || Date.now() };
    });
    if (migrated > 0) {
      saveDB(db);
      logger.info(`[startup] Migrated ${migrated} legacy refresh token(s) to hashed format`);
    }
  } catch (e) {
    logger.warn('[startup] Refresh token migration failed — non-fatal', { error: e.message });
  }
});

// ── Startup reconciliation sweep ──────────────────────────────────────────────
// After the server is ready, scan for any withdrawals stuck in 'processing' from a
// previous process crash and resume them in a safe, idempotent way.
setImmediate(async () => {
  try {
    const db = loadDB();

    // Purge expired advisory payout locks left by a previous crash (TTL-based release).
    if (db.payoutLocks && db.payoutLocks.length > 0) {
      const before = db.payoutLocks.length;
      db.payoutLocks = db.payoutLocks.filter(l => l.expiresAt > Date.now());
      if (db.payoutLocks.length < before) {
        try { saveDB(db); } catch (_) { /* non-fatal */ }
        logger.info(`[startup] Purged ${before - db.payoutLocks.length} expired payout lock(s)`);
      }
    }

    const stuckWithdrawals = (db.withdrawals || []).filter(w => w.status === 'processing');
    if (stuckWithdrawals.length === 0) return;

    logger.warn(`[startup] Found ${stuckWithdrawals.length} processing withdrawal(s) — scanning for stuck payouts`);

    for (const w of stuckWithdrawals) {
      if (!w.payoutDispatchRef) {
        // No HTTP call was made before the crash — safe to re-run executePayout from scratch.
        logger.warn('[startup] Resuming withdrawal — no dispatch attempted, re-running payout engine', {
          id: w.id, payoutAttempts: w.payoutAttempts,
        });
        setImmediate(() => executePayout(w.id, loadDB, saveDB, logger, withBalanceMutex));

      } else if (!w.payoutReference) {
        // payoutDispatchRef is set (HTTP call was initiated) but no provider reference returned.
        // Outcome is unknown — could be: timeout after acceptance, or rejection before acceptance.
        // Cannot safely refund or retry without querying the provider. Flag for manual reconciliation.
        logger.error('[startup] Withdrawal needs manual reconciliation — dispatch was initiated but outcome unknown', {
          id: w.id,
          payoutDispatchRef: w.payoutDispatchRef,
          payoutAttempts:    w.payoutAttempts,
          hint: `POST /admin/withdrawals/${w.id}/reconcile`,
        });

      } else {
        // Provider accepted (payoutReference saved) but payout not yet settled (e.g. Stripe in_transit).
        // The reconcile endpoint or a Stripe/Kora webhook must complete this when the provider settles.
        logger.warn('[startup] Withdrawal awaiting provider settlement — use reconcile endpoint or wait for webhook', {
          id:             w.id,
          payoutReference: w.payoutReference,
          payoutProvider:  w.payoutProvider,
          hint: `POST /admin/withdrawals/${w.id}/reconcile`,
        });
      }
    }
  } catch (sweepErr) {
    logger.error('[startup] Reconciliation sweep failed', { error: sweepErr.message });
  }
});

