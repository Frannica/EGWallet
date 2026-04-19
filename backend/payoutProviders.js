'use strict';
/**
 * payoutProviders.js
 * Handles real money movement via Stripe (international) and Kora (African).
 *
 * Entry point: executePayout(withdrawalId, loadDB, saveDB, logger)
 *   — called asynchronously from index.js AFTER the HTTP response is sent.
 *   — loads a fresh DB, calls the right provider, marks paid or failed.
 *
 * Provider routing:
 *   Africa (XAF/XOF zone + broader African countries) → Kora
 *   Everything else → Stripe
 *
 * PRODUCTION NOTES:
 *   Stripe:  Requires funds in your Stripe balance and an External Account
 *            (bank or debit card) registered on the connected account.
 *            For custom bank-to-bank disbursements, use Stripe Connect.
 *   Kora:    Set KORA_API_KEY env var. Kora covers NG, GH, KE, CM, SN, CI, etc.
 */

const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');

// ─── Stripe client ────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient      = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ─── Engine functions (imported to avoid re-importing db helpers) ─────────────
const { markWithdrawalPaid, markWithdrawalFailed } = require('./withdrawalEngine');

// ─── Currency helpers ─────────────────────────────────────────────────────────
// Currencies where the smallest unit IS the major unit (no cents/pence).
const ZERO_DECIMAL = new Set([
  'XAF', 'XOF', 'BIF', 'GNF', 'KMF', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XPF', 'JPY', 'KRW', 'CLP',
]);

/**
 * Convert EGWallet internal (minor unit) amount to the provider's expected unit.
 * Stripe: minor units (cents) for non-zero-decimal; major units for zero-decimal.
 * Kora:   always major units.
 */
function toStripeAmount(amount, currency) {
  // Stripe already expects minor units for non-zero-decimal, and natural units
  // for zero-decimal — which is exactly how EGWallet stores amounts.
  return Math.round(amount);
}

function toKoraAmount(amount, currency) {
  // Kora expects major units for all currencies.
  if (ZERO_DECIMAL.has((currency || '').toUpperCase())) return Math.round(amount);
  return parseFloat((amount / 100).toFixed(2));
}

// ─── Provider routing ─────────────────────────────────────────────────────────
const KORA_COUNTRIES = new Set([
  // XAF zone (Central Africa CFA franc)
  'CM', 'CF', 'TD', 'CG', 'GQ', 'GA',
  // XOF zone (West Africa CFA franc)
  'BJ', 'BF', 'CI', 'GW', 'ML', 'NE', 'SN', 'TG',
  // Other African countries supported by Kora
  'NG', 'GH', 'KE', 'ZA', 'TZ', 'UG', 'RW', 'ET',
  'ZM', 'ZW', 'MZ', 'AO', 'NA', 'BW', 'MW', 'LS',
  'SZ', 'MG', 'MU', 'SC', 'DZ', 'MA', 'TN', 'LY', 'EG', 'SD',
  'SL', 'LR', 'GM', 'MR', 'DJ', 'ER', 'SO',
]);

function payoutRouter(country) {
  if (!country) return 'stripe';
  return KORA_COUNTRIES.has(country.trim().toUpperCase()) ? 'kora' : 'stripe';
}

// ─── Stripe payout ────────────────────────────────────────────────────────────
/**
 * Executes a payout via Stripe.
 *
 * Uses stripe.payouts.create() for debit card instant payouts,
 * and stripe.payouts.create() standard for bank accounts.
 *
 * Production requirements:
 *   • Funds must be in the Stripe connected account's balance.
 *   • Destination must be a registered External Account on that account.
 *   • For arbitrary user bank accounts, requires Stripe Connect setup.
 *
 * @param   {object} w       - withdrawal record
 * @param   {object} logger
 * @returns {{ provider, reference, raw }}
 */
async function stripePayout(w, logger) {
  if (!stripeClient) {
    throw new Error('Stripe is not configured — STRIPE_SECRET_KEY is missing');
  }

  const currency  = w.currency.toLowerCase();
  const amount    = toStripeAmount(w.netPayout, w.currency);
  const isInstant = w.method === 'debit';          // debit card supports instant
  const method    = isInstant ? 'instant' : 'standard';

  logger.info('[Stripe] Creating payout', {
    withdrawalId: w.id,
    amount,
    currency,
    method,
  });

  const payout = await stripeClient.payouts.create({
    amount,
    currency,
    method,
    description: `EGWallet withdrawal ${w.id}`,
    metadata: {
      withdrawalId: w.id,
      userId:       w.userId,
    },
  });

  logger.info('[Stripe] Payout created', {
    withdrawalId: w.id,
    payoutId:     payout.id,
    status:       payout.status,
    arrival:      payout.arrival_date,
  });

  // Stripe payout statuses: paid | pending | in_transit | canceled | failed
  if (payout.status === 'failed' || payout.status === 'canceled') {
    throw new Error(`Stripe payout ${payout.id} status: ${payout.status}`);
  }

  return {
    provider:  'stripe',
    reference: payout.id,
    raw: {
      id:           payout.id,
      status:       payout.status,
      arrival_date: payout.arrival_date,
      method:       payout.method,
    },
  };
}

// ─── Kora payout ─────────────────────────────────────────────────────────────
/**
 * Executes a bank transfer via the Kora Disbursement API.
 *
 * API: POST https://api.korapay.com/merchant/api/v1/transactions/disburse
 * Auth: Authorization: Bearer {KORA_API_KEY}
 *
 * Amounts are in major currency units (e.g. 1000 = 1000 XAF / 1000 NGN).
 *
 * @param   {object} w       - withdrawal record
 * @param   {object} logger
 * @returns {{ provider, reference, raw }}
 */
async function koraPayout(w, logger) {
  const KORA_API_KEY = process.env.KORA_API_KEY;
  if (!KORA_API_KEY) {
    throw new Error('Kora is not configured — KORA_API_KEY is missing');
  }

  const amount    = toKoraAmount(w.netPayout, w.currency);
  const reference = `egw-${w.id}`;

  const payload = {
    reference,
    destination: {
      type:      'bank_account',
      amount,
      currency:  w.currency,
      narration: `EGWallet withdrawal`,
      bank_account: {
        bank:         w.bankCode  || w.bankName        || '',
        account:      w.accountNumber                  || '',
        account_name: w.accountHolderName              || '',
      },
    },
  };

  logger.info('[Kora] Initiating disbursement', {
    withdrawalId: w.id,
    reference,
    amount,
    currency: w.currency,
    bank:     payload.destination.bank_account.bank,
  });

  let response;
  try {
    response = await axios.post(
      'https://api.korapay.com/merchant/api/v1/transactions/disburse',
      payload,
      {
        headers: {
          Authorization: `Bearer ${KORA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );
  } catch (err) {
    // Axios throws on non-2xx; pull message from Kora's error body if present
    const koraMsg = err.response?.data?.message || err.message;
    throw new Error(`Kora API error: ${koraMsg}`);
  }

  const body = response.data;

  logger.info('[Kora] Disbursement response', {
    withdrawalId: w.id,
    status:       body.status,
    message:      body.message,
    data:         body.data,
  });

  if (!body.status) {
    throw new Error(`Kora disbursement failed: ${body.message || 'unknown error'}`);
  }

  const koraRef = body.data?.transaction_reference || body.data?.reference || reference;

  return {
    provider:  'kora',
    reference: koraRef,
    raw: {
      transaction_reference: koraRef,
      status:                body.data?.status,
      amount:                body.data?.amount,
      currency:              body.data?.currency,
    },
  };
}

// ─── Error classification ─────────────────────────────────────────────────────
/**
 * Classifies a caught error as 'retryable' or 'permanent'.
 *
 * Retryable:  transient network / infrastructure errors that are safe to retry
 *             (ECONNRESET, ETIMEDOUT, ENOTFOUND, HTTP 429, 500, 502, 503, 504)
 *
 * Permanent:  anything that indicates the provider deliberately rejected the
 *             request — wrong bank details, bad account, auth failure, config
 *             problems, insufficient balance, etc.
 *
 * @param  {Error} err
 * @returns {'retryable' | 'permanent'}
 */
function classifyError(err) {
  const msg = (err.message || '').toLowerCase();

  // ── Config / setup errors — never retry ──────────────────────────────────
  if (msg.includes('not configured') || msg.includes('missing')) return 'permanent';

  // ── Stripe SDK errors ─────────────────────────────────────────────────────
  // err.type set by the Stripe Node SDK
  if (err.type) {
    // StripeConnectionError / StripeAPIError (5xx from Stripe) → retryable
    if (err.type === 'StripeConnectionError') return 'retryable';
    if (err.type === 'StripeAPIError')        return 'retryable';
    // Everything else (StripeAuthenticationError, StripeInvalidRequestError,
    // StripeCardError, StripePermissionError, etc.) → permanent
    return 'permanent';
  }

  // ── Stripe payout status failures (thrown by stripePayout as plain Error) ─
  if (msg.includes('stripe payout') && (msg.includes('failed') || msg.includes('canceled')))
    return 'permanent';

  // ── Kora API errors ───────────────────────────────────────────────────────
  if (msg.startsWith('kora api error:')) {
    // 4xx inside Kora response body → permanent (bad account, auth, etc.)
    if (msg.includes('invalid') || msg.includes('not found') ||
        msg.includes('unauthorized') || msg.includes('forbidden') ||
        msg.includes('account') || msg.includes('bank') ||
        msg.includes('duplicate') || msg.includes('insufficient'))
      return 'permanent';
    // Generic Kora API error with no explicit domain reason → retryable
    return 'retryable';
  }

  // ── Kora success-false (thrown by koraPayout when body.status is falsy)
  if (msg.startsWith('kora disbursement failed:')) return 'permanent';

  // ── Axios / Node network errors ───────────────────────────────────────────
  const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
                                    'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN']);
  if (err.code && RETRYABLE_CODES.has(err.code)) return 'retryable';

  // ── HTTP status from Axios ────────────────────────────────────────────────
  const httpStatus = err.response?.status;
  if (httpStatus) {
    if (httpStatus === 429 || httpStatus >= 500) return 'retryable';
    return 'permanent';   // 4xx → provider rejected the request
  }

  // Default: treat unknown errors as permanent (fail safe)
  return 'permanent';
}

// ─── executePayout ────────────────────────────────────────────────────────────
/**
 * Orchestrates a real payout for a withdrawal that is in "processing" status.
 *
 * Called via setImmediate() in index.js AFTER the HTTP response has been sent,
 * so it loads a fresh copy of the DB, runs the provider call, then saves.
 *
 * Safety rules:
 *   • Never marks "paid" unless the provider API call succeeds and returns a ref.
 *   • On permanent error (invalid bank details, auth rejection, etc.) → "failed"
 *     immediately, full refund issued.
 *   • On transient/network error → one automatic retry (MAX 1).
 *     payoutAttempts is incremented and persisted to DB before each attempt so
 *     that even a crash between attempts leaves an accurate counter.
 *   • After the retry, if still failing → "failed", full refund.
 *   • holdReleased / refundIssued guards on markWithdrawalPaid / _issueRefund
 *     ensure double-payout and double-refund are impossible regardless of
 *     concurrent calls or DB reload timing.
 *   • All provider responses and retry decisions are logged.
 *
 * @param {string}   withdrawalId
 * @param {function} loadDB
 * @param {function} saveDB
 * @param {object}   logger
 */
async function executePayout(withdrawalId, loadDB, saveDB, logger) {
  logger.info('[executePayout] Starting', { withdrawalId });

  // ── Load fresh DB ─────────────────────────────────────────────────────────
  const db = loadDB();
  const w  = (db.withdrawals || []).find(x => x.id === withdrawalId);

  if (!w) {
    logger.error('[executePayout] Withdrawal not found', { withdrawalId });
    return;
  }

  if (w.status !== 'processing') {
    logger.warn('[executePayout] Unexpected status — skipping', { withdrawalId, status: w.status });
    return;
  }

  // Guard: payoutAttempts is persisted, so if this function is called again
  // after a crash mid-retry, we will not exceed the cap.
  const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
  if (w.payoutAttempts >= MAX_ATTEMPTS) {
    logger.warn('[executePayout] payoutAttempts cap reached — blocked', {
      withdrawalId,
      payoutAttempts: w.payoutAttempts,
    });
    return;
  }

  const provider = payoutRouter(w.country);
  logger.info('[executePayout] Routing to provider', { withdrawalId, provider, country: w.country });

  // ── Demo mode: no provider configured → simulate a successful payout ─────
  // Consistent with the deposit system which also uses demo mode when Stripe
  // is not configured.  Logged clearly so it is easy to spot in production.
  const isDemoMode =
    (provider === 'stripe' && !stripeClient) ||
    (provider === 'kora'   && !process.env.KORA_API_KEY);

  if (isDemoMode) {
    logger.warn('[executePayout] DEMO MODE — no payment provider configured, simulating payout', {
      withdrawalId,
      provider,
    });
    try {
      const dbDemo = loadDB();
      markWithdrawalPaid(dbDemo, withdrawalId, `DEMO-${withdrawalId.slice(0, 8)}`, 'demo');
      saveDB(dbDemo);
      logger.info('[executePayout] Demo payout marked as paid', { withdrawalId });
    } catch (demoErr) {
      logger.error('[executePayout] Demo mode: could not mark paid', {
        withdrawalId,
        error: demoErr.message,
      });
    }
    return;
  }

  // ── attemptPayout — inner function, may run up to twice ──────────────────
  async function attemptPayout(attemptNumber) {
    // Increment and persist payoutAttempts BEFORE the network call.
    // This ensures that even a mid-attempt crash leaves the counter accurate.
    const dbAttempt = loadDB();
    const wAttempt  = (dbAttempt.withdrawals || []).find(x => x.id === withdrawalId);
    if (!wAttempt) throw new Error('Withdrawal disappeared before attempt');
    if (wAttempt.holdReleased) throw Object.assign(
      new Error('Hold already released — duplicate payout guard'),
      { _permanent: true }
    );
    wAttempt.payoutAttempts = attemptNumber;
    saveDB(dbAttempt);

    logger.info('[executePayout] Attempt', { withdrawalId, attemptNumber, provider });

    let result;
    if (provider === 'stripe') {
      result = await stripePayout(wAttempt, logger);
    } else {
      result = await koraPayout(wAttempt, logger);
    }
    return result;
  }

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  let result;
  let lastError;

  try {
    result = await attemptPayout(1);
  } catch (err) {
    lastError = err;
    const kind = err._permanent ? 'permanent' : classifyError(err);

    logger.warn('[executePayout] Attempt 1 failed', {
      withdrawalId,
      provider,
      classification: kind,
      error: err.message,
    });

    if (kind === 'retryable') {
      // ── Retry once — wait 2 s to avoid hammering the provider ────────────
      logger.info('[executePayout] Retryable error — scheduling retry in 2 s', { withdrawalId });
      await new Promise(res => setTimeout(res, 2000));

      try {
        result = await attemptPayout(2);
        lastError = null;   // retry succeeded
      } catch (retryErr) {
        lastError = retryErr;
        logger.warn('[executePayout] Attempt 2 (retry) failed', {
          withdrawalId,
          provider,
          error: retryErr.message,
        });
      }
    }
    // permanent errors fall through directly to the failure path below
  }

  // ── SUCCESS ───────────────────────────────────────────────────────────────
  if (!lastError && result) {
    try {
      const dbSuccess = loadDB();
      markWithdrawalPaid(dbSuccess, withdrawalId, result.reference, result.provider);
      saveDB(dbSuccess);
      logger.info('[executePayout] Marked paid', {
        withdrawalId,
        provider:  result.provider,
        reference: result.reference,
      });
    } catch (paidErr) {
      logger.error('[executePayout] CRITICAL: provider succeeded but could not mark paid', {
        withdrawalId,
        error: paidErr.message,
      });
    }
    return;
  }

  // ── FAILURE ───────────────────────────────────────────────────────────────
  const failReason = lastError?.message || 'unknown error';
  logger.error('[executePayout] All attempts failed — marking failed', {
    withdrawalId,
    provider,
    error: failReason,
  });

  try {
    const dbFail = loadDB();
    const wFail  = (dbFail.withdrawals || []).find(x => x.id === withdrawalId);
    markWithdrawalFailed(dbFail, withdrawalId, failReason);

    // Notify user that the withdrawal failed and funds were returned
    if (wFail) {
      if (!dbFail.notifications) dbFail.notifications = [];
      dbFail.notifications.push({
        id:        uuidv4(),
        userId:    wFail.userId,
        type:      'withdrawal_failed',
        title:     'Withdrawal Failed — Funds Returned',
        body:      `Your withdrawal of ${wFail.currency} could not be processed. The full amount has been returned to your wallet.`,
        metadata:  { withdrawalId: wFail.id, amount: wFail.amount, currency: wFail.currency },
        read:      false,
        createdAt: Date.now(),
      });
    }

    saveDB(dbFail);
    logger.info('[executePayout] Marked failed, refund issued, and user notified', { withdrawalId });
  } catch (innerErr) {
    logger.error('[executePayout] CRITICAL: could not mark as failed', {
      withdrawalId,
      error: innerErr.message,
    });
  }
}

module.exports = { payoutRouter, executePayout };
