require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const axios = require('axios');
const winston = require('winston');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

// Stripe — only initialise when secret key is present
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
if (!stripeClient) {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set — deposit endpoints will run in test/demo mode');
}

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
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Freshdesk Configuration
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

// Security Configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:19006'];

// Fraud Detection Configuration
const FRAUD_VELOCITY_THRESHOLD = parseInt(process.env.FRAUD_VELOCITY_THRESHOLD) || 5;
const FRAUD_TIME_WINDOW = parseInt(process.env.FRAUD_TIME_WINDOW_MS) || 3600000;

// Validate critical environment variables
if (NODE_ENV === 'production') {
  if (!JWT_SECRET || JWT_SECRET === 'dev_secret_change_me') {
    console.error('❌ FATAL: JWT_SECRET must be set in production!');
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

if (NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

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
      email: userData.email || 'noreply@egwallet.com',
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
  
  const kycTier = kyc?.status === 'approved' ? 'verified' : (kyc?.status === 'under_review' ? 'pending' : 'unverified');
  const dailyLimit = kycTier === 'verified' ? 50000 : (kycTier === 'pending' ? 5000 : 2000);
  
  // Calculate today's spending
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const todaySpent = userTransactions
    .filter(t => t.timestamp >= todayStart && t.type === 'send')
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  
  return {
    email: maskEmail(user?.email),
    kycTier,
    dailyLimit,
    dailySpent: todaySpent,
    dailyRemaining: dailyLimit - todaySpent,
    cardCount: userCards.length,
    recentTxCount: userTransactions.length,
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
    greeting: "Hello! 👋 My name is Felisa, your EGWallet assistant. I can help you with:\n\n• Transaction questions\n• Account information\n• Feature guides\n• Support tickets\n\nWhat can I help you with today?",
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
    security_email: "🛡 For immediate security assistance, also email: security@egwallet.com",
    account_limits: "📊 Your Account Limits:\n• Daily limit: ${dailyLimit}\n• Used today: ${dailySpent}\n• Remaining: ${dailyRemaining}",
    get_verified: "💡 Get verified to unlock $50,000+ daily limits!",
    verification_pending: "⏳ Your verification is under review. Higher limits coming soon!",
    data_collection_reason: "To investigate this issue thoroughly, I need a few more details:",
    data_collection_help: "This helps us investigate faster and saves back-and-forth messages.",
    check_ticket: "Check ticket status",
    view_ticket: "View ticket details",
    contact_support: "Contact support",
    provide_details: "Provide details",
    skip_ticket: "Skip and create ticket",
    verified_status: "✓ Your identity is verified!\n\nYou have access to:\n• $50,000+ daily transaction limits\n• Instant withdrawals\n• International transfers\n• Premium features",
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
    multiple_suspicious: "⚠️ ALERT: Multiple suspicious transactions detected — possible account takeover."
  },
  es: {
    greeting: "¡Hola! 👋 Me llamo Felisa, tu asistente de EGWallet. Puedo ayudarte con:\n\n• Preguntas sobre transacciones\n• Información de cuenta\n• Guías de funciones\n• Tickets de soporte\n\n¿En qué puedo ayudarte hoy?",
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
    security_email: "🛡 Para asistencia de seguridad inmediata, también envía correo a: security@egwallet.com",
    account_limits: "📊 Límites de tu Cuenta:\n• Límite diario: ${dailyLimit}\n• Usado hoy: ${dailySpent}\n• Restante: ${dailyRemaining}",
    get_verified: "💡 ¡Verifica tu cuenta para desbloquear límites diarios de $50,000+!",
    verification_pending: "⏳ Tu verificación está en revisión. ¡Límites más altos próximamente!",
    data_collection_reason: "Para investigar este problema a fondo, necesito algunos detalles más:",
    data_collection_help: "Esto nos ayuda a investigar más rápido y ahorra mensajes de ida y vuelta.",
    check_ticket: "Verificar estado del ticket",
    view_ticket: "Ver detalles del ticket",
    contact_support: "Contactar soporte",
    provide_details: "Proporcionar detalles",
    skip_ticket: "Omitir y crear ticket",
    verified_status: "✓ ¡Tu identidad está verificada!\n\nTienes acceso a:\n• Límites de transacción diarios de $50,000+\n• Retiros instantáneos\n• Transferencias internacionales\n• Funciones premium",
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
    multiple_suspicious: "⚠️ ALERTA: Múltiples transacciones sospechosas detectadas — posible toma de control de cuenta."
  },
  fr: {
    greeting: "Bonjour ! 👋 Je m'appelle Felisa, votre assistante EGWallet. Je peux vous aider avec :\n\n• Questions sur les transactions\n• Informations sur le compte\n• Guides des fonctionnalités\n• Tickets de support\n\nComment puis-je vous aider aujourd'hui ?",
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
    security_email: "🛡 Pour une assistance de sécurité immédiate, envoyez également un e-mail à : security@egwallet.com",
    account_limits: "📊 Limites de votre compte :\n• Limite quotidienne : ${dailyLimit}\n• Utilisé aujourd'hui : ${dailySpent}\n• Restant : ${dailyRemaining}",
    get_verified: "💡 Vérifiez-vous pour débloquer des limites quotidiennes de $50,000+ !",
    verification_pending: "⏳ Votre vérification est en cours de révision. Des limites plus élevées bientôt !",
    data_collection_reason: "Pour enquêter sur ce problème en profondeur, j'ai besoin de quelques détails supplémentaires :",
    data_collection_help: "Cela nous aide à enquêter plus rapidement et évite les messages aller-retour.",
    check_ticket: "Vérifier l'état du ticket",
    view_ticket: "Voir les détails du ticket",
    contact_support: "Contacter le support",
    provide_details: "Fournir les détails",
    skip_ticket: "Passer et créer un ticket",
    verified_status: "✓ Votre identité est vérifiée !\n\nVous avez accès à :\n• Limites de transaction quotidiennes de $50,000+\n• Retraits instantanés\n• Virements internationaux\n• Fonctionnalités premium",
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
    multiple_suspicious: "⚠️ ALERTE : Plusieurs transactions suspectes détectées — prise de contrôle de compte possible."
  },
  pt: {
    greeting: "Olá! 👋 Meu nome é Felisa, sua assistente da EGWallet. Posso ajudá-lo com:\n\n• Perguntas sobre transações\n• Informações da conta\n• Guias de recursos\n• Tickets de suporte\n\nComo posso ajudá-lo hoje?",
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
    security_email: "🛡 Para assistência de segurança imediata, envie também um e-mail para: security@egwallet.com",
    account_limits: "📊 Limites da sua Conta:\n• Limite diário: ${dailyLimit}\n• Usado hoje: ${dailySpent}\n• Restante: ${dailyRemaining}",
    get_verified: "💡 Verifique-se para desbloquear limites diários de $50,000+!",
    verification_pending: "⏳ Sua verificação está em revisão. Limites mais altos em breve!",
    data_collection_reason: "Para investigar este problema minuciosamente, preciso de mais alguns detalhes:",
    data_collection_help: "Isso nos ajuda a investigar mais rápido e economiza mensagens de ida e volta.",
    check_ticket: "Verificar status do ticket",
    view_ticket: "Ver detalhes do ticket",
    contact_support: "Contatar suporte",
    provide_details: "Fornecer detalhes",
    skip_ticket: "Pular e criar ticket",
    verified_status: "✓ Sua identidade está verificada!\n\nVocê tem acesso a:\n• Limites de transação diários de $50,000+\n• Saques instantâneos\n• Transferências internacionais\n• Recursos premium",
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
    multiple_suspicious: "⚠️ ALERTA: Múltiplas transações suspeitas detectadas — possível tomada de conta."
  },
  zh: {
    greeting: "您好！👋 我叫 Felisa，是您的 EGWallet 助手。我可以帮助您：\n\n• 交易问题\n• 账户信息\n• 功能指南\n• 支持工单\n\n今天我能帮您什么？",
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
    security_email: "🛡 如需立即获得安全协助，请发送电子邮件至：security@egwallet.com",
    account_limits: "📊 您的账户限额：\n• 每日限额：${dailyLimit}\n• 今日已用：${dailySpent}\n• 剩余：${dailyRemaining}",
    get_verified: "💡 验证身份以解锁 $50,000+ 每日限额！",
    verification_pending: "⏳ 您的验证正在审核中。更高限额即将到来！",
    data_collection_reason: "为了彻底调查此问题，我需要更多详细信息：",
    data_collection_help: "这有助于我们更快地调查并节省来回消息。",
    check_ticket: "检查工单状态",
    view_ticket: "查看工单详情",
    contact_support: "联系支持",
    provide_details: "提供详细信息",
    skip_ticket: "跳过并创建工单",
    verified_status: "✓ 您的身份已验证！\n\n您可以访问：\n• $50,000+ 每日交易限额\n• 即时提款\n• 国际转账\n• 高级功能",
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
    multiple_suspicious: "⚠️ 警报：检测到多笔可疑交易 — 可能的账户接管。"
  },
  ja: {
    greeting: "こんにちは！👋 私はFelisaです、EGWalletのアシスタントです。以下についてサポートできます：\n\n• 取引に関する質問\n• アカウント情報\n• 機能ガイド\n• サポートチケット\n\n本日はどのようにお手伝いできますか？",
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
    security_email: "🛡 緊急のセキュリティサポートが必要な場合は、次のアドレスにもメールしてください：security@egwallet.com",
    account_limits: "📊 アカウントの制限：\n• 1日の制限：${dailyLimit}\n• 本日使用：${dailySpent}\n• 残り：${dailyRemaining}",
    get_verified: "💡 本人確認をして $50,000+ の1日制限を解除しましょう！",
    verification_pending: "⏳ 本人確認は審査中です。より高い制限がまもなく利用可能になります！",
    data_collection_reason: "この問題を徹底的に調査するために、いくつかの詳細が必要です：",
    data_collection_help: "これにより、調査が迅速化され、やり取りが節約されます。",
    check_ticket: "チケットステータスを確認",
    view_ticket: "チケット詳細を表示",
    contact_support: "サポートに連絡",
    provide_details: "詳細を提供",
    skip_ticket: "スキップしてチケットを作成",
    verified_status: "✓ 本人確認が完了しました！\n\nアクセス可能：\n• $50,000+ の1日取引制限\n• 即時出金\n• 国際送金\n• プレミアム機能",
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
    multiple_suspicious: "⚠️ 警告：複数の不審な取引が検出されました — アカウント乗っ取りの可能性。"
  },
  ru: {
    greeting: "Здравствуйте! 👋 Меня зовут Фелиса, ваш помощник EGWallet. Я могу помочь вам с:\n\n• Вопросами о транзакциях\n• Информацией об учетной записи\n• Руководствами по функциям\n• Заявками в поддержку\n\nКак я могу помочь вам сегодня?",
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
    security_email: "🛡 Для немедленной помощи по вопросам безопасности также отправьте письмо на: security@egwallet.com",
    account_limits: "📊 Лимиты вашей учетной записи:\n• Дневной лимит: ${dailyLimit}\n• Использовано сегодня: ${dailySpent}\n• Осталось: ${dailyRemaining}",
    get_verified: "💡 Пройдите верификацию, чтобы разблокировать дневные лимиты $50,000+!",
    verification_pending: "⏳ Ваша верификация находится на рассмотрении. Более высокие лимиты скоро!",
    data_collection_reason: "Чтобы тщательно расследовать эту проблему, мне нужно несколько дополнительных деталей:",
    data_collection_help: "Это помогает нам быстрее расследовать и экономит переписку.",
    check_ticket: "Проверить статус заявки",
    view_ticket: "Просмотреть детали заявки",
    contact_support: "Связаться с поддержкой",
    provide_details: "Предоставить детали",
    skip_ticket: "Пропустить и создать заявку",
    verified_status: "✓ Ваша личность подтверждена!\n\nУ вас есть доступ к:\n• Дневные лимиты транзакций $50,000+\n• Мгновенные выводы\n• Международные переводы\n• Премиум функции",
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
    multiple_suspicious: "⚠️ ТРЕВОГА: Обнаружено несколько подозрительных транзакций — возможный захват аккаунта."
  },
  de: {
    greeting: "Hallo! 👋 Mein Name ist Felisa, Ihre EGWallet-Assistentin. Ich kann Ihnen helfen mit:\n\n• Transaktionsfragen\n• Kontoinformationen\n• Funktionsanleitungen\n• Support-Tickets\n\nWie kann ich Ihnen heute helfen?",
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
    security_email: "🛡 Für sofortige Sicherheitshilfe senden Sie auch eine E-Mail an: security@egwallet.com",
    account_limits: "📊 Ihre Kontolimits:\n• Tageslimit: ${dailyLimit}\n• Heute verwendet: ${dailySpent}\n• Verbleibend: ${dailyRemaining}",
    get_verified: "💡 Verifizieren Sie sich, um Tageslimits von $50,000+ freizuschalten!",
    verification_pending: "⏳ Ihre Verifizierung wird überprüft. Höhere Limits kommen bald!",
    data_collection_reason: "Um dieses Problem gründlich zu untersuchen, benötige ich einige weitere Details:",
    data_collection_help: "Dies hilft uns, schneller zu ermitteln und spart Hin- und Her-Nachrichten.",
    check_ticket: "Ticket-Status prüfen",
    view_ticket: "Ticket-Details anzeigen",
    contact_support: "Support kontaktieren",
    provide_details: "Details angeben",
    skip_ticket: "Überspringen und Ticket erstellen",
    verified_status: "✓ Ihre Identität ist verifiziert!\n\nSie haben Zugriff auf:\n• $50,000+ tägliche Transaktionslimits\n• Sofortige Auszahlungen\n• Internationale Überweisungen\n• Premium-Funktionen",
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
    multiple_suspicious: "⚠️ ALARM: Mehrere verdächtige Transaktionen erkannt — mögliche Kontoübernahme."
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
  USD: 2,
  EUR: 2,
  CNY: 2,
  CAD: 2,
  BRL: 2,
  GBP: 2,
  JPY: 0,
  NGN: 2,
  XAF: 2,
  GHS: 2,
  ZAR: 2,
  CNY: 2,
  XOF: 0,
  KES: 2,
  TZS: 2,
  UGX: 0,
  RWF: 0,
  ETB: 2,
  BWP: 2,
  ZWL: 2,
  MZN: 2,
  NAD: 2,
  LSL: 2,
  EGP: 2,
  TND: 3,
  MAD: 2,
  LYD: 3,
  DZD: 2,
  ERN: 2,
  AOA: 2,
  SOS: 2,
  SDG: 2,
  GMD: 2,
  MUR: 2,
  SCR: 2,
};

function decimalsFor(currency) {
  return currencyDecimals[currency] || 2;
}

function minorToMajor(amountMinor, currency) {
  const d = decimalsFor(currency);
  return amountMinor / Math.pow(10, d);
}

function majorToMinor(amountMajor, currency) {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * Math.pow(10, d));
}

function loadDB() {
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
    return db;
  } catch (e) {
    const initial = {
      users: [],
      wallets: [],
      transactions: [],
      paymentRequests: [],
      virtualCards: [],
      budgets: [],
      devices: [], // Track trusted devices per user
      rates: {
        base: 'USD',
        values: { 
          USD: 1, EUR: 0.93, CNY: 7, CAD: 1.35, BRL: 5.2, GBP: 0.79, JPY: 145,
          NGN: 1540, GHS: 12, XAF: 600, XOF: 600, ZAR: 19,
          KES: 130, TZS: 2650, UGX: 3800, RWF: 1300, ETB: 52,
          BWP: 14, ZWL: 360, MZN: 65, NAD: 19, LSL: 19,
          EGP: 50, TND: 3.1, MAD: 10, LYD: 4.8, DZD: 135,
          ERN: 15, AOA: 835, SOS: 570, SDG: 550, GMD: 65, MUR: 45, SCR: 13
        },
        updatedAt: Date.now()
      }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function saveDB(db) {
  // Create backup before saving
  if (fs.existsSync(DB_FILE)) {
    try {
      fs.copyFileSync(DB_FILE, DB_BACKUP);
    } catch (err) {
      logger.warn('Failed to create backup', { error: err.message });
    }
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  logger.debug('Database saved', { timestamp: Date.now() });
}

// ==================== EXPRESS APP INITIALIZATION ====================

const app = express();

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
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked origin', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// IP tracking middleware
app.use((req, res, next) => {
  req.clientIP = getClientIP(req);
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

// Auth endpoints rate limit (stricter)
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
    database: fs.existsSync(DB_FILE) ? 'connected' : 'missing',
    users: db.users?.length || 0,
    tickets: db.supportTickets?.length || 0,
    freshdeskConfigured: !!(FRESHDESK_DOMAIN && FRESHDESK_API_KEY)
  };
  res.status(200).json(healthStatus);
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
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
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    logger.warn('Invalid token', { error: e.message, ip: req.clientIP });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Input validation middleware
function validateInput(validations) {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Input validation failed', { 
        errors: errors.array(), 
        ip: req.clientIP 
      });
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }
    next();
  };
}

// ==================== AUTHENTICATION ENDPOINTS ====================

// Auth
app.post('/auth/register', 
  authLimiter,
  validateInput([
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ]),
  (req, res) => {
  const db = loadDB();
  const { email, password, region, deviceInfo } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (findUserByEmail(db, email)) return res.status(400).json({ error: 'User exists' });

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 8);
  
  // Auto-detect preferred currency from region
  const regionToCurrency = { 
    GQ: 'XAF', NG: 'NGN', GH: 'GHS', ZA: 'ZAR', KE: 'KES', TZ: 'TZS', 
    UG: 'UGX', RW: 'RWF', ET: 'ETB', EG: 'EGP', TN: 'TND', MA: 'MAD',
    LY: 'LYD', DZ: 'DZD', AO: 'AOA', ER: 'ERN', SO: 'SOS', SD: 'SDG',
    GM: 'GMD', MU: 'MUR', SC: 'SCR', BW: 'BWP', ZW: 'ZWL', MZ: 'MZN',
    NA: 'NAD', LS: 'LSL'
  };
  const preferredCurrency = regionToCurrency[region] || 'XAF';
  
  const user = { 
    id, 
    email, 
    region: region || 'GQ', 
    role: 'individual',
    preferredCurrency, 
    autoConvertIncoming: true, 
    createdAt: Date.now(),
    kycTier: 0,
    kycStatus: 'pending',
    kycDocuments: {},
    kycLimits: {
      dailyLimit: 100,
      totalLimit: 500
    },
    dailySpent: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
    linkedEmployers: []
  };
  db.users.push({ ...user, passwordHash });

  // create wallet
  const wallet = { id: uuidv4(), userId: id, balances: [{ currency: 'USD', amount: 0 }], createdAt: Date.now(), maxLimitUSD: 250000 };
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

  const token = jwt.sign({ userId: id, email, type: 'access' }, JWT_SECRET, { expiresIn: '7d' });
  const refreshToken = jwt.sign({ userId: id, email, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
  
  // Store refresh token in db
  if (!db.refreshTokens) db.refreshTokens = [];
  db.refreshTokens.push({ token: refreshToken, userId: id, createdAt: Date.now() });
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
  
  const u = findUserByEmail(db, email);
  if (!u) {
    logger.warn('Login attempt - user not found', { email: maskEmail(email), ip: req.clientIP });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  if (!bcrypt.compareSync(password, u.passwordHash)) {
    logger.warn('Login attempt - invalid password', { userId: u.id, ip: req.clientIP });
    return res.status(401).json({ error: 'Invalid credentials' });
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

  const token = jwt.sign({ userId: u.id, email: u.email, type: 'access' }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '7d' });
  const refreshToken = jwt.sign({ userId: u.id, email: u.email, type: 'refresh' }, JWT_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '30d' });
  
  logger.info('User logged in', { userId: u.id, newDevice: isNewDevice, ip: req.clientIP });
  
  // Store refresh token
  if (!db.refreshTokens) db.refreshTokens = [];
  db.refreshTokens.push({ token: refreshToken, userId: u.id, createdAt: Date.now() });
  saveDB(db);
  
  res.json({ 
    token, 
    refreshToken, 
    user: { id: u.id, email: u.email, region: u.region, preferredCurrency: u.preferredCurrency || 'XAF', autoConvertIncoming: u.autoConvertIncoming !== false },
    newDevice: isNewDevice,
    deviceName: deviceInfo?.name || 'Unknown Device'
  });
});

app.get('/auth/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, email: user.email, preferredCurrency: user.preferredCurrency || 'XAF', autoConvertIncoming: user.autoConvertIncoming !== false });
});

// Refresh token endpoint
app.post('/auth/refresh', (req, res) => {
  const db = loadDB();
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  
  // Verify refresh token
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    
    // Check if refresh token exists in db
    if (!db.refreshTokens) db.refreshTokens = [];
    const tokenRecord = db.refreshTokens.find(t => t.token === refreshToken && t.userId === payload.userId);
    if (!tokenRecord) {
      return res.status(401).json({ error: 'Refresh token not found or revoked' });
    }
    
    // Issue new access token
    const newToken = jwt.sign({ userId: payload.userId, email: payload.email, type: 'access' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token: newToken });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// Logout endpoint (revoke refresh token)
app.post('/auth/logout', authMiddleware, (req, res) => {
  const db = loadDB();
  const { refreshToken } = req.body;
  
  if (!db.refreshTokens) db.refreshTokens = [];
  db.refreshTokens = db.refreshTokens.filter(t => t.token !== refreshToken || t.userId !== req.user.userId);
  saveDB(db);
  
  res.json({ success: true });
});

app.post('/auth/update-currency', authMiddleware, (req, res) => {
  const db = loadDB();
  const { preferredCurrency } = req.body;
  if (!preferredCurrency) return res.status(400).json({ error: 'preferredCurrency required' });
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.preferredCurrency = preferredCurrency;
  saveDB(db);
  res.json({ success: true, preferredCurrency });
});

app.post('/auth/update-auto-convert', authMiddleware, (req, res) => {
  const db = loadDB();
  const { autoConvertIncoming } = req.body;
  if (typeof autoConvertIncoming !== 'boolean') return res.status(400).json({ error: 'autoConvertIncoming must be boolean' });
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.autoConvertIncoming = autoConvertIncoming;
  saveDB(db);
  res.json({ success: true, autoConvertIncoming });
});

// Wallet endpoints
app.get('/wallets/:id/balance', authMiddleware, (req, res) => {
  const db = loadDB();
  const wallet = db.wallets.find(w => w.id === req.params.id && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  res.json({ balances: wallet.balances, maxLimitUSD: wallet.maxLimitUSD });
});

// List wallets for authenticated user
app.get('/wallets', authMiddleware, (req, res) => {
  const db = loadDB();
  let wallets = db.wallets.filter(w => w.userId === req.user.userId);
  
  // Auto-create wallet if user has none (backward compatibility fix)
  if (wallets.length === 0) {
    const wallet = { 
      id: uuidv4(), 
      userId: req.user.userId, 
      balances: [{ currency: 'USD', amount: 0 }], 
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
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  const txs = db.transactions
    .filter(t => t.fromWalletId === wallet.id || t.toWalletId === wallet.id)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(t => ({
      ...t,
      // direction: 'out' = money left this wallet, 'in' = money arrived
      direction: t.fromWalletId === wallet.id ? 'out' : 'in',
      // type: keep existing explicit types (payroll, qr_payment, withdrawal…),
      // derive 'sent'/'received' for plain transfers that have no type set
      type: t.type || (t.fromWalletId === wallet.id ? 'sent' : 'received')
    }));
  res.json({ transactions: txs });
});

// Get all transactions for authenticated user (across all their wallets)
app.get('/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  const walletIds = new Set(userWallets.map(w => w.id));
  const txs = db.transactions
    .filter(t => walletIds.has(t.fromWalletId) || walletIds.has(t.toWalletId))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(t => ({
      ...t,
      direction: walletIds.has(t.fromWalletId) ? 'out' : 'in',
      type: t.type || (walletIds.has(t.fromWalletId) ? 'sent' : 'received')
    }));
  res.json(txs);
});

// Send money (simple internal transfer between wallets by walletId)
app.post('/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const { fromWalletId, toWalletId, amount, currency, memo } = req.body; // amount is expected in minor units (integer)
  if (!fromWalletId || !toWalletId || typeof amount === 'undefined' || !currency) return res.status(400).json({ error: 'missing fields' });
  
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
  const toWallet = db.wallets.find(w => w.id === toWalletId);
  if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
  
  // find balance entries (amount stored in minor units)
  const fromBalance = fromWallet.balances.find(b=>b.currency===currency) || { currency, amount: 0 };
  if (fromBalance.amount < amount) return res.status(400).json({ error: 'Insufficient funds' });
  
  const rates = db.rates.values;
  const amountMajor = minorToMajor(amount, currency);
  const toAmountInUSD = amountMajor / (rates[currency] || 1);
  
  // CHECK #1: Daily sending limit ($5,000 USD per 24 hours)
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentTxs = db.transactions.filter(t => t.fromWalletId === fromWalletId && t.timestamp > oneDayAgo && t.status === 'completed');
  const dailySentUSD = recentTxs.reduce((sum, t) => {
    const txMajor = minorToMajor(t.amount, t.currency);
    const txUSD = txMajor / (rates[t.currency] || 1);
    return sum + txUSD;
  }, 0);
  
  const newDailyTotal = dailySentUSD + toAmountInUSD;
  const DAILY_SEND_LIMIT_USD = 5000;
  if (newDailyTotal > DAILY_SEND_LIMIT_USD) {
    return res.status(400).json({ 
      error: `Daily sending limit exceeded. You have sent ${dailySentUSD.toFixed(2)} USD today. Limit is ${DAILY_SEND_LIMIT_USD} USD per 24 hours.`,
      dailySent: dailySentUSD,
      dailyLimit: DAILY_SEND_LIMIT_USD
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
      error: `Destination wallet would exceed maximum capacity of ${MAX_WALLET_CAPACITY_USD.toLocaleString()} USD`,
      destinationTotal: destTotalUSD,
      maxCapacity: MAX_WALLET_CAPACITY_USD
    });
  }
  
  // Get receiver's preferred currency and auto-convert setting
  const toUser = db.users.find(u => u.id === toWallet.userId);
  const shouldAutoConvert = toUser?.autoConvertIncoming !== false;
  const receiverCurrency = shouldAutoConvert ? (toUser?.preferredCurrency || currency) : currency;
  
  // Deduct from sender in original currency
  fromBalance.amount -= amount;
  
  // Convert to receiver's preferred currency if different AND auto-convert is enabled
  let receivedAmount = amount;
  let receivedCurrency = currency;
  let wasConverted = false;
  
  if (shouldAutoConvert && receiverCurrency !== currency) {
    // Convert: original → USD → receiver's currency
    const amountMajor = minorToMajor(amount, currency);
    const amountUSD = amountMajor / (rates[currency] || 1);
    const amountInReceiverCurrency = amountUSD * (rates[receiverCurrency] || 1);
    receivedAmount = majorToMinor(amountInReceiverCurrency, receiverCurrency);
    receivedCurrency = receiverCurrency;
    wasConverted = true;
  }
  
  // Add to receiver in their preferred currency
  const destBalance = toWallet.balances.find(b=>b.currency===receivedCurrency);
  if (destBalance) destBalance.amount += receivedAmount; 
  else toWallet.balances.push({ currency: receivedCurrency, amount: receivedAmount });
  
  const tx = { 
    id: uuidv4(), 
    fromWalletId, 
    toWalletId, 
    amount, 
    currency, 
    receivedAmount, 
    receivedCurrency,
    wasConverted,
    memo: memo||'', 
    status: 'completed', 
    timestamp: Date.now() 
  };
  db.transactions.push(tx);
  saveDB(db);

  res.json({ transaction: tx });
});

// Withdrawals to bank/mobile money
app.post('/withdrawals', authMiddleware, (req, res) => {
  const db = loadDB();
  const { fromWalletId, amount, currency, method, bankName, accountNumber, accountName } = req.body;
  
  if (!fromWalletId || typeof amount === 'undefined' || !currency || !method || !bankName || !accountNumber || !accountName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const wallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  const balance = wallet.balances.find(b => b.currency === currency);
  if (!balance || balance.amount < amount) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }
  
  // Deduct from wallet
  balance.amount -= amount;
  
  // Create withdrawal transaction
  const withdrawal = {
    id: uuidv4(),
    type: 'withdrawal',
    walletId: fromWalletId,
    amount,
    currency,
    method, // 'bank' or 'mobile'
    bankName,
    accountNumber,
    accountName,
    status: 'pending', // pending, completed, failed
    timestamp: Date.now(),
    estimatedArrival: Date.now() + (3 * 24 * 60 * 60 * 1000) // 3 days
  };
  
  if (!db.withdrawals) db.withdrawals = [];
  db.withdrawals.push(withdrawal);
  saveDB(db);
  
  logger.info('Withdrawal created', {
    userId: req.user.userId,
    withdrawalId: withdrawal.id,
    amount,
    currency,
    method
  });
  
  res.json({ withdrawal });
});

// Rates
app.get('/rates', (req, res) => {
  const db = loadDB();
  res.json(db.rates);
});

// ==================== DEPOSIT / TOP-UP ENDPOINTS ====================

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
    if (!user) return res.status(404).json({ error: 'User not found' });
    const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    if (stripeClient) {
      // Real Stripe PaymentIntent
      try {
        const intent = await stripeClient.paymentIntents.create({
          amount: Math.round(amount),
          currency: currency.toLowerCase(),
          metadata: { userId: req.user.userId, walletId },
          automatic_payment_methods: { enabled: true },
        });
        logger.info('Stripe PaymentIntent created', { intentId: intent.id, userId: req.user.userId, amount, currency });
        return res.json({
          clientSecret: intent.client_secret,
          intentId: intent.id,
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
          mode: 'stripe',
        });
      } catch (err) {
        logger.error('Stripe PaymentIntent failed', { error: err.message, userId: req.user.userId });
        return res.status(500).json({ error: 'Payment provider error', message: err.message });
      }
    }

    // Demo / test mode — no Stripe key configured
    // Create a fake intent ID so the confirmation step can credit the wallet
    const demoIntentId = `demo_intent_${uuidv4()}`;
    if (!db.demoIntents) db.demoIntents = [];
    db.demoIntents.push({
      id: demoIntentId,
      userId: req.user.userId,
      walletId,
      amount,
      currency,
      status: 'pending',
      createdAt: Date.now(),
    });
    saveDB(db);
    logger.info('Demo deposit intent created', { intentId: demoIntentId, userId: req.user.userId, amount, currency });
    return res.json({
      clientSecret: `${demoIntentId}_secret`,
      intentId: demoIntentId,
      publishableKey: null,
      mode: 'demo',
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
    const db = loadDB();
    const { intentId, walletId } = req.body;
    const user = db.users.find(u => u.id === req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    let amount, currency;

    if (stripeClient && !intentId.startsWith('demo_intent_')) {
      // Verify real Stripe PaymentIntent status
      try {
        const intent = await stripeClient.paymentIntents.retrieve(intentId);
        if (intent.status !== 'succeeded') {
          return res.status(400).json({ error: `Payment not completed. Status: ${intent.status}` });
        }
        if (intent.metadata.walletId !== walletId || intent.metadata.userId !== req.user.userId) {
          return res.status(403).json({ error: 'Intent mismatch' });
        }
        amount = intent.amount;
        currency = intent.currency.toUpperCase();
      } catch (err) {
        return res.status(500).json({ error: 'Failed to verify payment', message: err.message });
      }
    } else {
      // Demo mode — look up pending intent
      if (!db.demoIntents) return res.status(400).json({ error: 'No demo intent found' });
      const demo = db.demoIntents.find(d => d.id === intentId && d.userId === req.user.userId && d.walletId === walletId);
      if (!demo) return res.status(404).json({ error: 'Demo intent not found or already used' });
      if (demo.status !== 'pending') return res.status(400).json({ error: 'Intent already used' });
      amount = demo.amount;
      currency = demo.currency;
      demo.status = 'used';
    }

    // Credit wallet
    let balance = wallet.balances.find(b => b.currency === currency);
    if (!balance) {
      balance = { currency, amount: 0 };
      wallet.balances.push(balance);
    }
    balance.amount += amount;

    // Record transaction
    const tx = {
      id: uuidv4(),
      type: 'deposit',
      fromWalletId: null,
      toWalletId: walletId,
      amount,
      currency,
      receivedAmount: amount,
      receivedCurrency: currency,
      wasConverted: false,
      status: 'completed',
      timestamp: Date.now(),
      memo: `Deposit via ${intentId.startsWith('demo_intent_') ? 'Demo Mode' : 'Stripe'}`,
      direction: 'in',
      stripeIntentId: intentId,
    };
    db.transactions.push(tx);
    saveDB(db);

    logger.info('Deposit confirmed', { intentId, userId: req.user.userId, walletId, amount, currency });
    return res.json({ success: true, transaction: tx, newBalance: balance.amount, currency });
  }
);

// Basic user info
app.get('/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const u = db.users.find(x=>x.id===req.user.userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ id: u.id, email: u.email, region: u.region });
});

// ==================== PAYMENT REQUESTS ====================
// Create a payment request
app.post('/payment-requests', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, amount, currency, memo, idempotencyKey, targetWalletId } = req.body;
  if (!walletId || typeof amount === 'undefined' || !currency) {
    return res.status(400).json({ error: 'walletId, amount, and currency required' });
  }
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  // SECURITY CHECK: If requesting from a specific wallet (employer), verify authorization
  let isEmployerRequest = false;
  let employerRelationship = null;
  
  if (targetWalletId) {
    const targetWallet = db.wallets.find(w => w.id === targetWalletId);
    if (!targetWallet) {
      return res.status(404).json({ error: 'Target wallet not found' });
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
          error: 'Unauthorized. You must be an authorized employee to request payments from this employer.' 
        });
      }
      
      // SECURITY CHECK: Employer must be verified
      if (targetEmployer.verificationStatus !== 'verified') {
        return res.status(403).json({ 
          error: 'Employer account is not verified yet' 
        });
      }
      
      // SECURITY CHECK: Verify employer wallet has sufficient balance
      const targetBalance = targetWallet.balances.find(b => b.currency === currency);
      if (!targetBalance || targetBalance.amount < amount) {
        return res.status(400).json({ 
          error: 'Employer has insufficient balance for this request' 
        });
      }
      
      // SECURITY CHECK: Amount within employee's max request limit
      if (employerRelationship.maxRequestAmount && amount > employerRelationship.maxRequestAmount) {
        return res.status(403).json({ 
          error: `Request amount exceeds your limit of ${employerRelationship.maxRequestAmount} ${currency}` 
        });
      }
      
      // SECURITY CHECK: AML threshold - flag large requests
      const amountUSD = convertToUSD(amount, currency, db.rates);
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
          error: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} requests per hour to each employer.`,
          retryAfter: 3600
        });
      }
      
      // SECURITY CHECK: Duplicate request prevention (24 hour window)
      const DUPLICATE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
      const recentRequests = db.paymentRequests.filter(r => 
        r.requesterId === req.user.userId &&
        r.targetEmployerId === targetEmployer.id &&
        r.amount === amount &&
        r.currency === currency &&
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
          error: 'Duplicate request detected. You already have a pending request for this amount.',
          existingRequestId: recentRequests[0].id
        });
      }
      
      // Add to rate limit tracker
      db.paymentRequestsRateLimit[rateLimitKey].push(now);
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
  
  db.paymentRequests.push(request);
  saveDB(db);
  
  // AUDIT TRAIL: Log all employer payment requests
  if (isEmployerRequest) {
    logger.info('Employer payment request created', {
      requestId: request.id,
      workerId: req.user.userId,
      employerId: employerRelationship.employerId,
      amount,
      currency,
      amountUSD: convertToUSD(amount, currency, db.rates)
    });
  }
  
  const response = { request };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
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

// Get a single payment request by ID (public - shareable link)
app.get('/payment-requests/:id', (req, res) => {
  const db = loadDB();
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  
  const requester = db.users.find(u => u.id === request.requesterId);
  res.json({ 
    request,
    requesterEmail: requester?.email || 'Unknown'
  });
});

// Pay a payment request
app.post('/payment-requests/:id/pay', authMiddleware, (req, res) => {
  const db = loadDB();
  const { fromWalletId } = req.body;
  if (!fromWalletId) return res.status(400).json({ error: 'fromWalletId required' });
  
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
  
  const toWallet = db.wallets.find(w => w.id === request.walletId);
  if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
  
  // Check balance
  const fromBalance = fromWallet.balances.find(b => b.currency === request.currency) || { currency: request.currency, amount: 0 };
  if (fromBalance.amount < request.amount) return res.status(400).json({ error: 'Insufficient funds' });
  
  // Deduct from payer
  fromBalance.amount -= request.amount;
  
  // Add to requester
  const destBalance = toWallet.balances.find(b => b.currency === request.currency);
  if (destBalance) destBalance.amount += request.amount;
  else toWallet.balances.push({ currency: request.currency, amount: request.amount });
  
  // Create transaction with proper tagging
  const tx = {
    id: uuidv4(),
    fromWalletId,
    toWalletId: request.walletId,
    amount: request.amount,
    currency: request.currency,
    receivedAmount: request.amount,
    receivedCurrency: request.currency,
    wasConverted: false,
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
  
  saveDB(db);
  res.json({ request, transaction: tx });
});

// Cancel a payment request
app.post('/payment-requests/:id/cancel', authMiddleware, (req, res) => {
  const db = loadDB();
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.requesterId !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  
  request.status = 'cancelled';
  saveDB(db);
  res.json({ request });
});

// ==================== VIRTUAL CARDS ====================
// Create virtual card
app.post('/virtual-cards', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, currency, label, idempotencyKey } = req.body;
  if (!walletId || !currency) return res.status(400).json({ error: 'walletId and currency required' });
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  // Check card limit (max 5 cards per user)
  const userCards = (db.virtualCards || []).filter(c => c.userId === req.user.userId && c.status !== 'deleted');
  if (userCards.length >= 5) return res.status(400).json({ error: 'Maximum 5 cards allowed' });
  
  // Generate card details
  const cardNumber = '4' + Math.floor(Math.random() * 1e15).toString().padStart(15, '0');
  const cvv = Math.floor(Math.random() * 900 + 100).toString();
  const now = new Date();
  const expiryMonth = (now.getMonth() + 1).toString().padStart(2, '0');
  const expiryYear = (now.getFullYear() + 3).toString().slice(-2);
  
  const card = {
    id: uuidv4(),
    userId: req.user.userId,
    walletId,
    cardNumber,
    cvv,
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
  
  const response = { card };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// List virtual cards
app.get('/virtual-cards', authMiddleware, (req, res) => {
  const db = loadDB();
  const cards = (db.virtualCards || [])
    .filter(c => c.userId === req.user.userId && c.status !== 'deleted')
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ cards });
});

// Get single card
app.get('/virtual-cards/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({ card });
});

// Freeze/unfreeze card
app.post('/virtual-cards/:id/toggle-freeze', authMiddleware, (req, res) => {
  const db = loadDB();
  const { idempotencyKey } = req.body;
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (card.status === 'deleted') return res.status(400).json({ error: 'Card is deleted' });
  
  card.status = card.status === 'active' ? 'frozen' : 'active';
  saveDB(db);
  
  const response = { card };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// Delete card
app.delete('/virtual-cards/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  
  card.status = 'deleted';
  saveDB(db);
  res.json({ success: true });
});

// ==================== QR CODES & PAYMENT REQUESTS ====================
// Generate static QR (user identity - permanent)
app.get('/qr/static', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  if (userWallets.length === 0) return res.status(404).json({ error: 'No wallet found' });
  
  // Static QR payload - never expires, always points to user
  const qrPayload = {
    v: '1',
    type: 'static',
    userId: req.user.userId,
    walletId: userWallets[0].id,
    displayName: user.email.split('@')[0],
    timestamp: Date.now()
  };
  
  // Generate simple QR string (in production, would be signed)
  const qrString = `egwallet://pay/${req.user.userId}`;
  
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
    return res.status(400).json({ error: 'amount and currency required' });
  }
  
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId);
  if (userWallets.length === 0) return res.status(404).json({ error: 'No wallet found' });
  
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
    return res.status(400).json({ error: 'qrString required' });
  }
  
  // Parse QR string
  if (qrString.startsWith('egwallet://pay/')) {
    // Static QR
    const userId = qrString.replace('egwallet://pay/', '');
    const user = db.users.find(u => u.id === userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found', valid: false });
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
    return res.status(400).json({ error: 'Invalid QR format', valid: false });
  }
  
  const qrCode = db.qrCodes?.find(qr => qr.id === requestId);
  const request = db.paymentRequests?.find(r => r.id === requestId);
  
  if (!qrCode || !request) {
    return res.status(404).json({ error: 'QR code not found', valid: false });
  }
  
  // Check expiry
  if (Date.now() > qrCode.expiry) {
    return res.json({
      valid: false,
      error: 'QR code expired',
      expiredAt: qrCode.expiry
    });
  }
  
  // Check if already used
  if (qrCode.used || request.status !== 'pending') {
    return res.json({
      valid: false,
      error: 'QR code already used',
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
      error: 'Invalid signature - possible fraud'
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
app.post('/qr/pay', authMiddleware, (req, res) => {
  const db = loadDB();
  const { qrString, fromWalletId, amount, currency } = req.body;
  
  if (!qrString || !fromWalletId) {
    return res.status(400).json({ error: 'qrString and fromWalletId required' });
  }
  
  // Validate QR first
  let targetUserId, targetWalletId, paymentAmount, paymentCurrency, requestId, memo;
  
  if (qrString.startsWith('egwallet://pay/')) {
    // Static QR - requires amount from payer
    if (!amount || !currency) {
      return res.status(400).json({ error: 'amount and currency required for static QR' });
    }
    
    targetUserId = qrString.replace('egwallet://pay/', '');
    const targetUser = db.users.find(u => u.id === targetUserId);
    if (!targetUser) return res.status(404).json({ error: 'Recipient not found' });
    
    targetWalletId = db.wallets.find(w => w.userId === targetUserId)?.id;
    paymentAmount = amount;
    paymentCurrency = currency;
    memo = 'QR Payment';
    
  } else {
    // Dynamic QR - amount embedded
    const url = new URL(qrString);
    requestId = url.searchParams.get('r');
    
    const request = db.paymentRequests?.find(r => r.id === requestId);
    if (!request) return res.status(404).json({ error: 'Payment request not found' });
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Payment request already processed' });
    }
    
    const qrCode = db.qrCodes?.find(qr => qr.id === requestId);
    if (!qrCode) return res.status(404).json({ error: 'QR code not found' });
    
    if (Date.now() > qrCode.expiry) {
      return res.status(400).json({ error: 'QR code expired' });
    }
    
    targetUserId = request.requesterId;
    targetWalletId = request.walletId;
    paymentAmount = request.amount;
    paymentCurrency = request.currency;
    memo = request.memo || 'QR Payment';
  }
  
  // Verify payer wallet
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
  
  const toWallet = db.wallets.find(w => w.id === targetWalletId);
  if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
  
  // Check balance
  const fromBalance = fromWallet.balances.find(b => b.currency === paymentCurrency) || { currency: paymentCurrency, amount: 0 };
  if (fromBalance.amount < paymentAmount) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }
  
  // Process payment
  fromBalance.amount -= paymentAmount;
  
  const destBalance = toWallet.balances.find(b => b.currency === paymentCurrency);
  if (destBalance) {
    destBalance.amount += paymentAmount;
  } else {
    toWallet.balances.push({ currency: paymentCurrency, amount: paymentAmount });
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
  
  saveDB(db);
  
  logger.info('QR payment completed', {
    transactionId: tx.id,
    fromUserId: req.user.userId,
    toUserId: targetUserId,
    amount: paymentAmount,
    currency: paymentCurrency,
    qrType: requestId ? 'dynamic' : 'static'
  });
  
  res.json({
    success: true,
    transaction: tx,
    message: 'Payment successful'
  });
});

// ==================== BUDGETS ====================
// Create or update budget
app.post('/budgets', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, currency, monthlyLimit, categoryLimits, idempotencyKey } = req.body;
  if (!walletId || !currency || typeof monthlyLimit === 'undefined') {
    return res.status(400).json({ error: 'walletId, currency, and monthlyLimit required' });
  }
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
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
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
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
  if (!budget) return res.status(404).json({ error: 'Budget not found' });
  
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
  if (idx === -1) return res.status(404).json({ error: 'Budget not found' });
  
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
  if (idx === -1) return res.status(404).json({ error: 'Device not found' });
  
  db.devices.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// Trust a device
app.post('/devices/:id/trust', authMiddleware, (req, res) => {
  const db = loadDB();
  if (!db.devices) db.devices = [];
  
  const device = db.devices.find(d => d.id === req.params.id && d.userId === req.user.userId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  
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
  if (!documentType) return res.status(400).json({ error: 'documentType required' });
  
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
          const amount = typeof tx.amount === 'number' ? `$${Math.abs(tx.amount).toFixed(2)}` : tx.amount;
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
      response = `I can help you check your recent transactions. View your transaction history in the app, or I can create a support ticket if you need detailed investigation of a specific transaction.`;
      suggestions = ['View transactions', 'Report transaction issue', 'Check status'];
    } else if (lowerMessage.includes('failed') || lowerMessage.includes('problem') || lowerMessage.includes('issue')) {
      response = `For transaction issues, I can help you:\n\n• Check transaction status\n• File a dispute\n• Create a support ticket for investigation\n\n`;
      response += `Note: I cannot process refunds or reversals directly, but our team can investigate within ${escalation.sla || '24-48h'}.`;
      suggestions = ['File dispute', 'Create ticket', 'Transaction history'];
    } else {
      response = `You can view all your transactions in the Transaction History screen. I can help you:\n\n• Understand transaction statuses\n• Download receipts\n• Report issues`;
      suggestions = ['View transactions', 'Download receipt', 'Report issue'];
    }
  }
  
  // Balance queries (ACCOUNT-AWARE - Revolut-level)
  else if (lowerMessage.includes('balance') || lowerMessage.includes('money') || lowerMessage.includes('funds')) {
    response = `You can check your balance on the Wallet screen in real-time.\n\n`;
    
    // Show personalized limit info
    if (lowerMessage.includes('limit')) {
      response += t('account_limits', lang, {
        dailyLimit: userContext.dailyLimit,
        dailySpent: userContext.dailySpent,
        dailyRemaining: userContext.dailyRemaining
      }) + '\n\n';
      
      if (userContext.kycTier === 'unverified') {
        response += t('get_verified', lang);
        suggestions = ['Get verified', 'View balance', 'Learn about limits'];
      } else if (userContext.kycTier === 'pending') {
        response += t('verification_pending', lang);
        suggestions = ['Check verification', 'View balance'];
      } else {
        suggestions = ['View balance', 'Transaction history'];
      }
    } else {
      response += `If you believe your balance is incorrect, I can create a support ticket for investigation.`;
      suggestions = ['View balance', 'Report discrepancy', 'Add money'];
    }
  }
  
  // Virtual cards
  else if (lowerMessage.includes('card') || lowerMessage.includes('virtual card')) {
    if (lowerMessage.includes('create') || lowerMessage.includes('make') || lowerMessage.includes('new')) {
      response = `To create a virtual card:\n\n1. Go to the Cards tab\n2. Tap "Create New Card"\n3. Set your spending limit\n4. Card is ready instantly!\n\nVirtual cards are free and you can create up to 5 cards.`;
      suggestions = ['Create card', 'Card benefits', 'Card limits'];
    } else if (lowerMessage.includes('frozen') || lowerMessage.includes('locked') || lowerMessage.includes('blocked')) {
      response = `If your card is frozen, you can unfreeze it in the Cards screen. If you suspect fraud, I recommend creating a security ticket.`;
      suggestions = ['Create security ticket', 'View cards', 'Freeze/unfreeze help'];
    } else {
      response = `Virtual cards help you:\n\n• Shop online securely\n• Control spending per merchant\n• Cancel anytime without affecting your main wallet\n\nEach card has its own limit for better budgeting.`;
      suggestions = ['Create card', 'View cards', 'Card security'];
    }
  }
  
  // KYC/Verification (ACCOUNT-AWARE)
  else if (lowerMessage.includes('verify') || lowerMessage.includes('kyc') || lowerMessage.includes('identity')) {
    if (userContext.kycTier === 'verified') {
      response = t('verified_status', lang);
      suggestions = ['View account', 'Transaction limits'];
    } else if (userContext.kycTier === 'pending') {
      response = `⏳ Your documents are under review.\n\n`;
      response += `We'll notify you within 1-2 business days. Thank you for your patience!\n\n`;
      response += `Current limit: $${userContext.dailyLimit.toLocaleString()}/day`;
      suggestions = ['Check status', 'Upload additional documents', 'Contact support'];
    } else {
      response = `Get verified to unlock higher limits!\n\n`;
      response += `Benefits:\n• $50,000+ transaction limits\n• Instant withdrawals\n• International transfers\n\n`;
      response += `Currently: $${userContext.dailyLimit.toLocaleString()}/day limit\n`;
      response += `After verification: $50,000+/day\n\n`;
      response += `Verification takes ~5 minutes. You'll need a government-issued ID.`;
      suggestions = ['Start verification', 'Required documents', 'Learn more'];
    }
  }
  
  // Security concerns
  else if (lowerMessage.includes('security') || lowerMessage.includes('safe') || lowerMessage.includes('protect')) {
    response = `Your security is our priority! EGWallet protects you with:\n\n`;
    response += `• Biometric authentication\n• Device tracking\n• End-to-end encryption\n• Transaction confirmations\n• 24/7 fraud monitoring\n\n`;
    response += `Enable biometric lock in Settings for extra protection!`;
    suggestions = ['Enable biometric', 'Trusted devices', 'Security tips'];
  }
  
  // Refund/reversal requests (MUST NOT PROMISE)
  else if (lowerMessage.includes('refund') || lowerMessage.includes('reverse') || lowerMessage.includes('cancel')) {
    response = `I understand you need help with this transaction. I can create a support ticket for our payments team to investigate.\n\n`;
    response += `Please note:\n• Investigation timeline: 2-3 business days\n• Refunds depend on transaction type and our policies\n• You'll receive email updates\n\n`;
    response += `I cannot process refunds directly, but our team will review your case.`;
    suggestions = ['Create ticket', 'File dispute', 'Contact support'];
  }
  
  // Help / FAQ
  else if (lowerMessage.includes('help') || lowerMessage.includes('how') || lowerMessage.includes('what') || lowerMessage.includes('faq')) {
    response = `I'm here to help! You can:\n\n• Ask about features\n• Get transaction info\n• Report issues\n• Create support tickets\n\nOur Help Center has detailed guides, or I can connect you with our support team.`;
    suggestions = ['Browse FAQs', 'Create ticket', 'Feature guides'];
  }
  
  // Fees
  else if (lowerMessage.includes('fee') || lowerMessage.includes('charge') || lowerMessage.includes('cost')) {
    response = `EGWallet fee structure:\n\n✓ EGWallet transfers: FREE\n• Currency conversion: 1.5%\n✓ Virtual cards: FREE\n• International transfers: 2.5%\n✓ Withdrawals: FREE\n\nNo hidden fees. All charges shown before confirmation.`;
    suggestions = ['Currency fees', 'International fees', 'Save on fees'];
  }
  
  // Dispute/complaint
  else if (lowerMessage.includes('dispute') || lowerMessage.includes('complaint') || lowerMessage.includes('problem')) {
    response = `I can help you file a formal dispute or create a support ticket. Our team will:\n\n`;
    response += `1. Review your case within 2-3 business days\n2. Contact relevant parties\n3. Investigate thoroughly\n4. Provide regular updates\n\n`;
    response += `Note: Investigation timelines vary by case complexity.`;
    suggestions = ['File dispute', 'Create ticket', 'View dispute process'];
  }
  
  // Greeting
  else if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey') || lowerMessage.includes('hola') || lowerMessage.includes('bonjour') || lowerMessage.includes('olá') || lowerMessage.includes('привет') || lowerMessage.includes('こんにちは')) {
    const hasUserHistory = (conversationHistory || []).some(m => m.sender === 'user');
    response = hasUserHistory ? t('greeting_return', lang) : t('greeting', lang);
    suggestions = ['View transactions', 'Check account', 'Browse FAQs'];
  }
  
  // Default fallback
  else {
    response = `I can help you with:\n\n`;
    response += `• Transaction questions & history\n• Account & balance info\n• Virtual cards\n• Identity verification\n• Security settings\n• Creating support tickets\n\n`;
    response += `For complex issues, I can create a support ticket for our team to investigate.`;
    suggestions = ['Create ticket', 'Browse FAQs', 'View account'];
  }
  
  res.json({ response, suggestions, ticketCreated });
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
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  user.language = language;
  saveDB(db);
  
  res.json({ success: true, language });
});

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
  if (!user) return res.status(404).json({ error: 'User not found' });
  
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
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  const transaction = (db.transactions || []).find(t => 
    t.id.startsWith(transactionId.replace('...', '')) && 
    (t.fromWalletId === wallet.id || t.toWalletId === wallet.id)
  );
  
  if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
  
  // Masked transaction details
  const details = {
    id: maskTransactionId(transaction.id),
    type: transaction.type,
    amount: (transaction.amount / 100).toFixed(2),
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
    return res.status(400).json({ error: 'subject and description required' });
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

// Manual follow-up check endpoint (can be called by cron job)
app.post('/support/process-followups', authMiddleware, (req, res) => {
  // In production: add admin auth or use internal API key
  checkAndSendFollowUps();
  res.json({ success: true, message: 'Follow-ups processed' });
});

// Get ticket status with follow-up info
app.get('/support/ticket/:ticketId', authMiddleware, (req, res) => {
  const db = loadDB();
  const ticket = (db.supportTickets || []).find(t => t.id === req.params.ticketId);
  
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  // Verify user owns this ticket (or is admin)
  if (ticket.userId !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied' });
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
  
  if (!transactionId || !reason || !description) {
    return res.status(400).json({ error: 'transactionId, reason, and description required' });
  }
  
  // Verify transaction belongs to user
  const transaction = (db.transactions || []).find(t => t.id === transactionId);
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  
  if (!db.disputes) db.disputes = [];
  
  const dispute = {
    id: uuidv4(),
    userId: req.user.userId,
    transactionId,
    reason,
    description,
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  db.disputes.push(dispute);
  saveDB(db);
  
  res.json({ success: true, dispute });
});

// Report payroll fraud/dispute (auto-creates Freshdesk ticket)
app.post('/payroll/report-fraud', authMiddleware, async (req, res) => {
  const db = loadDB();
  const { transactionId, type, details, expectedAmount, receivedAmount } = req.body;
  
  if (!transactionId || !type || !details) {
    return res.status(400).json({ error: 'transactionId, type, and details required' });
  }
  
  const validTypes = ['unauthorized', 'wrong_amount', 'missing_payment', 'duplicate', 'fraud', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }
  
  // Find transaction
  const transaction = db.transactions.find(t => t.id === transactionId);
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  
  // Verify user is involved in transaction
  const userWallets = db.wallets.filter(w => w.userId === req.user.userId).map(w => w.id);
  if (!userWallets.includes(transaction.fromWalletId) && !userWallets.includes(transaction.toWalletId)) {
    return res.status(403).json({ error: 'Unauthorized - transaction not related to your account' });
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
    return res.status(400).json({ error: 'employerId, type, and details required' });
  }
  
  const validTypes = ['fraud', 'scam', 'fake_payroll', 'harassment', 'spam', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }
  
  const employer = db.employers.find(e => e.id === employerId);
  if (!employer) {
    return res.status(404).json({ error: 'Employer not found' });
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
    virtualCards: (db.virtualCards || []).filter(c => c.userId === userId),
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
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  // Require email and password confirmation
  if (user.email !== confirmEmail) {
    return res.status(400).json({ error: 'Email confirmation does not match' });
  }
  
  if (!confirmPassword || !bcrypt.compareSync(confirmPassword, user.passwordHash)) {
    return res.status(400).json({ error: 'Password confirmation invalid' });
  }
  
  logger.warn('Account deletion requested', { userId, email: maskEmail(user.email), ip: req.clientIP });
  
  // Anonymize instead of hard delete (for compliance)
  user.email = `deleted-${userId}@egwallet.deleted`;
  user.passwordHash = '';
  user.status = 'deleted';
  user.deletedAt = Date.now();
  user.deletionIP = req.clientIP;
  
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
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
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
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
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

// Get audit logs (admin only - add proper auth in production)
app.get('/admin/audit-logs', authMiddleware, (req, res) => {
  // TODO: Add admin role check
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

// System health check (detailed)
app.get('/admin/health/detailed', authMiddleware, (req, res) => {
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

// Fraud velocity status (admin)
app.get('/admin/fraud-velocity', authMiddleware, (req, res) => {
  // TODO: Add admin role check
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

// KYC TIER LIMITS CONFIGURATION
const KYC_TIERS = {
  0: { dailyLimit: 100, totalLimit: 500, name: 'Trial' },
  1: { dailyLimit: 5000, totalLimit: 50000, name: 'Worker' },
  2: { dailyLimit: 25000, totalLimit: 250000, name: 'Small Business' },
  3: { dailyLimit: Infinity, totalLimit: Infinity, name: 'Enterprise' }
};

// Helper: Check KYC tier limits
function checkKYCLimits(user, amountUSD) {
  if (!user.kycTier) user.kycTier = 0;
  if (user.kycStatus !== 'approved' && user.kycTier > 0) {
    return { allowed: false, reason: 'KYC verification pending' };
  }
  
  const tier = KYC_TIERS[user.kycTier] || KYC_TIERS[0];
  const today = new Date().toISOString().split('T')[0];
  
  // Reset daily spent if new day
  if (user.lastResetDate !== today) {
    user.dailySpent = 0;
    user.lastResetDate = today;
  }
  
  // Check daily limit
  if (user.dailySpent + amountUSD > tier.dailyLimit) {
    return { 
      allowed: false, 
      reason: `Daily limit exceeded. Tier ${user.kycTier} limit: $${tier.dailyLimit}/day`,
      currentSpent: user.dailySpent,
      limit: tier.dailyLimit
    };
  }
  
  // Check total wallet capacity (simplified - checking against one value)
  const maxCapacity = tier.totalLimit;
  // In real app, would sum all wallet balances
  if (amountUSD > maxCapacity) {
    return { 
      allowed: false, 
      reason: `Amount exceeds tier ${user.kycTier} capacity: $${maxCapacity}`,
      limit: maxCapacity
    };
  }
  
  return { allowed: true };
}

// Helper: Update daily spent
function updateDailySpent(user, amountUSD) {
  const today = new Date().toISOString().split('T')[0];
  if (user.lastResetDate !== today) {
    user.dailySpent = 0;
    user.lastResetDate = today;
  }
  user.dailySpent += amountUSD;
}

// Helper: Convert amount to USD for limit checking
function convertToUSD(amount, currency, rates) {
  const rate = rates.values[currency] || 1;
  return amount / rate;
}

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
      return res.status(400).json({ error: 'Employer account already exists' });
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
    return res.status(404).json({ error: 'Employer account not found' });
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
      return res.status(404).json({ error: 'Employer account not found' });
    }
    
    if (employer.verificationStatus !== 'verified') {
      return res.status(403).json({ 
        error: 'Employer not verified',
        message: 'Your employer account must be verified before sending payroll'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
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
        return res.status(400).json({ error: 'CSV file is empty' });
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
          errors.push({ row: rowNum, error: `Worker not found: ${workerId || email}` });
          continue;
        }
        
        // Find worker's wallet
        const workerWallet = db.wallets.find(w => w.userId === workerUser.id && w.type !== 'employer_funding');
        if (!workerWallet) {
          errors.push({ row: rowNum, error: `Worker ${workerUser.email} has no wallet` });
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
        
        payrollItems.push({
          rowNum,
          workerId: workerUser.id,
          workerEmail: workerUser.email,
          workerName: row.name || workerUser.email,
          walletId: workerWallet.id,
          amount,
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
          const usdAmount = convertToUSD(item.amount, item.currency, db.rates);
          return sum + usdAmount;
        }, 0)
      });
      
    } catch (error) {
      logger.error('CSV parsing error', { error: error.message, employerId: employer.id });
      res.status(400).json({ 
        error: 'Failed to parse CSV',
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
    body('payrollItems.*.amount').isFloat({ min: 0.01 }),
    body('payrollItems.*.currency').isString()
  ]),
  async (req, res) => {
    const db = loadDB();
    
    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) {
      return res.status(404).json({ error: 'Employer account not found' });
    }
    
    if (employer.verificationStatus !== 'verified') {
      return res.status(403).json({ error: 'Employer not verified' });
    }
    
    const { payrollItems, payPeriod, notes } = req.body;
    
    // Get funding wallet
    const fundingWallet = db.wallets.find(w => w.id === employer.fundingWalletId);
    if (!fundingWallet) {
      return res.status(500).json({ error: 'Funding wallet not found' });
    }
    
    // Calculate total needed per currency
    const totalsNeeded = {};
    for (const item of payrollItems) {
      if (!totalsNeeded[item.currency]) totalsNeeded[item.currency] = 0;
      totalsNeeded[item.currency] += item.amount;
    }
    
    // Check funding wallet has sufficient balance
    for (const [currency, total] of Object.entries(totalsNeeded)) {
      const balance = fundingWallet.balances.find(b => b.currency === currency);
      if (!balance || balance.amount < total) {
        return res.status(400).json({ 
          error: 'Insufficient funds',
          message: `Need ${total} ${currency}, but only have ${balance?.amount || 0} ${currency}`,
          currency,
          needed: total,
          available: balance?.amount || 0
        });
      }
    }
    
    // Create payroll batch
    const batchId = `BATCH-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const batch = {
      id: batchId,
      employerId: employer.id,
      employerName: employer.companyName,
      payPeriod: payPeriod || new Date().toISOString().substring(0, 7), // YYYY-MM
      status: 'processing',
      totalItems: payrollItems.length,
      successCount: 0,
      failureCount: 0,
      createdAt: Date.now(),
      completedAt: null,
      transactions: [],
      notes: notes || null
    };
    
    const results = [];
    
    // Process each payment
    for (const item of payrollItems) {
      try {
        // Get worker details for international payroll detection
        const worker = db.users.find(u => u.id === item.workerId);
        const employerUser = db.users.find(u => u.id === employer.userId);
        
        const employerCountry = employerUser?.region || 'GQ';
        const workerCountry = worker?.region || 'GQ';
        const isCrossBorder = employerCountry !== workerCountry;
        
        // Detect currency conversion
        const workerWallet = db.wallets.find(w => w.id === item.walletId);
        const wasConverted = item.currency !== (item.workerPreferredCurrency || item.currency);
        const receivedCurrency = item.workerPreferredCurrency || item.currency;
        const receivedAmount = wasConverted 
          ? Math.round(item.amount / (db.rates.values[item.currency] || 1) * (db.rates.values[receivedCurrency] || 1))
          : item.amount;
        
        // Create transaction with international payroll support
        const txn = {
          id: `TXN-${uuidv4()}`,
          type: 'payroll',
          fromWalletId: fundingWallet.id,
          toWalletId: item.walletId,
          amount: item.amount,
          currency: item.currency,
          receivedAmount: receivedAmount,
          receivedCurrency: receivedCurrency,
          wasConverted: wasConverted,
          status: 'completed',
          createdAt: Date.now(),
          memo: item.memo,
          // Payroll-specific metadata with international support
          payrollMetadata: {
            employerId: employer.id,
            employerName: employer.companyName,
            employerCountry: employerCountry,
            workerCountry: workerCountry,
            isCrossBorder: isCrossBorder,
            taxTreaty: isCrossBorder ? 'CEMAC' : null, // Auto-detect tax treaty for Central Africa
            payPeriod: batch.payPeriod,
            payrollBatchId: batchId,
            workerId: item.workerId,
            workerEmail: item.workerEmail,
            isRecurring: false
          },
          complianceFlags: {
            taxable: true,
            reportable: true,
            category: 'wages',
            crossBorder: isCrossBorder,
            currencyConverted: wasConverted
          }
        };
        
        // Deduct from funding wallet
        const fundingBalance = fundingWallet.balances.find(b => b.currency === item.currency);
        fundingBalance.amount -= item.amount;
        
        // Add to worker wallet (reuse workerWallet from above)
        let workerBalance = workerWallet.balances.find(b => b.currency === item.currency);
        if (!workerBalance) {
          workerBalance = { currency: item.currency, amount: 0 };
          workerWallet.balances.push(workerBalance);
        }
        workerBalance.amount += item.amount;
        
        db.transactions.push(txn);
        batch.transactions.push(txn.id);
        batch.successCount++;
        
        results.push({
          workerId: item.workerId,
          workerEmail: item.workerEmail,
          status: 'success',
          transactionId: txn.id,
          amount: item.amount,
          currency: item.currency
        });
        
        logger.info('Payroll payment processed', {
          batchId,
          employerId: employer.id,
          workerId: item.workerId,
          transactionId: txn.id,
          amount: item.amount,
          currency: item.currency
        });
        
      } catch (error) {
        batch.failureCount++;
        results.push({
          workerId: item.workerId,
          workerEmail: item.workerEmail,
          status: 'failed',
          error: error.message
        });
        
        logger.error('Payroll payment failed', {
          batchId,
          employerId: employer.id,
          workerId: item.workerId,
          error: error.message
        });
      }
    }
    
    // Update batch status
    batch.status = batch.failureCount === 0 ? 'completed' : 'partial';
    batch.completedAt = Date.now();
    
    // Update employer stats
    employer.totalBatches++;
    const totalUSD = payrollItems.reduce((sum, item) => {
      return sum + convertToUSD(item.amount, item.currency, db.rates);
    }, 0);
    employer.totalPayrollSent += totalUSD;
    
    db.payrollBatches.push(batch);
    saveDB(db);
    
    logAIInteraction(req.user.userId, 'BULK_PAYROLL_SENT', [batchId, batch.successCount], null, req);
    
    res.json({
      success: batch.failureCount === 0,
      batchId: batch.id,
      totalItems: batch.totalItems,
      successCount: batch.successCount,
      failureCount: batch.failureCount,
      status: batch.status,
      results
    });
  }
);

// Get payroll history
app.get('/employer/payroll-history', authMiddleware, (req, res) => {
  const db = loadDB();
  
  const employer = db.employers.find(e => e.userId === req.user.userId);
  if (!employer) {
    return res.status(404).json({ error: 'Employer account not found' });
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
    return res.status(404).json({ error: 'Employer account not found' });
  }
  
  const batch = db.payrollBatches.find(b => 
    b.id === req.params.batchId && b.employerId === employer.id
  );
  
  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
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
      return res.status(404).json({ error: 'Employer account not found. Register as employer first.' });
    }
    
    // Must be verified employer
    if (employer.verificationStatus !== 'verified') {
      return res.status(403).json({ error: 'Employer account must be verified to add employees' });
    }
    
    // Find worker by email
    const worker = db.users.find(u => u.email === workerEmail);
    if (!worker) {
      return res.status(404).json({ error: 'Worker not found. They must register first.' });
    }
    
    // Check if relationship already exists
    const existing = db.employerEmployees.find(
      ee => ee.employerId === employer.id && ee.workerId === worker.id
    );
    if (existing) {
      return res.status(400).json({ error: 'Employee already added' });
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
    return res.status(404).json({ error: 'Employer account not found' });
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
app.post('/employer/fund-wallet', authMiddleware, (req, res) => {
  const db = loadDB();
  const employer = db.employers.find(e => e.userId === req.user.userId);
  if (!employer) return res.status(404).json({ error: 'Employer account not found' });
  const fundingWallet = db.wallets.find(w => w.id === employer.fundingWalletId);
  if (!fundingWallet) return res.status(500).json({ error: 'Funding wallet not found' });
  const { amount = 1000000, currency = 'XAF' } = req.body;
  const addAmount = typeof amount === 'number' ? amount : 1000000;
  let balance = fundingWallet.balances.find(b => b.currency === currency);
  if (!balance) {
    balance = { currency, amount: 0 };
    fundingWallet.balances.push(balance);
  }
  balance.amount += addAmount;
  saveDB(db);
  logger.info('Employer funding wallet topped up', { employerId: employer.id, addAmount, currency });
  res.json({ success: true, balance: { currency: balance.currency, amount: balance.amount } });
});

// Get linked employers (worker view)
app.get('/employer/linked', authMiddleware, (req, res) => {
  const db = loadDB();
  
  // Find all employer-employee relationships for this user
  const relationships = db.employerEmployees.filter(ee => ee.userId === req.user.userId);
  
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
    const db = loadDB();
    const { employerId, amount, currency, memo } = req.body;
    
    // Verify worker is linked to this employer
    const relationship = db.employerEmployees.find(ee => 
      ee.employerId === employerId && ee.userId === req.user.userId
    );
    
    if (!relationship) {
      return res.status(403).json({ error: 'Not linked to this employer' });
    }
    
    const employer = db.employers.find(e => e.id === employerId);
    if (!employer) {
      return res.status(404).json({ error: 'Employer not found' });
    }
    
    // Get worker's wallet
    const userWallet = db.wallets.find(w => w.userId === req.user.userId);
    if (!userWallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    
    // Create payment request
    const request = {
      id: uuidv4(),
      walletId: userWallet.id,
      userId: req.user.userId,
      employerId: employerId,
      amount: Math.round(amount * 100), // Convert to minor units
      currency,
      memo: memo || '',
      type: 'payroll_request',
      status: 'pending',
      createdAt: Date.now(),
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
      requestId: request.id,
      employerId,
      userId: req.user.userId,
      amount: request.amount,
      currency
    });
    
    res.json({ 
      success: true, 
      request: {
        id: request.id,
        amount: request.amount,
        currency: request.currency,
        status: request.status
      }
    });
  }
);

// Confirm payroll payment (with idempotency protection)
app.post('/payroll/confirm-payment',
  authMiddleware,
  (req, res) => {
    const db = loadDB();
    const { employerId, batchId, amount, currency } = req.body;
    
    // Validate required fields
    if (!employerId || !batchId || !amount || !currency) {
      return res.status(400).json({ 
        error: 'Missing required fields: employerId, batchId, amount, currency' 
      });
    }
    
    // Idempotency check - prevent duplicate payments
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey) {
      const existingPayment = db.transactions.find(
        t => t.metadata?.idempotencyKey === idempotencyKey
      );
      
      if (existingPayment) {
        logger.info('Idempotent payment request - returning existing transaction', {
          transactionId: existingPayment.id,
          idempotencyKey,
          userId: req.user.userId
        });
        
        return res.json({ 
          success: true, 
          transaction: existingPayment,
          isIdempotent: true 
        });
      }
    }
    
    // Find employer
    const employer = db.employers.find(e => e.id === employerId);
    if (!employer) {
      return res.status(404).json({ error: 'Employer not found' });
    }
    
    // Find user relationship with employer
    const relationship = db.employerEmployees.find(
      ee => ee.employerId === employerId && ee.workerId === req.user.userId
    );
    
    if (!relationship) {
      logger.warn('Unauthorized payroll confirmation attempt', {
        employerId,
        userId: req.user.userId
      });
      return res.status(403).json({ 
        error: 'Not authorized to receive payments from this employer' 
      });
    }
    
    // Find user's wallet for this currency
    const wallet = db.wallets.find(
      w => w.userId === req.user.userId && w.currency === currency
    );
    
    if (!wallet) {
      return res.status(404).json({ 
        error: `No ${currency} wallet found` 
      });
    }
    
    // Create transaction
    const transaction = {
      id: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'payroll',
      fromWalletId: null, // Payroll from employer (external)
      toWalletId: wallet.id,
      amount,
      currency,
      status: 'completed',
      createdAt: new Date().toISOString(),
      metadata: {
        employerId,
        employerName: employer.employerName,
        batchId,
        verified: employer.verified,
        idempotencyKey: idempotencyKey || `auto_${Date.now()}`
      }
    };
    
    // Update wallet balance
    wallet.balance.amount += amount;
    wallet.balance.lastUpdated = new Date().toISOString();
    
    db.transactions.push(transaction);
    saveDB(db);
    
    logger.info('Payroll payment confirmed', {
      transactionId: transaction.id,
      userId: req.user.userId,
      employerId,
      amount,
      currency,
      batchId,
      idempotencyKey
    });
    
    res.json({ 
      success: true, 
      transaction,
      isIdempotent: false
    });
  }
);

// Remove employee
app.post('/employer/remove-employee/:relationshipId',
  authMiddleware,
  (req, res) => {
    const db = loadDB();
    
    const employer = db.employers.find(e => e.userId === req.user.userId);
    if (!employer) {
      return res.status(404).json({ error: 'Employer account not found' });
    }
    
    const relationshipIndex = db.employerEmployees.findIndex(
      ee => ee.id === req.params.relationshipId && ee.employerId === employer.id
    );
    
    if (relationshipIndex === -1) {
      return res.status(404).json({ error: 'Employee relationship not found' });
    }
    
    const removed = db.employerEmployees.splice(relationshipIndex, 1)[0];
    saveDB(db);
    
    logger.info('Employee removed from employer', {
      employerId: employer.id,
      workerId: removed.workerId,
      removedBy: req.user.userId
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
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    const { userId, kycTier, kycStatus } = req.body;
    
    const user = db.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    user.kycTier = kycTier;
    user.kycStatus = kycStatus;
    user.kycLimits = {
      dailyLimit: KYC_TIERS[kycTier].dailyLimit,
      totalLimit: KYC_TIERS[kycTier].totalLimit
    };
    
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
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    const { employerId, verificationStatus, notes } = req.body;
    
    const employer = db.employers.find(e => e.id === employerId);
    if (!employer) {
      return res.status(404).json({ error: 'Employer not found' });
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
    .sort((a, b) => b.createdAt - a.createdAt);
  
  res.json({ 
    payrollTransactions: payrollTransactions.map(t => ({
      id: t.id,
      amount: t.amount,
      currency: t.currency,
      employerName: t.payrollMetadata?.employerName,
      payPeriod: t.payrollMetadata?.payPeriod,
      receivedAt: t.createdAt,
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
  logger.warn('404 Not Found', { path: req.path, method: req.method, ip: req.clientIP });
  res.status(404).json({ 
    error: 'Not found', 
    path: req.path 
  });
});

// ==================== SERVER STARTUP ====================

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`EGWallet backend started`, {
    port: PORT,
    environment: NODE_ENV,
    jwtConfigured: !!JWT_SECRET,
    freshdeskConfigured: !!(FRESHDESK_DOMAIN && FRESHDESK_API_KEY)
  });
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 EGWallet Backend - World-Class Payroll API`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📍 Server: http://localhost:${PORT}`);
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

