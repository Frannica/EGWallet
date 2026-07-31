'use strict';
/**
 * Durable dynamic QR create/load/verify against PostgreSQL.
 * Authoritative across Railway replicas — never rely on process-local JSON
 * for create/validate/pay of dynamic QR codes.
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { msToDate, upsertRuntimeWalletMetadata, upsertRuntimeUser } = require('./runtimeWalletSync');

function canonicalDynamicPayload({
  requestId, userId, walletId, amount, currency, memo, expiry, nonce,
}) {
  // Stable field order — never JSON.stringify for HMAC (key order is not guaranteed).
  return [
    'v1',
    'dynamic',
    String(requestId),
    String(userId),
    String(walletId),
    String(amount),
    String(currency).toUpperCase(),
    String(memo || ''),
    String(expiry),
    String(nonce),
  ].join('|');
}

function signDynamicQr(secret, fields) {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalDynamicPayload(fields))
    .digest('hex');
}

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function buildQrString({ requestId, amount, currency, signature }) {
  return `egwallet://pay?r=${requestId}&a=${amount}&c=${encodeURIComponent(currency)}&s=${signature}`;
}

function parseDynamicQrString(qrString) {
  let url;
  try {
    url = new URL(qrString);
  } catch {
    return null;
  }
  if (url.protocol !== 'egwallet:' || (url.hostname !== 'pay' && url.host !== 'pay')) {
    // egwallet://pay?... → hostname is "pay"
    if (!(url.protocol === 'egwallet:' && (url.pathname === '//pay' || url.host === 'pay' || qrString.startsWith('egwallet://pay?')))) {
      return null;
    }
  }
  const requestId = url.searchParams.get('r');
  const amount = url.searchParams.get('a');
  const currency = url.searchParams.get('c');
  const signature = url.searchParams.get('s');
  if (!requestId || !signature) return null;
  return {
    requestId,
    amount: amount !== null ? Number(amount) : null,
    currency: currency || null,
    signature,
  };
}

async function createDynamicQrPostgres({
  user,
  wallet,
  amount,
  currency,
  memo,
  expiryMinutes,
  hmacSecret,
}) {
  const requestId = uuidv4();
  const createdAt = Date.now();
  const expiry = createdAt + ((expiryMinutes || 15) * 60 * 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const curr = String(currency).toUpperCase();
  const memoSafe = memo || '';
  const signature = signDynamicQr(hmacSecret, {
    requestId,
    userId: user.id,
    walletId: wallet.id,
    amount,
    currency: curr,
    memo: memoSafe,
    expiry,
    nonce,
  });

  const payload = {
    v: '1',
    type: 'dynamic',
    requestId,
    userId: user.id,
    walletId: wallet.id,
    amount,
    currency: curr,
    memo: memoSafe,
    expiry,
    nonce,
    signature,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertRuntimeUser(client, user);
    await upsertRuntimeWalletMetadata(client, wallet);

    await client.query(
      `INSERT INTO payment_requests (
         id, requester_id, wallet_id, amount, currency, memo, status, type, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending','qr_dynamic',$7)`,
      [requestId, user.id, wallet.id, amount, curr, memoSafe, msToDate(createdAt)]
    );

    await client.query(
      `INSERT INTO qr_codes (
         id, user_id, wallet_id, amount, currency, payload, hmac_signature, nonce,
         status, created_at, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7,$8,'pending',$9,$10
       )`,
      [
        requestId,
        user.id,
        wallet.id,
        amount,
        curr,
        JSON.stringify(payload),
        signature,
        nonce,
        msToDate(createdAt),
        msToDate(expiry),
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  const qrString = buildQrString({ requestId, amount, currency: curr, signature });
  return {
    qrId: requestId,
    requestId,
    qrString,
    payload,
    expiresAt: expiry,
    displayText: `${amount} ${curr}${memoSafe ? ` - ${memoSafe}` : ''}`,
    // JSON mirror for admin/history display only — not authoritative
    jsonMirror: {
      request: {
        id: requestId,
        requesterId: user.id,
        walletId: wallet.id,
        amount,
        currency: curr,
        memo: memoSafe,
        status: 'pending',
        type: 'qr_dynamic',
        createdAt,
        expiry,
        nonce,
        paidAt: null,
        paidBy: null,
        transactionId: null,
      },
      qrCode: {
        id: requestId,
        userId: user.id,
        type: 'dynamic',
        payload,
        createdAt,
        expiry,
        used: false,
      },
    },
  };
}

async function getDynamicQrById(requestId) {
  const result = await pool.query(
    `SELECT q.id, q.user_id, q.wallet_id, q.amount, q.currency, q.payload, q.hmac_signature,
            q.nonce, q.status, q.created_at, q.expires_at, q.used_at, q.used_by, q.transaction_id,
            pr.status AS request_status, pr.requester_id, pr.memo AS request_memo
       FROM qr_codes q
       JOIN payment_requests pr ON pr.id = q.id
      WHERE q.id = $1
      LIMIT 1`,
    [requestId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    amount: Number(row.amount),
    currency: row.currency,
    payload: row.payload,
    hmacSignature: row.hmac_signature,
    nonce: row.nonce,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    usedAt: row.used_at ? new Date(row.used_at).getTime() : null,
    usedBy: row.used_by,
    transactionId: row.transaction_id,
    requestStatus: row.request_status,
    requesterId: row.requester_id,
    memo: row.request_memo || (row.payload && row.payload.memo) || '',
  };
}

/**
 * Validate a dynamic QR string against Postgres + HMAC (no money movement).
 * @returns {{ ok:true, qr } | { ok:false, code, error }}
 */
function verifyDynamicQrRecord(qr, { urlSignature, hmacSecret, now = Date.now() }) {
  if (!qr) return { ok: false, code: 'NOT_FOUND', error: 'QR code not found.' };

  // Status / expiry from Postgres are authoritative before HMAC (ops can force-expire).
  if (qr.status === 'used' || qr.requestStatus === 'paid' || qr.usedAt) {
    return { ok: false, code: 'USED', error: 'QR code has already been used.' };
  }
  if (qr.status === 'cancelled' || qr.requestStatus === 'cancelled') {
    return { ok: false, code: 'USED', error: 'QR code has already been used.' };
  }
  if (qr.requestStatus !== 'pending' || qr.status !== 'pending') {
    return { ok: false, code: 'USED', error: 'QR code has already been used.' };
  }
  if (qr.expiresAt && now > qr.expiresAt) {
    return { ok: false, code: 'EXPIRED', error: 'QR code has expired.', expiredAt: qr.expiresAt };
  }

  // HMAC over the original signed claim set (payload.expiry), not a mutated DB clock.
  const fields = {
    requestId: qr.id,
    userId: qr.userId,
    walletId: qr.walletId,
    amount: qr.amount,
    currency: qr.currency,
    memo: (qr.payload && qr.payload.memo) || qr.memo || '',
    expiry: (qr.payload && qr.payload.expiry) || qr.expiresAt,
    nonce: qr.nonce || (qr.payload && qr.payload.nonce),
  };
  const expected = signDynamicQr(hmacSecret, fields);
  if (urlSignature && !timingSafeEqualHex(expected, urlSignature)) {
    return { ok: false, code: 'TAMPERED', error: 'Invalid signature - possible fraud.' };
  }
  if (!timingSafeEqualHex(expected, qr.hmacSignature)) {
    return { ok: false, code: 'TAMPERED', error: 'Invalid signature - possible fraud.' };
  }
  return { ok: true, qr, expectedSignature: expected };
}

async function validateDynamicQrString(qrString, hmacSecret) {
  const parsed = parseDynamicQrString(qrString);
  if (!parsed) return { ok: false, code: 'INVALID_FORMAT', error: 'Invalid QR format.' };
  const qr = await getDynamicQrById(parsed.requestId);
  const verified = verifyDynamicQrRecord(qr, { urlSignature: parsed.signature, hmacSecret });
  if (!verified.ok) return verified;
  // Amount/currency in URL must match stored (anti-tamper of query params)
  if (parsed.amount !== null && Number(parsed.amount) !== Number(verified.qr.amount)) {
    return { ok: false, code: 'TAMPERED', error: 'Invalid signature - possible fraud.' };
  }
  if (parsed.currency && String(parsed.currency).toUpperCase() !== String(verified.qr.currency).toUpperCase()) {
    return { ok: false, code: 'TAMPERED', error: 'Invalid signature - possible fraud.' };
  }
  return verified;
}

module.exports = {
  canonicalDynamicPayload,
  signDynamicQr,
  timingSafeEqualHex,
  buildQrString,
  parseDynamicQrString,
  createDynamicQrPostgres,
  getDynamicQrById,
  verifyDynamicQrRecord,
  validateDynamicQrString,
};
