#!/usr/bin/env node
/**
 * Forgot-password flow proof
 *
 * Static checks (always): routes, screens, email module, health fields
 * Live test (default): Ethereal SMTP end-to-end on ephemeral local server
 *
 * Run: node _forgot_password_proof.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'backend');
const nodemailer = require(path.join(BACKEND, 'node_modules', 'nodemailer'));
const PRODUCTION_URL = process.env.PRODUCTION_API_URL || 'https://egwalletsimple-production.up.railway.app';

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✅ PASS — ${label}`);
    passed += 1;
  } else {
    console.error(`  ❌ FAIL — ${label}${detail ? `: ${detail}` : ''}`);
    failed += 1;
  }
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode, json, raw });
      });
    }).on('error', reject);
  });
}

function waitForHealth(baseUrl, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const ping = await getJson(`${baseUrl}/healthz`);
        if (ping.status === 200) {
          const res = await getJson(`${baseUrl}/health`);
          if (res.status === 200 && res.json?.status === 'healthy') {
            resolve(res.json);
            return;
          }
        }
      } catch (_) {}
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Server did not become healthy within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

async function runStaticChecks() {
  console.log('\n=== STATIC CHECKS ===\n');

  const indexJs = read('backend/index.js');
  const forgotScreen = read('src/screens/ForgotPasswordScreen.tsx');
  const resetScreen = read('src/screens/ResetPasswordScreen.tsx');
  const emailModule = read('backend/passwordResetEmail.js');

  check('Backend exposes POST /auth/forgot-password', indexJs.includes("app.post('/auth/forgot-password'"));
  check('Backend exposes POST /auth/reset-password', indexJs.includes("app.post('/auth/reset-password'"));
  check('Backend uses passwordResetEmail helper', indexJs.includes("require('./passwordResetEmail')"));
  check('Forgot-password uses findUserByEmail (normalized lookup)', indexJs.includes('const user = findUserByEmail(db, email);'));
  check('normalizeAuthEmail helper exists', indexJs.includes('function normalizeAuthEmail'));
  check('/health exposes passwordResetEmailConfigured', indexJs.includes('passwordResetEmailConfigured'));
  check('Mobile ForgotPasswordScreen calls forgot-password API', forgotScreen.includes('/auth/forgot-password'));
  check('Mobile ResetPasswordScreen calls reset-password API', resetScreen.includes('/auth/reset-password'));
  check('Email module supports SMTP mode', emailModule.includes("return 'smtp'"));
  check('Email module supports Gmail app password mode', emailModule.includes("return 'gmail'"));
  check('Email module supports Resend API mode', emailModule.includes("return 'resend'"));
}

async function checkProductionHealth() {
  console.log('\n=== PRODUCTION DIAGNOSTIC ===\n');
  try {
    const res = await fetch(`${PRODUCTION_URL}/health`);
    const json = await res.json();
    check('Production /health responds 200', res.status === 200, `status=${res.status}`);
    console.log(`  ℹ️  production users=${json.users}, freshdeskConfigured=${json.freshdeskConfigured}`);
    if ('passwordResetEmailConfigured' in json) {
      check('Production passwordResetEmailConfigured is true', json.passwordResetEmailConfigured === true);
      console.log(`  ℹ️  passwordResetEmailMode=${json.passwordResetEmailMode}`);
    } else {
      check('Production exposes passwordResetEmailConfigured (deploy backend fix)', false, 'field missing — redeploy backend');
    }
    const forgotRes = await fetch(`${PRODUCTION_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'proof-nonexistent@example.com' }),
    });
    const forgotJson = await forgotRes.json();
    check('Production forgot-password returns success envelope', forgotRes.status === 200 && forgotJson?.success === true, `status=${forgotRes.status}`);
  } catch (err) {
    check('Production diagnostic reachable', false, err.message);
  }
}

async function runGmailNormalizationProof() {
  console.log('\n=== GMAIL VARIANT NORMALIZATION PROOF (Ethereal SMTP) ===\n');

  const testAccount = await nodemailer.createTestAccount();
  const dbPath = path.join(BACKEND, `db.gmail-norm-proof.${Date.now()}.json`);
  const port = 4300 + Math.floor(Math.random() * 200);
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    JWT_SECRET: process.env.JWT_SECRET || 'proof_jwt_secret_minimum_32_characters_long',
    ADMIN_SECRET: process.env.ADMIN_SECRET || 'proof_admin_secret_minimum_32_chars',
    PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY || 'a'.repeat(64),
    DB_FILE_PATH: dbPath,
    DB_BACKUP_PATH: `${dbPath}.bak`,
    SMTP_HOST: testAccount.smtp.host,
    SMTP_PORT: String(testAccount.smtp.port),
    SMTP_USER: testAccount.user,
    SMTP_PASS: testAccount.pass,
    SMTP_SECURE: 'false',
    SMTP_FROM: 'EGWallet Proof <proof@egwallet.test>',
    APP_FRONTEND_URL: 'egwallet://reset-password',
  };

  const server = spawn(process.execPath, ['index.js'], {
    cwd: BACKEND,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.on('exit', (code) => {
    if (code && code !== 0) serverLog += `\n[proof] server exited early with code ${code}\n`;
  });
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    await waitForHealth(baseUrl);

    const rawEmail = `cursor.proof.${Date.now()}@gmail.com`;
    const deviceId = `gmail-norm-proof-${Date.now()}`;
    const password = 'GmailNorm123!';

    const register = await postJson(`${baseUrl}/auth/register`, {
      email: rawEmail,
      password,
      region: 'US',
    }, { 'x-device-id': deviceId });
    check('Register Gmail variant (dots) succeeds', register.status === 200 || register.status === 201, `status=${register.status}`);

    const storedEmail = register.json?.user?.email;
    check('Register stores normalized Gmail (dots removed)', !!storedEmail && storedEmail !== rawEmail.toLowerCase(), `stored=${storedEmail}`);

    const forgot = await postJson(`${baseUrl}/auth/forgot-password`, { email: rawEmail });
    check('Forgot-password with raw registered Gmail variant succeeds', forgot.status === 200 && forgot.json?.success === true);

    await new Promise((r) => setTimeout(r, 1500));

    const sentLog = serverLog.includes('[Email] Password reset email sent');
    check('sendMail path reached (Password reset email sent log)', sentLog, sentLog ? '' : 'missing send log');
    const previewMatch = serverLog.match(/previewUrl":"(https:\/\/ethereal\.email\/message\/[^"]+)"/);
    check('Token email delivered (Ethereal preview URL logged)', !!previewMatch);
    if (!previewMatch) {
      console.log('\n--- server log tail ---\n', serverLog.slice(-3000));
      return;
    }

    const previewHtml = await fetch(previewMatch[1]).then((r) => r.text());
    const tokenMatch = previewHtml.match(/egwallet:\/\/reset-password\?token=([a-f0-9]{64})/i)
      || previewHtml.match(/token=([a-f0-9]{64})/i);
    check('Reset token generated and included in email', !!tokenMatch);

    const reset = await postJson(`${baseUrl}/auth/reset-password`, {
      token: tokenMatch[1],
      newPassword: 'NewGmailNorm123!',
    });
    check('Reset-password accepts token from Gmail-variant forgot flow', reset.status === 200 && reset.json?.success === true, `status=${reset.status}`);

    console.log('\n  🎯 GMAIL PROOF: raw dotted Gmail → forgot-password → token + sendMail → reset OK');
  } finally {
    server.kill('SIGTERM');
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(`${dbPath}.bak`); } catch (_) {}
  }
}

async function runLiveProof() {
  console.log('\n=== LIVE E2E PROOF (Ethereal SMTP) ===\n');

  const testAccount = await nodemailer.createTestAccount();
  const dbPath = path.join(BACKEND, `db.forgot-proof.${Date.now()}.json`);
  const port = 4100 + Math.floor(Math.random() * 200);
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    JWT_SECRET: process.env.JWT_SECRET || 'proof_jwt_secret_minimum_32_characters_long',
    ADMIN_SECRET: process.env.ADMIN_SECRET || 'proof_admin_secret_minimum_32_chars',
    PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY || 'a'.repeat(64),
    DB_FILE_PATH: dbPath,
    DB_BACKUP_PATH: `${dbPath}.bak`,
    SMTP_HOST: testAccount.smtp.host,
    SMTP_PORT: String(testAccount.smtp.port),
    SMTP_USER: testAccount.user,
    SMTP_PASS: testAccount.pass,
    SMTP_SECURE: 'false',
    SMTP_FROM: 'EGWallet Proof <proof@egwallet.test>',
    APP_FRONTEND_URL: 'egwallet://reset-password',
  };

  const server = spawn(process.execPath, ['index.js'], {
    cwd: BACKEND,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });
  server.on('exit', (code) => {
    if (code && code !== 0) {
      serverLog += `\n[proof] server exited early with code ${code}\n`;
    }
  });

  try {
    const health = await waitForHealth(baseUrl);
    check('Local proof server started', true);
    check('Local health reports passwordResetEmailConfigured=true', health.passwordResetEmailConfigured === true);
    check('Local health mode is smtp', health.passwordResetEmailMode === 'smtp');

    const email = `forgot-proof-${Date.now()}@example.com`;
    const deviceId = `proof-device-${Date.now()}`;
    const oldPassword = 'OldPass123!';
    const newPassword = 'NewPass456!';

    const register = await postJson(`${baseUrl}/auth/register`, {
      email,
      password: oldPassword,
      region: 'US',
    }, { 'x-device-id': deviceId });
    check('Register test user succeeds', register.status === 200 || register.status === 201, `status=${register.status}`);

    const forgot = await postJson(`${baseUrl}/auth/forgot-password`, { email });
    check('Forgot-password returns success', forgot.status === 200 && forgot.json?.success === true);

    await new Promise((r) => setTimeout(r, 1500));

    const previewMatch = serverLog.match(/previewUrl":"(https:\/\/ethereal\.email\/message\/[^"]+)"/);
    check('Server log contains Ethereal preview URL', !!previewMatch, previewMatch ? '' : 'no preview URL logged');
    if (!previewMatch) {
      console.log('\n--- server log tail ---\n', serverLog.slice(-3000));
      return;
    }

    const previewUrl = previewMatch[1];
    console.log(`  ℹ️  Ethereal preview: ${previewUrl}`);

    const previewHtml = await fetch(previewUrl).then((r) => r.text());
    const tokenMatch = previewHtml.match(/egwallet:\/\/reset-password\?token=([a-f0-9]{64})/i)
      || previewHtml.match(/token=([a-f0-9]{64})/i);
    check('Reset email contains token link', !!tokenMatch);
    const token = tokenMatch ? tokenMatch[1] : null;

    const reset = await postJson(`${baseUrl}/auth/reset-password`, {
      token,
      newPassword,
    });
    check('Reset-password succeeds with emailed token', reset.status === 200 && reset.json?.success === true, `status=${reset.status}`);

    const loginOld = await postJson(`${baseUrl}/auth/login`, { email, password: oldPassword }, { 'x-device-id': deviceId });
    check('Old password rejected after reset', loginOld.status === 401, `status=${loginOld.status}`);

    const loginNew = await postJson(`${baseUrl}/auth/login`, { email, password: newPassword }, { 'x-device-id': deviceId });
    check('New password login succeeds', loginNew.status === 200 && !!loginNew.json?.token, `status=${loginNew.status}`);

    console.log('\n  🎯 LIVE PROOF: forgot-password → email delivered → reset-password → login with new password');
  } finally {
    server.kill('SIGTERM');
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(`${dbPath}.bak`); } catch (_) {}
  }
}

(async () => {
  console.log('EGWallet Forgot Password Proof');
  await runStaticChecks();
  await checkProductionHealth();
  await runGmailNormalizationProof();
  await runLiveProof();

  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Proof script crashed:', err);
  process.exit(1);
});
