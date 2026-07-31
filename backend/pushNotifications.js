'use strict';

/**
 * Expo Push delivery — fire-and-forget from createNotification.
 * Never throws into the money path. Never logs or returns service credentials.
 */

const {
  isUserPushEnabled,
  listEnabledTokensForUser,
  disableToken,
  markTokenSent,
  reserveDeliveryAttempt,
  completeDeliveryAttempt,
  isValidExpoPushToken,
} = require('./db/pushTokens');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_TIMEOUT_MS = Number(process.env.EXPO_PUSH_TIMEOUT_MS || 8000);
const RECEIPT_TIMEOUT_MS = Number(process.env.EXPO_PUSH_RECEIPT_TIMEOUT_MS || 8000);
const MAX_RETRIES = Number(process.env.EXPO_PUSH_MAX_RETRIES || 2);

let _logger = console;
function setPushLogger(logger) {
  if (logger) _logger = logger;
}

function expoAccessHeaders() {
  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  // Optional — Expo recommends for higher rate limits. Never exposed to clients.
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

function isDeviceNotRegistered(errish) {
  const code = String(errish?.details?.error || errish?.error || errish?.code || '');
  const msg = String(errish?.message || errish?.details?.message || '');
  return code === 'DeviceNotRegistered'
    || /DeviceNotRegistered/i.test(msg)
    || /not a registered push/i.test(msg);
}

async function sendExpoMessages(messages) {
  const res = await fetchWithTimeout(
    EXPO_PUSH_URL,
    { method: 'POST', headers: expoAccessHeaders(), body: JSON.stringify(messages) },
    SEND_TIMEOUT_MS
  );
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw Object.assign(new Error(`expo_push_bad_json_${res.status}`), { status: res.status });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`expo_push_http_${res.status}`), { status: res.status, body: json });
  }
  return json;
}

async function fetchExpoReceipts(ticketIds) {
  if (!ticketIds.length) return {};
  const res = await fetchWithTimeout(
    EXPO_RECEIPTS_URL,
    {
      method: 'POST',
      headers: expoAccessHeaders(),
      body: JSON.stringify({ ids: ticketIds }),
    },
    RECEIPT_TIMEOUT_MS
  );
  const json = await res.json().catch(() => ({}));
  return json.data || {};
}

async function deliverToToken({ userId, notificationId, token, title, body, data }) {
  const reserved = await reserveDeliveryAttempt({ notificationId, userId, token });
  if (!reserved) {
    return { skipped: true, reason: 'duplicate' };
  }

  const message = {
    to: token,
    sound: 'default',
    title: String(title || 'EGWallet').slice(0, 100),
    body: String(body || '').slice(0, 240),
    data: {
      ...(data && typeof data === 'object' ? data : {}),
      notificationId,
      type: data?.type || 'notification',
    },
    priority: 'high',
    channelId: 'default',
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await sendExpoMessages([message]);
      const ticket = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!ticket) {
        lastErr = new Error('empty_ticket');
        continue;
      }
      if (ticket.status === 'error') {
        if (isDeviceNotRegistered(ticket)) {
          await disableToken(token, 'DeviceNotRegistered');
          await completeDeliveryAttempt({
            notificationId, token, status: 'device_not_registered',
            providerTicket: null, error: ticket.message || 'DeviceNotRegistered',
          });
          return { ok: false, invalidToken: true };
        }
        lastErr = new Error(ticket.message || ticket.details?.error || 'expo_error');
        if (attempt < MAX_RETRIES) continue;
        await completeDeliveryAttempt({
          notificationId, token, status: 'error',
          providerTicket: null, error: lastErr.message,
        });
        return { ok: false, error: lastErr.message };
      }

      const ticketId = ticket.id || null;
      await markTokenSent(token);
      await completeDeliveryAttempt({
        notificationId, token, status: 'sent',
        providerTicket: ticketId, error: null,
      });

      // Best-effort receipt check (non-blocking for caller already async)
      if (ticketId) {
        try {
          // Expo receipts are often available shortly after; small delay.
          await new Promise((r) => setTimeout(r, 1200));
          const receipts = await fetchExpoReceipts([ticketId]);
          const receipt = receipts[ticketId];
          if (receipt?.status === 'error' && isDeviceNotRegistered(receipt)) {
            await disableToken(token, 'DeviceNotRegistered');
            await completeDeliveryAttempt({
              notificationId, token, status: 'device_not_registered',
              providerTicket: ticketId, error: receipt.message || 'DeviceNotRegistered',
            });
            return { ok: false, invalidToken: true, ticketId };
          }
          if (receipt?.status === 'error') {
            await completeDeliveryAttempt({
              notificationId, token, status: 'receipt_error',
              providerTicket: ticketId, error: receipt.message || 'receipt_error',
            });
          }
        } catch (receiptErr) {
          _logger.warn?.('[push] receipt check failed', { message: receiptErr.message });
        }
      }
      return { ok: true, ticketId };
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') lastErr = new Error('timeout');
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
    }
  }

  await completeDeliveryAttempt({
    notificationId, token, status: 'error',
    providerTicket: null, error: lastErr?.message || 'send_failed',
  });
  return { ok: false, error: lastErr?.message || 'send_failed' };
}

/**
 * Schedule push delivery without awaiting. Safe to call from money paths.
 */
function schedulePushForNotification({ userId, notificationId, type, title, body, metadata }) {
  if (!userId || !notificationId) return;
  if (process.env.PUSH_NOTIFICATIONS_DISABLED === 'true') return;

  setImmediate(() => {
    deliverPushForNotification({ userId, notificationId, type, title, body, metadata })
      .catch((err) => {
        try {
          _logger.warn?.('[push] deliver failed', { userId, notificationId, error: err.message });
        } catch (_) {}
      });
  });
}

async function deliverPushForNotification({ userId, notificationId, type, title, body, metadata }) {
  const enabled = await isUserPushEnabled(userId);
  if (!enabled) return { skipped: true, reason: 'opt_out' };

  const tokens = await listEnabledTokensForUser(userId);
  if (!tokens.length) return { skipped: true, reason: 'no_tokens' };

  const data = { type: type || 'notification', ...(metadata || {}) };
  const results = [];
  for (const row of tokens) {
    if (!isValidExpoPushToken(row.token)) {
      await disableToken(row.token, 'TOKEN_INVALID');
      continue;
    }
    results.push(await deliverToToken({
      userId,
      notificationId,
      token: row.token,
      title,
      body,
      data,
    }));
  }
  return { results };
}

function getPushProviderReadiness() {
  return {
    provider: 'expo',
    pushApi: EXPO_PUSH_URL,
    expoAccessTokenConfigured: !!process.env.EXPO_ACCESS_TOKEN,
    disabled: process.env.PUSH_NOTIFICATIONS_DISABLED === 'true',
    sendTimeoutMs: SEND_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    // Expo delivers via FCM/APNs using credentials configured in the Expo project.
    // Backend never holds FCM server keys when using Expo push tokens.
    note: 'Expo Push API; FCM/APNs credentials live in Expo project, not this server',
  };
}

module.exports = {
  setPushLogger,
  schedulePushForNotification,
  deliverPushForNotification,
  deliverToToken,
  sendExpoMessages,
  fetchExpoReceipts,
  getPushProviderReadiness,
  isDeviceNotRegistered,
};
