'use strict';

/**
 * Lightspark Grid webhook verification and event handling.
 *
 * Official docs:
 *   https://docs.lightspark.com/api-reference/webhooks
 *   Header: X-Grid-Signature
 *   Payload hash: SHA-256 of the exact raw request body
 *   Public key: PEM from GRID_WEBHOOK_PUBLIC_KEY (dashboard)
 *   Idempotency: webhook `id` field
 */

const crypto = require('crypto');
const { getGridWebhookPublicKey, isGridWebhookPublicKeyConfigured } = require('./gridEnv');
const gridDb = require('../db/gridPostgres');
const { markWithdrawalPaid, markWithdrawalFailed } = require('../withdrawalEngine');
const { loadAppState, saveAppState } = require('../db/appStateStore');
const { commitWithdrawalStateUpdate } = require('../db/withdrawalsPostgres');
const { applyIncomingPayment } = require('./gridIncomingCredit');

function parseSignatureHeader(header) {
  if (!header || typeof header !== 'string') return null;
  try {
    const parsed = JSON.parse(header);
    if (parsed && parsed.s) return Buffer.from(parsed.s, 'base64');
  } catch (_err) {
    // Official fallback: treat the header as raw base64.
  }
  try {
    return Buffer.from(header, 'base64');
  } catch (_err) {
    return null;
  }
}

function verifyGridWebhookSignature(rawBody, signatureHeader) {
  if (!isGridWebhookPublicKeyConfigured()) {
    return { ok: false, reason: 'key_missing' };
  }
  const publicKey = getGridWebhookPublicKey();
  const signature = parseSignatureHeader(signatureHeader);
  if (!signature || !signature.length) {
    return { ok: false, reason: 'signature_missing' };
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(payload);
    verifier.end();
    const valid = verifier.verify(
      { key: publicKey, format: 'pem', type: 'spki' },
      signature
    );
    return valid ? { ok: true, reason: 'ok' } : { ok: false, reason: 'invalid' };
  } catch (_err) {
    return { ok: false, reason: 'invalid' };
  }
}

function webhookEventId(body) {
  return (body && (body.id || body.webhookId)) || null;
}

function webhookEventType(body) {
  return (body && body.type) || 'UNKNOWN';
}

function extractCustomerId(data) {
  if (!data) return null;
  if (typeof data.id === 'string' && data.id.startsWith('Customer:')) return data.id;
  if (typeof data.customerId === 'string' && data.customerId.startsWith('Customer:')) return data.customerId;
  return null;
}

function extractTransactionId(data) {
  if (!data) return null;
  if (typeof data.id === 'string' && data.id.startsWith('Transaction:')) return data.id;
  if (typeof data.transactionId === 'string' && data.transactionId.startsWith('Transaction:')) return data.transactionId;
  return null;
}

async function applyOutgoingPayment(type, data, logger, withBalanceMutex) {
  const transactionId = extractTransactionId(data);
  if (!transactionId) return;
  const withdrawalId = await gridDb.findWithdrawalIdByGridTransaction(transactionId);
  if (!withdrawalId) {
    logger.info('[webhook/grid] Outgoing payment with no local withdrawal', { type });
    return;
  }

  const settled = type === 'OUTGOING_PAYMENT.COMPLETED' || (data && data.status === 'COMPLETED');
  const failed = type === 'OUTGOING_PAYMENT.FAILED' || (data && data.status === 'FAILED');
  if (!settled && !failed) return;

  const run = withBalanceMutex ? withBalanceMutex : (fn) => fn();
  await run(async () => {
    const db = loadAppState();
    const w = (db.withdrawals || []).find((x) => x.id === withdrawalId);
    if (!w || w.status !== 'processing') return;
    if (settled) {
      markWithdrawalPaid(db, withdrawalId, transactionId, 'lightspark');
      logger.info('[webhook/grid] Marked paid', { withdrawalId });
    } else if (w.payoutReference || w.payoutDispatchRef) {
      w.reconcileRequired = true;
      saveAppState(db);
      logger.warn('[webhook/grid] Failure on active disbursement — leaving processing', { withdrawalId });
      return;
    } else {
      markWithdrawalFailed(db, withdrawalId, `Grid webhook: ${type}`);
    }
    await commitWithdrawalStateUpdate(
      db,
      (db.withdrawals || []).find((x) => x.id === withdrawalId),
      'processing'
    );
  });
}

async function applyCustomerEvent(type, data, logger) {
  const customerId = extractCustomerId(data);
  if (!customerId) return;
  let status = data.kycStatus || data.status || null;
  if (type.includes('KYC_APPROVED') || type.includes('KYB_APPROVED')) status = 'APPROVED';
  if (type.includes('KYC_REJECTED') || type.includes('KYB_REJECTED')) status = 'REJECTED';
  if (type.includes('KYC_PENDING') || type.includes('KYB_PENDING')) status = 'PENDING';
  if (!status) return;
  const updated = await gridDb.updateGridCustomerStatus(customerId, status);
  if (updated) logger.info('[webhook/grid] Customer status updated', { type });
}

async function applyAccountEvent(type, data, logger) {
  if (!data) return;
  const accountId = data.id || data.accountId;
  if (typeof accountId === 'string' && accountId.startsWith('InternalAccount:')) {
    const currency = data.currency?.code || data.balance?.currency?.code || data.currency || 'USD';
    await gridDb.upsertGridInternalAccount({
      gridInternalAccountId: accountId,
      gridCustomerId: data.customerId || null,
      currency,
      status: data.status || null,
    });
    logger.info('[webhook/grid] Internal account event', { type });
  }
  if (typeof accountId === 'string' && accountId.startsWith('ExternalAccount:')) {
    const existing = await gridDb.getGridExternalAccountByGridId(accountId);
    if (existing) {
      await gridDb.upsertGridExternalAccount({
        userId: existing.user_id,
        gridCustomerId: existing.grid_customer_id,
        gridExternalAccountId: accountId,
        currency: existing.currency,
        status: data.status || existing.status,
      });
    }
  }
}

/**
 * Process a verified webhook body. Incoming COMPLETED events credit the
 * mapped EGWallet wallet via the atomic ledger. Stripe deposits stay on
 * stripe_intent_id and are never written by this path.
 */
async function processGridWebhookEvent(body, logger, withBalanceMutex, injected) {
  const type = webhookEventType(body);
  const data = body && body.data ? body.data : {};

  if (type === 'TEST') {
    return { handled: true, type, credited: false, reason: 'test' };
  }
  if (type.startsWith('OUTGOING_PAYMENT.')) {
    await applyOutgoingPayment(type, data, logger, withBalanceMutex);
    return { handled: true, type };
  }
  if (type.startsWith('INCOMING_PAYMENT.')) {
    const incoming = await applyIncomingPayment(type, data, logger, withBalanceMutex, injected);
    return { handled: true, type, credited: !!incoming.credited, reason: incoming.reason };
  }
  if (type.startsWith('CUSTOMER.') || type.startsWith('VERIFICATION.')) {
    await applyCustomerEvent(type, data, logger);
    return { handled: true, type };
  }
  if (type.startsWith('ACCOUNT.') || type.startsWith('INTERNAL_ACCOUNT.') || type.startsWith('EXTERNAL_ACCOUNT.')) {
    await applyAccountEvent(type, data, logger);
    return { handled: true, type };
  }
  logger.info('[webhook/grid] Unhandled event type acknowledged', { type });
  return { handled: true, type };
}

async function handleGridWebhook({ rawBody, signatureHeader, parsedBody, logger, withBalanceMutex }) {
  const verified = verifyGridWebhookSignature(rawBody, signatureHeader);
  if (!verified.ok) {
    return { status: verified.reason === 'key_missing' ? 503 : 401, body: { error: 'Webhook signature verification failed' } };
  }

  const eventId = webhookEventId(parsedBody);
  const eventType = webhookEventType(parsedBody);
  if (!eventId) {
    return { status: 400, body: { error: 'Missing webhook id' } };
  }

  const reserved = await gridDb.reserveGridWebhookEvent({ webhookId: eventId, eventType });
  if (!reserved) {
    if (eventType.startsWith('INCOMING_PAYMENT.') || eventType.startsWith('OUTGOING_PAYMENT.')) {
      await processGridWebhookEvent(parsedBody, logger, withBalanceMutex);
    }
    return { status: 200, body: { received: true, duplicate: true } };
  }

  await processGridWebhookEvent(parsedBody, logger, withBalanceMutex);
  await gridDb.markGridWebhookEventProcessed(eventId);
  return { status: 200, body: { received: true } };
}

module.exports = {
  verifyGridWebhookSignature,
  webhookEventId,
  processGridWebhookEvent,
  handleGridWebhook,
};
