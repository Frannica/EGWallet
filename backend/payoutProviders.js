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
const { decryptPII } = require('./piiCipher');

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

  // Two env vars are required before Stripe payouts are enabled:
  //   STRIPE_CONNECT_READY=true   — operator confirms Connect integration is complete
  //   STRIPE_CONNECT_ACCOUNT      — the connected account ID (acct_xxx) that holds the
  //                                 user's external bank account as a payout destination
  //
  // STRIPE_CONNECT_READY alone is NOT sufficient: stripe.payouts.create() without a
  // destination routes funds to the platform's default external account, not the user's
  // bank — permanent user fund loss.  Both guards must be satisfied before any HTTP call.
  if (!process.env.STRIPE_CONNECT_READY) {
    throw new Error('Stripe payout destination not configured — set STRIPE_CONNECT_READY=true once Stripe Connect is wired');
  }
  if (!process.env.STRIPE_CONNECT_ACCOUNT) {
    throw new Error('Stripe Connect account not configured — set STRIPE_CONNECT_ACCOUNT=acct_xxx to specify the payout destination');
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

  // Pass egw-<id> as idempotency key: Stripe returns the same payout object for
  // the same key within 24 h, so a blind retry after a timeout cannot double-disburse.
  // destination routes the payout to the user's external account on the connected
  // account rather than the platform's default external account.
  const payout = await stripeClient.payouts.create(
    {
      amount,
      currency,
      method,
      destination:  process.env.STRIPE_CONNECT_ACCOUNT,
      description:  `EGWallet withdrawal ${w.id}`,
      metadata: {
        withdrawalId: w.id,
        userId:       w.userId,
      },
    },
    { idempotencyKey: `egw-${w.id}` }
  );

  logger.info('[Stripe] Payout created', {
    withdrawalId: w.id,
    payoutId:     payout.id,
    status:       payout.status,
    arrival:      payout.arrival_date,
  });

  // Stripe payout statuses: paid | pending | in_transit | canceled | failed
  // C4 fix: only treat "paid" as settled. pending/in_transit means submitted to bank
  // but not confirmed — withdrawal must stay in "processing" until webhook/admin confirms.
  if (payout.status === 'failed' || payout.status === 'canceled') {
    throw new Error(`Stripe payout ${payout.id} status: ${payout.status}`);
  }

  const settled = payout.status === 'paid';
  if (!settled) {
    logger.info('[Stripe] Payout submitted but not yet settled — withdrawal stays processing', {
      withdrawalId: w.id,
      payoutId:     payout.id,
      status:       payout.status,
      arrival_date: payout.arrival_date,
    });
  }

  return {
    provider:  'stripe',
    reference: payout.id,
    settled,
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

  // Decrypt PII fields — they are AES-256-GCM encrypted at rest.
  // decryptPII() is a no-op passthrough for any unencrypted legacy value.
  const plainAccount = decryptPII(w.accountNumber)     || '';
  const plainHolder  = decryptPII(w.accountHolderName) || '';
  const plainBank    = decryptPII(w.bankName)           || '';

  const payload = {
    reference,
    destination: {
      type:      'bank_account',
      amount,
      currency:  w.currency,
      narration: `EGWallet withdrawal`,
      bank_account: {
        bank:         w.bankCode || plainBank,
        account:      plainAccount,
        account_name: plainHolder,
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
    // Axios throws on non-2xx; pull message from Kora's error body if present.
    // Preserve err.response on the re-thrown Error so isDefinitiveProviderRejection
    // can inspect the HTTP status — a plain `new Error(string)` drops that metadata
    // and would cause the failure path to treat every Kora 4xx as ambiguous.
    const koraMsg   = err.response?.data?.message || err.message;
    const wrapped   = new Error(`Kora API error: ${koraMsg}`);
    wrapped.response = err.response;   // keep Axios response for 4xx status check
    throw wrapped;
  }

  const body = response.data;

  // Log only safe scalar fields — never the raw body.data object which can
  // contain bank account numbers, phone numbers, or other payout PII.
  logger.info('[Kora] Disbursement response', {
    withdrawalId: w.id,
    status:       body.status,
    koraStatus:   body.data?.status,
    reference:    body.data?.transaction_reference || body.data?.reference,
  });

  if (!body.status) {
    // HTTP 200 but Kora's envelope status is false — the disbursement was explicitly
    // rejected in the response body (e.g. invalid account, insufficient balance).
    // Mark _definitiveRejection so isDefinitiveProviderRejection returns true and
    // the failure path issues a safe refund instead of leaving funds deadlocked.
    const bodyReject = new Error(`Kora disbursement failed: ${body.message || 'unknown error'}`);
    bodyReject._definitiveRejection = true;
    throw bodyReject;
  }

  const koraRef = body.data?.transaction_reference || body.data?.reference || reference;

  // C2: Only treat the payout as settled when Kora confirms final disbursement.
  // 'processing' / 'pending' mean the transfer is queued but not yet confirmed.
  const KORA_SETTLED_STATUSES = new Set(['success', 'completed']);
  const settled = KORA_SETTLED_STATUSES.has((body.data?.status || '').toLowerCase());
  if (!settled) {
    logger.info('[Kora] Disbursement accepted but not yet settled — withdrawal stays processing', {
      withdrawalId: w.id,
      koraRef,
      status: body.data?.status,
    });
  }

  return {
    provider:  'kora',
    reference: koraRef,
    settled,
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

// ─── Pre-HTTP config error detector ──────────────────────────────────────────
// Returns true when the error was thrown synchronously BEFORE any HTTP call was
// made to the provider (e.g. Stripe Connect not configured, missing API key).
// Used by the failure path to decide whether payoutDispatchRef should be cleared
// so a safe refund can be issued — the provider was never actually contacted.
function isPreHttpConfigError(msg) {
  const m = (msg || '').toLowerCase();
  return m.includes('not configured') || m.includes('integration required');
}

// ─── Definitive provider rejection detector ───────────────────────────────────
// Returns true when the provider HTTP call *completed* and the provider returned
// an explicit rejection (4xx), confirming the disbursement was NEVER created.
// In this case there is zero double-disbursement risk from clearing payoutDispatchRef
// and issuing a wallet refund.
//
// Distinct from ambiguous outcomes (timeout, 5xx, network error) where the provider
// may have accepted the request before returning an error — those must go to reconcile.
//
// Stripe: SDK sets err.type; only the definitively-rejected types qualify.
//   StripeConnectionError / StripeAPIError are network/5xx — ambiguous, excluded.
// Kora / generic: HTTP 4xx response with a body (err.response present).
//   429 rate-limit is retryable/ambiguous — excluded.
function isDefinitiveProviderRejection(err) {
  if (!err) return false;

  // Kora HTTP-200 body rejection (body.status === false) — the provider explicitly
  // rejected the disbursement in its response body.  Stamped by koraPayout above.
  if (err._definitiveRejection) return true;

  // Stripe SDK types that confirm the request was invalid / definitively rejected.
  // StripeConnectionError / StripeAPIError are network/5xx — excluded (ambiguous).
  const STRIPE_DEFINITIVE = new Set([
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeCardError',
  ]);
  if (err.type && STRIPE_DEFINITIVE.has(err.type)) return true;

  // Axios / HTTP 4xx with a provider response body (request completed, rejected).
  // err.response is now preserved on Kora re-throws so this also catches Kora 4xx.
  // 429 rate-limit is retryable/ambiguous — excluded.
  const status = err.response?.status;
  if (status && status >= 400 && status <= 499 && status !== 429) return true;

  return false;
}

// ─── Per-withdrawal in-flight lock (single-process) ──────────────────────────
// Prevents concurrent executePayout calls for the same withdrawal within one process.
// Startup sweep + admin trigger can both fire setImmediate for the same withdrawalId;
// the second call exits immediately instead of duplicating the provider HTTP request.
const _payoutInFlight = new Set();

// ─── DB-level advisory payout lock ───────────────────────────────────────────
// TTL-keyed record written to db.payoutLocks atomically with payoutDispatchRef
// inside withBalanceMutex.  Provides a second defence layer for shared-filesystem
// multi-process scenarios where _payoutInFlight is per-process.
// The _dbVersion check in saveDB provides the CAS guarantee for concurrent writes.
const PAYOUT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 min > 2 × 30 s timeout + retry

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
async function executePayout(withdrawalId, loadDB, saveDB, logger, withBalanceMutex) {
  // H-3: Single-process duplicate guard — second call for the same withdrawal exits immediately.
  if (_payoutInFlight.has(withdrawalId)) {
    logger.warn('[executePayout] Already in-flight for this withdrawal — skipping duplicate invocation', { withdrawalId });
    return;
  }
  _payoutInFlight.add(withdrawalId);

  try {
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

  // M-2: If the provider already accepted this withdrawal (payoutReference set), never
  // call the provider again — doing so would cause a double disbursement.
  if (w.payoutReference) {
    logger.warn('[executePayout] payoutReference already set — skipping provider call to prevent double disbursement', {
      withdrawalId,
      payoutReference: w.payoutReference,
    });
    return;
  }

  // Defence-in-depth: payoutDispatchRef is written to DB immediately before every
  // provider HTTP call.  If it is set but payoutReference is still null, a previous
  // executePayout invocation already contacted (or tried to contact) the provider and
  // did not receive a confirmed reference back.  Calling the provider again here risks
  // double disbursement.  Leave the withdrawal in processing and require admin reconcile.
  // This guard specifically catches duplicate admin-triggered invocations (e.g. two rapid
  // POST /transition requests) that slip past the _payoutInFlight Set after the first
  // run completes.
  if (w.payoutDispatchRef) {
    logger.warn('[executePayout] payoutDispatchRef already set but payoutReference absent — provider may have been contacted; leaving processing for reconcile', {
      withdrawalId,
      payoutDispatchRef: w.payoutDispatchRef,
      hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
    });
    return;
  }

  // M-3: Attempt cap — refund holdBalance and mark failed instead of leaving funds locked.
  // H-1: Only auto-refund when payoutDispatchRef is absent (provider was never contacted).
  //      If payoutDispatchRef is set, the HTTP call was at least initiated — we cannot know
  //      the provider outcome without querying them. Leave processing and require reconciliation.
  const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
  if (w.payoutAttempts >= MAX_ATTEMPTS) {
    if (w.payoutDispatchRef) {
      logger.error('[executePayout] Attempt cap reached but provider was already contacted — leaving processing for manual reconciliation', {
        withdrawalId,
        payoutAttempts:    w.payoutAttempts,
        payoutDispatchRef: w.payoutDispatchRef,
        hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
      });
      return; // do NOT refund — outcome unknown
    }

    logger.warn('[executePayout] Attempt cap reached (no dispatch yet) — marking failed and refunding hold', {
      withdrawalId,
      payoutAttempts: w.payoutAttempts,
    });
    const runCap = withBalanceMutex ? withBalanceMutex : (fn) => fn();
    try {
      await runCap(async () => {
        const dbCap = loadDB();
        markWithdrawalFailed(dbCap, withdrawalId, 'payout attempt cap reached');
        saveDB(dbCap);
      });
    } catch (capErr) {
      logger.error('[executePayout] Attempt-cap markWithdrawalFailed failed — retrying in 500 ms', {
        withdrawalId, error: capErr.message,
      });
      // Mirror the main failure-path retry: wait 500 ms, try once more with a fresh load.
      try {
        await new Promise(r => setTimeout(r, 500));
        await runCap(async () => {
          const dbCapRetry = loadDB();
          markWithdrawalFailed(dbCapRetry, withdrawalId, 'payout attempt cap reached');
          saveDB(dbCapRetry);
        });
        logger.info('[executePayout] Attempt-cap retry succeeded — marked failed', { withdrawalId });
      } catch (capRetryErr) {
        // Both attempts failed.  Stamp a minimal marker (no balance mutation) so
        // admin tooling or startup sweep can issue the refund via /transition.
        logger.error('[executePayout] CRITICAL: attempt-cap retry also failed — stamping reconcile marker', {
          withdrawalId, error: capRetryErr.message,
        });
        try {
          await new Promise(r => setTimeout(r, 500));
          const dbMarker = loadDB();
          const wMarker  = (dbMarker.withdrawals || []).find(x => x.id === withdrawalId);
          if (wMarker && wMarker.status === 'processing' && !wMarker.holdReleased) {
            wMarker.reconcileRequired = true;
            wMarker.reconcileNote     =
              `Attempt cap reached but markWithdrawalFailed could not be persisted at ${Date.now()}. ` +
              `Refund required: POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`;
            saveDB(dbMarker);
            logger.warn('[executePayout] Attempt-cap reconcile marker persisted', {
              withdrawalId,
              hint: `POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`,
            });
          }
        } catch (markerErr) {
          logger.error('[executePayout] EMERGENCY: could not stamp attempt-cap marker — MANUAL REFUND REQUIRED', {
            withdrawalId,
            userId:      w.userId,
            walletId:    w.walletId,
            currency:    w.currency,
            amountMinor: w.amount,
            action:      'Mark withdrawal failed and refund holdBalance manually',
            error:       markerErr.message,
          });
        }
      }
    }
    return;
  }

  const provider = payoutRouter(w.country);
  logger.info('[executePayout] Routing to provider', { withdrawalId, provider, country: w.country });

  // C5: All saves now use the full version check so that multi-instance conflicts
  // fail noisily (DB_VERSION_CONFLICT error logged) instead of silently overwriting
  // concurrent balance mutations from another pod. On single-instance deployments
  // (the current setup) the mutex ensures the version always matches.
  const saveDBFast = saveDB;

  // ── Demo mode: no provider configured → simulate a successful payout ─────
  // Consistent with the deposit system which also uses demo mode when Stripe
  // is not configured.  Logged clearly so it is easy to spot in production.
  const isDemoMode =
    (provider === 'stripe' && !stripeClient) ||
    (provider === 'kora'   && !process.env.KORA_API_KEY);

  if (isDemoMode) {
    logger.warn('[executePayout] DEMO MODE — no payment provider configured', { withdrawalId, provider });
    if (process.env.NODE_ENV === 'production') {
      logger.error('[executePayout] PRODUCTION: refusing to simulate payout — configure STRIPE_SECRET_KEY or KORA_API_KEY. Withdrawal stays pending for manual admin review.', { withdrawalId });
      return; // withdrawal stays pending — no ledger mutation
    }
    // Dev / staging only: simulate a successful payout
    try {
      const dbDemo = loadDB();
      markWithdrawalPaid(dbDemo, withdrawalId, `DEMO-${withdrawalId.slice(0, 8)}`, 'demo');
      saveDBFast(dbDemo);
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
    // Atomically claim the dispatch slot under withBalanceMutex:
    //   1. Fresh loadDB to see the latest state.
    //   2. Duplicate guards (holdReleased, and on attempt 1 only: payoutDispatchRef).
    //   3. Write payoutAttempts + payoutDispatchRef + payoutProvider → saveDB.
    //
    // Wrapping in withBalanceMutex ensures that even on multi-pod deployments, only
    // one executor can write payoutDispatchRef.  The second pod's claim will find
    // payoutDispatchRef already set on attempt 1 and throw _permanent, preventing a
    // concurrent double-disbursement before the HTTP call is made.
    //
    // The provider HTTP call happens OUTSIDE the mutex — it can take up to 30 s and
    // must not block other balance mutations for that duration.
    let wSnapshot;
    const runClaim = withBalanceMutex ? withBalanceMutex : (fn) => fn();

    await runClaim(async () => {
      const dbAttempt = loadDB();
      const wAttempt  = (dbAttempt.withdrawals || []).find(x => x.id === withdrawalId);
      if (!wAttempt) throw new Error('Withdrawal disappeared before attempt');
      if (wAttempt.holdReleased) throw Object.assign(
        new Error('Hold already released — duplicate payout guard'),
        { _permanent: true }
      );
      // On the first attempt only: atomically acquire the DB-level advisory lock and
      // set payoutDispatchRef.  Both changes are persisted in the same saveDB call so
      // the _dbVersion check acts as a compare-and-swap — a concurrent process that
      // read the same version will get a DB_VERSION_CONFLICT on its own saveDB and
      // abort safely.
      if (attemptNumber === 1) {
        // Initialise and clean expired locks.
        if (!dbAttempt.payoutLocks) dbAttempt.payoutLocks = [];
        const now = Date.now();
        dbAttempt.payoutLocks = dbAttempt.payoutLocks.filter(l => l.expiresAt > now);

        // If payoutDispatchRef is already set, another process has started this payout.
        if (wAttempt.payoutDispatchRef) {
          throw Object.assign(
            new Error('payoutDispatchRef already set by concurrent process — aborting to prevent double-disbursement'),
            { _permanent: true }
          );
        }

        // If an active advisory lock exists, another process is in the dispatch window.
        const activeLock = dbAttempt.payoutLocks.find(l => l.withdrawalId === withdrawalId);
        if (activeLock) {
          throw Object.assign(
            new Error(`Advisory payout lock held by pid ${activeLock.pid} — aborting concurrent dispatch`),
            { _permanent: true }
          );
        }

        // Acquire lock and set dispatch ref — saved atomically below.
        dbAttempt.payoutLocks.push({
          withdrawalId,
          pid:       process.pid,
          claimedAt: now,
          expiresAt: now + PAYOUT_LOCK_TTL_MS,
        });
      }
      wAttempt.payoutAttempts    = attemptNumber;
      wAttempt.payoutDispatchRef = `egw-${withdrawalId}`; // deterministic — same across retries
      wAttempt.payoutProvider    = provider;              // persist now so reconcile routes correctly after crash
      saveDBFast(dbAttempt);
      wSnapshot = wAttempt; // capture for provider call below
    });

    logger.info('[executePayout] Dispatch claimed', { withdrawalId, attemptNumber, provider,
      payoutDispatchRef: wSnapshot.payoutDispatchRef });

    // Provider HTTP call outside the mutex.
    let result;
    if (provider === 'stripe') {
      result = await stripePayout(wSnapshot, logger);
    } else {
      result = await koraPayout(wSnapshot, logger);
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
      logger.info('[executePayout] Retryable error — scheduling retry in 2 s', { withdrawalId });
      await new Promise(res => setTimeout(res, 2000));

      if (provider === 'kora') {
        // ── Kora: query status before any retry to prevent double-disbursement ──
        // payoutDispatchRef ('egw-<id>') was persisted before attempt 1's HTTP call.
        // If that call timed out but Kora silently received it, a second POST would
        // double-disburse.  Query first; only allow re-POST when provider confirms
        // the transaction is absent.  Stripe uses idempotencyKey so is safe to retry.
        const KORA_API_KEY  = process.env.KORA_API_KEY;
        const dispatchRef   = `egw-${withdrawalId}`;
        let koraQueryStatus = 'unknown';
        let koraQueryRef    = null;

        try {
          const statusResp = await axios.get(
            `https://api.korapay.com/merchant/api/v1/transactions/${dispatchRef}`,
            { headers: { Authorization: `Bearer ${KORA_API_KEY}` }, timeout: 15_000 }
          );
          const data      = statusResp.data?.data || {};
          koraQueryRef    = data.transaction_reference || data.reference || dispatchRef;
          koraQueryStatus = (data.status || '').toLowerCase();
        } catch (qErr) {
          koraQueryStatus = qErr.response?.status === 404 ? 'notfound' : 'queryerror';
          logger.warn('[executePayout] Kora pre-retry status query failed', {
            withdrawalId, dispatchRef, error: qErr.message, koraQueryStatus,
          });
        }

        logger.info('[executePayout] Kora pre-retry status query result', {
          withdrawalId, dispatchRef, koraQueryStatus, koraQueryRef,
        });

        const KORA_SETTLED_S = new Set(['success', 'completed']);
        const KORA_FAILED_S  = new Set(['failed', 'reversed', 'cancelled']);
        const KORA_PENDING_S = new Set(['pending', 'processing']);

        if (KORA_SETTLED_S.has(koraQueryStatus)) {
          // Attempt 1 was accepted AND already settled — treat as success, skip retry.
          logger.info('[executePayout] Kora pre-retry: already settled — using query result, skipping retry', {
            withdrawalId, koraQueryRef,
          });
          result    = { provider: 'kora', reference: koraQueryRef, settled: true };
          lastError = null;

        } else if (KORA_PENDING_S.has(koraQueryStatus)) {
          // Attempt 1 accepted and pending settlement — do NOT re-POST.
          // Leave processing; webhook or admin reconcile will confirm later.
          logger.info('[executePayout] Kora pre-retry: transaction pending — leaving processing, skipping retry', {
            withdrawalId, koraQueryRef,
          });
          result    = { provider: 'kora', reference: koraQueryRef, settled: false };
          lastError = null;

        } else if (KORA_FAILED_S.has(koraQueryStatus)) {
          // Provider confirmed failure — safe to refund.
          // Clear payoutDispatchRef so the failure path below can call markWithdrawalFailed.
          logger.warn('[executePayout] Kora pre-retry: provider confirmed failure — clearing payoutDispatchRef for safe refund, skipping retry', {
            withdrawalId, koraQueryStatus,
          });
          try {
            const dbClear = loadDB();
            const wClear  = (dbClear.withdrawals || []).find(x => x.id === withdrawalId);
            if (wClear) { wClear.payoutDispatchRef = null; saveDB(dbClear); }
          } catch (clearErr) {
            // If the clear fails, payoutDispatchRef stays set → failure path will leave
            // processing for manual reconcile rather than auto-refunding.  Safe.
            logger.error('[executePayout] Could not clear payoutDispatchRef after confirmed Kora failure', {
              withdrawalId, error: clearErr.message,
            });
          }
          // lastError stays set; failure path will call markWithdrawalFailed → refund.

        } else {
          // notfound (404) or queryerror or unrecognised status.
          // Conservative: do NOT re-POST — cannot confirm the transaction is absent.
          // payoutDispatchRef is set → failure path leaves processing for admin reconcile.
          logger.warn('[executePayout] Kora pre-retry: transaction not found or query failed — skipping retry, leaving processing for reconcile', {
            withdrawalId, koraQueryStatus,
          });
          // lastError stays set; failure path sees payoutDispatchRef → no auto-refund.
        }

      } else {
        // ── Stripe: idempotencyKey = 'egw-<id>' on payouts.create ensures idempotency ──
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
    }
    // permanent errors fall through directly to the failure path below
  }

  // ── SUCCESS ───────────────────────────────────────────────────────────────
  if (!lastError && result) {
    // Only mark paid when the provider confirms funds have been disbursed.
    // Stripe: settled=true only when status='paid'. pending/in_transit → false.
    // Kora:   settled=true only when status='success'/'completed'. pending/processing → false.
    // Any provider that omits settled is treated as NOT settled (fail-safe).
    if (!result.settled) {
      // Persist the provider reference before returning so adminTransition can
      // detect that the provider already accepted the disbursement and block any
      // premature admin refund while the payout is in-flight.
      if (result.reference) {
        try {
          const dbRef = loadDB();
          const wRef  = (dbRef.withdrawals || []).find(x => x.id === withdrawalId);
          if (wRef) {
            wRef.payoutReference = result.reference;
            wRef.payoutProvider  = result.provider;
            saveDB(dbRef);
          }
        } catch (refErr) {
          logger.error('[executePayout] Could not persist provider reference', {
            withdrawalId,
            error: refErr.message,
          });
        }
      }
      logger.info('[executePayout] Payout submitted but not yet settled — withdrawal stays processing', {
        withdrawalId,
        provider:  result.provider,
        reference: result.reference,
      });
      return; // no markWithdrawalPaid — webhook or admin must confirm later
    }

    // Run inside withBalanceMutex so a concurrent write cannot trigger a version
    // conflict that leaves the withdrawal in 'processing' — which would later allow
    // an admin to issue a refund while the provider already disbursed funds.
    const runSuccess = withBalanceMutex ? withBalanceMutex : (fn) => fn();
    try {
      await runSuccess(async () => {
        const dbSuccess = loadDB();
        // Pre-set reference before markWithdrawalPaid so it is captured in the
        // same saveDB write. If markWithdrawalPaid throws (e.g. duplicate-guard),
        // the reference is already present thanks to the payoutAttempts > 0 backstop.
        const wForRef = (dbSuccess.withdrawals || []).find(x => x.id === withdrawalId);
        if (wForRef && !wForRef.payoutReference) {
          wForRef.payoutReference = result.reference;
          wForRef.payoutProvider  = result.provider;
        }
        markWithdrawalPaid(dbSuccess, withdrawalId, result.reference, result.provider);
        saveDB(dbSuccess); // full version-checked save inside mutex
        logger.info('[executePayout] Marked paid', {
          withdrawalId,
          provider:  result.provider,
          reference: result.reference,
        });
      });
    } catch (paidErr) {
      logger.error('[executePayout] CRITICAL: provider settled but could not mark paid — retrying in 500 ms', {
        withdrawalId,
        error: paidErr.message,
      });
      // Retry with a fresh DB load. markWithdrawalPaid is guarded by holdReleased so
      // if the first attempt partially persisted, the retry is a safe no-op.
      // runSuccess has released the mutex (its promise rejected), so re-entering is safe.
      try {
        await new Promise(r => setTimeout(r, 500));
        await runSuccess(async () => {
          const dbRetry = loadDB();
          const wRetry  = (dbRetry.withdrawals || []).find(x => x.id === withdrawalId);
          if (wRetry && !wRetry.payoutReference) {
            wRetry.payoutReference = result.reference;
            wRetry.payoutProvider  = result.provider;
          }
          markWithdrawalPaid(dbRetry, withdrawalId, result.reference, result.provider);
          saveDB(dbRetry);
        });
        logger.info('[executePayout] Retry succeeded — marked paid', {
          withdrawalId, provider: result.provider, reference: result.reference });
      } catch (retryErr) {
        logger.error('[executePayout] CRITICAL: retry also failed — attempting emergency audit marker', {
          withdrawalId, error: retryErr.message, payoutReference: result.reference,
        });

        // C-2: Both full markWithdrawalPaid+saveDB attempts failed.
        // Provider confirmed settlement — funds already disbursed.
        // Do NOT call provider again. Do NOT refund. Do NOT call markWithdrawalPaid again.
        // Stamp a minimal marker so the admin /reconcile endpoint can complete the
        // transition once DB I/O recovers, without any risk of double-payment.
        try {
          await new Promise(r => setTimeout(r, 500));
          const dbEmergency = loadDB();
          const wEmergency  = (dbEmergency.withdrawals || []).find(x => x.id === withdrawalId);
          // Only stamp if the withdrawal is still in processing and hold not yet released.
          // If holdReleased is already true a previous partial write succeeded — skip.
          if (wEmergency && wEmergency.status === 'processing' && !wEmergency.holdReleased) {
            wEmergency.reconcileRequired = true;
            wEmergency.payoutReference   = result.reference;
            wEmergency.payoutProvider    = result.provider;
            wEmergency.reconcileNote     =
              `Provider settled at ${Date.now()} but markWithdrawalPaid could not be persisted. ` +
              `Manual reconcile required: POST /admin/withdrawals/${withdrawalId}/reconcile`;
            saveDB(dbEmergency); // minimal stamp — no hold mutation, no ledger write, no status change
            logger.warn('[executePayout] Emergency audit marker persisted — /reconcile will complete the transition', {
              withdrawalId,
              payoutReference: result.reference,
              reconcileEndpoint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
            });
          }
        } catch (emergencyErr) {
          // Last resort — log every field an operator needs for manual DB repair.
          // `w` is the withdrawal snapshot loaded at the top of executePayout.
          logger.error('[executePayout] EMERGENCY: could not persist audit marker — MANUAL DB REPAIR REQUIRED', {
            withdrawalId,
            userId:          w.userId,
            walletId:        w.walletId,
            currency:        w.currency,
            amountMinor:     w.amount,
            payoutReference: result.reference,
            payoutProvider:  result.provider,
            action:          'Set reconcileRequired=true, payoutReference, payoutProvider on the withdrawal record, then POST /admin/withdrawals/' + withdrawalId + '/reconcile',
            emergencyError:  emergencyErr.message,
          });
        }
      }
    }
    return;
  }

  // ── FAILURE ───────────────────────────────────────────────────────────────
  // H-1: Only issue a wallet refund when the provider was never contacted.
  //      payoutDispatchRef is persisted to DB just before every HTTP call, so its
  //      presence means the provider may have accepted the funds.  In that case
  //      leave the withdrawal in 'processing' and require manual reconciliation —
  //      issuing a refund while the bank transfer is in-flight would double-pay.
  const failReason = lastError?.message || 'unknown error';
  logger.error('[executePayout] All attempts failed', { withdrawalId, provider, error: failReason });

  const runFail = withBalanceMutex ? withBalanceMutex : (fn) => fn();

  // Flag set inside the mutex when the guard fires; used to suppress misleading logs.
  let reconcileRequired = false;

  try {
    await runFail(async () => {
      const dbFail = loadDB();
      const wFail  = (dbFail.withdrawals || []).find(x => x.id === withdrawalId);

      // Guard: provider was contacted (payoutDispatchRef is set) — three cases:
      //
      //  1. Definitive 4xx rejection: HTTP call completed, provider explicitly rejected
      //     the request (invalid bank details, auth error, etc.).  The disbursement was
      //     NEVER created — zero double-disbursement risk.  Clear payoutDispatchRef and
      //     allow the refund.
      //
      //  2. Pre-HTTP config error: error thrown before any HTTP call (e.g. Stripe Connect
      //     not configured).  payoutDispatchRef was written spuriously — clear and refund.
      //
      //  3. Ambiguous (timeout, 5xx, network): the provider may have accepted the request.
      //     Do NOT refund.  Leave processing and require admin reconcile.
      if (wFail?.payoutDispatchRef) {
        const isDefinitive = isDefinitiveProviderRejection(lastError);
        const isConfigErr  = isPreHttpConfigError(failReason);

        if (!isDefinitive && !isConfigErr) {
          // Ambiguous outcome — outcome unknown, do not auto-refund.
          logger.error('[executePayout] Provider was contacted but outcome is unknown — leaving processing for reconciliation', {
            withdrawalId,
            failReason,
            payoutDispatchRef: wFail.payoutDispatchRef,
            hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
          });
          reconcileRequired = true;
          return; // do NOT call markWithdrawalFailed
        }

        if (isDefinitive) {
          // Definitive 4xx: disbursement was never created — safe to refund.
          logger.warn('[executePayout] Definitive provider rejection — clearing payoutDispatchRef for safe refund', {
            withdrawalId,
            failReason,
            httpStatus:      lastError?.response?.status,
            stripeErrorType: lastError?.type,
          });
        } else {
          // Pre-HTTP config error — provider was never actually called.
          logger.warn('[executePayout] Clearing payoutDispatchRef — error was pre-HTTP configuration failure, no provider contact', {
            withdrawalId, failReason,
          });
        }
        wFail.payoutDispatchRef = null;
      }

      // C-1: A concurrent path (another pod, startup sweep, or admin trigger) may
      // have received a successful provider response and written payoutReference
      // between our dispatch attempt and now.  If so, the disbursement is real —
      // do NOT refund.  Leave processing and require admin reconcile.
      if (wFail?.payoutReference) {
        logger.warn('[executePayout] payoutReference set by concurrent path — provider accepted disbursement; not refunding, leaving for reconcile', {
          withdrawalId,
          payoutReference: wFail.payoutReference,
          hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
        });
        reconcileRequired = true;
        return;
      }

      markWithdrawalFailed(dbFail, withdrawalId, failReason);

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
    });

    if (!reconcileRequired) {
      logger.info('[executePayout] Marked failed, refund issued, and user notified', { withdrawalId });
    }
  } catch (innerErr) {
    if (reconcileRequired) return; // guard returned cleanly — should not reach here

    logger.error('[executePayout] CRITICAL: could not mark as failed — retrying once in 500 ms', {
      withdrawalId,
      error: innerErr.message,
    });
    // Retry with a fresh DB load. refundIssued was never persisted (saveDB threw), so the
    // fresh load sees refundIssued:false and markWithdrawalFailed is safe to run again.
    // runFail has released the mutex (its promise rejected), so re-entering is safe.
    try {
      await new Promise(r => setTimeout(r, 500));
      await runFail(async () => {
        const dbRetry = loadDB();
        const wRetry  = (dbRetry.withdrawals || []).find(x => x.id === withdrawalId);
        if (wRetry?.payoutDispatchRef) {
          // Mirror the primary failure-path guard: clear payoutDispatchRef only for
          // definitive rejections and pre-HTTP config errors.  Ambiguous outcomes
          // (timeout, 5xx, network) still require manual reconcile.
          const canClear =
            isPreHttpConfigError(failReason) ||
            isDefinitiveProviderRejection(lastError);
          if (!canClear) {
            reconcileRequired = true;
            return;
          }
          wRetry.payoutDispatchRef = null;
        }
        // C-1 mirror: same payoutReference guard as the primary block.
        if (wRetry?.payoutReference) {
          logger.warn('[executePayout] Retry: payoutReference set by concurrent path — not refunding, leaving for reconcile', {
            withdrawalId, payoutReference: wRetry.payoutReference,
            hint: `POST /admin/withdrawals/${withdrawalId}/reconcile`,
          });
          reconcileRequired = true;
          return;
        }
        markWithdrawalFailed(dbRetry, withdrawalId, failReason);
        saveDB(dbRetry);
      });
      if (!reconcileRequired) {
        logger.info('[executePayout] Retry succeeded — marked failed and refund issued', { withdrawalId });
      }
    } catch (retryErr) {
      if (reconcileRequired) {
        // payoutDispatchRef was set — provider may have been contacted.
        // Already logged above; do not issue emergency refund marker here.
        return;
      }
      logger.error('[executePayout] CRITICAL: retry also failed — attempting emergency failure marker', {
        withdrawalId, error: retryErr.message,
      });
      // Provider was never contacted (payoutDispatchRef absent) but both
      // markWithdrawalFailed + saveDB attempts failed.  Stamp a minimal marker
      // (no balance mutation) so admin tooling can issue the refund via /transition.
      // Mirrors the settled-success emergency audit marker path.
      try {
        await new Promise(r => setTimeout(r, 500));
        const dbFailEmergency = loadDB();
        const wFailEmergency  = (dbFailEmergency.withdrawals || []).find(x => x.id === withdrawalId);
        if (wFailEmergency && wFailEmergency.status === 'processing' && !wFailEmergency.holdReleased) {
          wFailEmergency.reconcileRequired = true;
          wFailEmergency.reconcileNote     =
            `Provider not contacted but markWithdrawalFailed could not be persisted at ${Date.now()}. ` +
            `Refund required: POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`;
          saveDB(dbFailEmergency);
          logger.warn('[executePayout] Emergency failure marker persisted — admin must refund via /transition', {
            withdrawalId,
            hint: `POST /admin/withdrawals/${withdrawalId}/transition { "status": "failed" }`,
          });
        }
      } catch (failEmergencyErr) {
        logger.error('[executePayout] EMERGENCY: could not persist failure marker — MANUAL REFUND REQUIRED', {
          withdrawalId,
          userId:      w.userId,
          walletId:    w.walletId,
          currency:    w.currency,
          amountMinor: w.amount,
          action:      'Mark withdrawal failed and refund holdBalance to user manually',
          error:       failEmergencyErr.message,
        });
      }
    }
  }

  } finally {
    _payoutInFlight.delete(withdrawalId);
    // Release the DB-level advisory lock.  Best-effort — the lock expires via TTL
    // if this write fails, so no funds are ever permanently blocked.
    try {
      const runRelease = withBalanceMutex ? withBalanceMutex : (fn) => fn();
      await runRelease(async () => {
        const dbRelease = loadDB();
        if (dbRelease.payoutLocks) {
          const before = dbRelease.payoutLocks.length;
          dbRelease.payoutLocks = dbRelease.payoutLocks.filter(
            l => !(l.withdrawalId === withdrawalId && l.pid === process.pid)
          );
          if (dbRelease.payoutLocks.length !== before) saveDB(dbRelease);
        }
      });
    } catch (_) { /* non-fatal — lock expires via PAYOUT_LOCK_TTL_MS */ }
  }
}

module.exports = { payoutRouter, executePayout };
