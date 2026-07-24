'use strict';
/**
 * stripeConnect.js
 *
 * Stripe Connect (Express accounts) integration for US/UK/European withdrawal
 * corridors that Kora does not cover.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPLIANCE — READ BEFORE ENABLING
 * ═══════════════════════════════════════════════════════════════════════════
 * A live query against this Stripe account (2026-07-24) confirmed:
 *   • Stripe Connect is technically provisioned (GET /v1/accounts → 200).
 *   • Stripe's own published Prohibited & Restricted Businesses policy
 *     (https://stripe.com/legal/restricted-businesses) lists:
 *       - PROHIBITED: "Peer-to-peer money transmission"
 *       - RESTRICTED (requires Stripe sales/compliance approval):
 *         "Money transmitters, remittances, currency exchange services, and
 *          other money service businesses"; "Neobanks or challenger banks";
 *         "Sale of stored value or credits maintained, accepted, and issued
 *          by anyone other than the seller."
 *   EGWallet — a stored-value peer-to-peer wallet with user withdrawals — is
 *   the exact business model these categories describe. Technical API access
 *   (this file) does NOT constitute business-model approval, which Stripe
 *   grants (or denies) out-of-band per account, and can modify or revoke at
 *   any time.
 *
 * Everything in this file is therefore gated behind STRIPE_CONNECT_ENABLED,
 * which MUST stay unset/false in production until EGWallet has confirmed,
 * documented approval from Stripe for this specific business model. With the
 * flag off, every function below is unreachable from any HTTP route, and
 * payoutRouter()/isPayoutProviderReady() behave EXACTLY as before this file
 * was added (see payoutProviders.js).
 * ═══════════════════════════════════════════════════════════════════════════
 */

const {
  getConnectAccountByUserId,
  getConnectAccountByStripeAccountId,
  insertConnectAccount,
  syncConnectAccountFromStripe,
  reserveConnectWebhookEvent,
  markConnectWebhookEventProcessed,
  deriveOnboardingStatus,
} = require('./db/stripeConnectPostgres');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripeClient = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

function isStripeConnectEnabled() {
  return process.env.STRIPE_CONNECT_ENABLED === 'true' && !!stripeClient;
}

/**
 * Explicit operator-maintained allow-list — ISO-2 country codes Stripe has
 * confirmed (via sales/dashboard) as approved Express-account destinations
 * for THIS platform's business model. Defaults to empty: setting
 * STRIPE_CONNECT_ENABLED=true with no countries configured activates zero
 * new corridors (fail-safe).
 */
function getApprovedCountries() {
  const raw = process.env.STRIPE_CONNECT_APPROVED_COUNTRIES || '';
  return new Set(
    raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  );
}

function isCountryStripeConnectApproved(country) {
  if (!isStripeConnectEnabled()) return false;
  const iso2 = (country || '').trim().toUpperCase();
  if (!iso2) return false;
  return getApprovedCountries().has(iso2);
}

// ─── Onboarding ───────────────────────────────────────────────────────────
/**
 * Creates (or returns the existing) Express connected account for a user,
 * then returns a fresh, single-use Account Link URL for Stripe-hosted
 * onboarding. Safe to call repeatedly — never creates a second Stripe
 * account for the same user (unique index on stripe_connect_accounts.user_id
 * plus an explicit existence check here).
 */
async function ensureConnectOnboardingLink({ userId, email, country, refreshUrl, returnUrl }) {
  if (!stripeClient) throw Object.assign(new Error('Stripe is not configured'), { status: 503 });
  if (!isStripeConnectEnabled()) {
    throw Object.assign(
      new Error('Stripe Connect withdrawals are not available yet for your region.'),
      { status: 503, errorCode: 'STRIPE_CONNECT_DISABLED' }
    );
  }
  const iso2 = (country || '').trim().toUpperCase();
  if (!isCountryStripeConnectApproved(iso2)) {
    throw Object.assign(
      new Error('Stripe withdrawals are not available for your country yet.'),
      { status: 400, errorCode: 'COUNTRY_NOT_SUPPORTED' }
    );
  }

  let existing = await getConnectAccountByUserId(userId);
  let stripeAccountId;

  if (existing) {
    stripeAccountId = existing.stripe_account_id;
  } else {
    const account = await stripeClient.accounts.create({
      type: 'express',
      country: iso2,
      email: email || undefined,
      capabilities: { transfers: { requested: true } },
      business_type: 'individual',
      metadata: { egwalletUserId: userId },
    });
    stripeAccountId = account.id;
    existing = await insertConnectAccount({ userId, stripeAccountId, country: iso2, email });
  }

  const accountLink = await stripeClient.accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });

  return { stripeAccountId, url: accountLink.url, expiresAt: accountLink.expires_at };
}

/** Fetches the latest status from Stripe and syncs it into Postgres. */
async function refreshConnectAccountStatus(userId) {
  const existing = await getConnectAccountByUserId(userId);
  if (!existing) return null;
  if (!stripeClient) return existing;

  const account = await stripeClient.accounts.retrieve(existing.stripe_account_id);
  const synced = await syncConnectAccountFromStripe(existing.stripe_account_id, account);
  return synced || existing;
}

/** Read-only status for the onboarding-status screen — no Stripe API call, DB only. */
async function getConnectAccountStatus(userId) {
  const row = await getConnectAccountByUserId(userId);
  if (!row) {
    return { exists: false, onboardingStatus: 'not_started', payoutsEnabled: false, chargesEnabled: false };
  }
  return {
    exists: true,
    onboardingStatus: row.onboarding_status,
    payoutsEnabled: row.payouts_enabled,
    chargesEnabled: row.charges_enabled,
    detailsSubmitted: row.details_submitted,
    currentlyDue: row.currently_due || [],
    disabledReason: row.disabled_reason || null,
    country: row.country,
  };
}

// ─── Payout (Transfer + Payout) ──────────────────────────────────────────────
const ZERO_DECIMAL_CONNECT = new Set(['JPY', 'KRW', 'VND', 'CLP']);
function toStripeConnectAmount(amount) {
  return Math.round(amount);
}

/**
 * Executes a Stripe Connect withdrawal for a withdrawal record already routed
 * to provider 'stripe_connect' (see payoutProviders.payoutRouter).
 *
 * Two-step "separate transfers" pattern, matching Stripe's own recommended
 * architecture for platforms that hold funds before paying out an individual
 * recipient (https://docs.stripe.com/connect/separate-charges-and-transfers):
 *   1. stripe.transfers.create() moves funds from the PLATFORM balance to the
 *      connected account's own Stripe balance. Idempotency key ties this to
 *      the withdrawal id so a retried call can never double-transfer.
 *   2. stripe.payouts.create() (called AS the connected account via the
 *      stripeAccount request option) immediately schedules a payout from
 *      that balance to the user's external bank account.
 *
 * CRITICAL SAFETY RULE: once step 1 (the transfer) succeeds, funds have
 * irreversibly left the platform balance. From that point on this function
 * NEVER throws — even if step 2 fails, we do not refund the user's EGWallet
 * balance (the money is safely held in the user's own connected-account
 * balance and Stripe's automatic payout schedule, enabled by default for
 * Express accounts once payouts_enabled=true, will still deliver it to their
 * bank without a duplicate transfer). The withdrawal simply stays
 * "processing" until the Stripe Connect webhook confirms payout.paid — this
 * mirrors exactly how Kora/legacy Stripe "not yet settled" results are
 * handled by executePayout().
 */
async function stripeConnectPayout(w, logger) {
  if (!stripeClient) {
    throw new Error('Stripe is not configured — STRIPE_SECRET_KEY is missing');
  }
  if (!isStripeConnectEnabled()) {
    const err = new Error('Stripe Connect withdrawals are not enabled — set STRIPE_CONNECT_ENABLED=true once approved by Stripe.');
    err._definitiveRejection = true; // no HTTP call made — safe to refund
    throw err;
  }

  const account = await getConnectAccountByUserId(w.userId);
  if (!account || account.onboarding_status !== 'complete' || !account.payouts_enabled) {
    const err = new Error(
      'Your bank account setup with Stripe is not complete yet. Please finish onboarding before withdrawing.'
    );
    err._definitiveRejection = true; // no HTTP call made — safe to refund
    throw err;
  }

  const currency = w.currency.toLowerCase();
  const amount = toStripeConnectAmount(w.netPayout);

  logger.info('[StripeConnect] Creating transfer', {
    withdrawalId: w.id, amount, currency, destination: account.stripe_account_id,
  });

  // Step 1 — platform balance → connected account balance. Errors here are
  // classified by the existing classifyError()/isDefinitiveProviderRejection()
  // machinery exactly like Kora/legacy Stripe — the transfer never succeeded,
  // so a definitive 4xx rejection is safe to refund.
  const transfer = await stripeClient.transfers.create(
    {
      amount,
      currency,
      destination: account.stripe_account_id,
      transfer_group: `egw-${w.id}`,
      metadata: { withdrawalId: w.id, userId: w.userId },
    },
    { idempotencyKey: `egw-connect-transfer-${w.id}` }
  );

  logger.info('[StripeConnect] Transfer created — funds left platform balance', {
    withdrawalId: w.id, transferId: transfer.id,
  });

  // Step 2 — connected account balance → their external bank account.
  // Deliberately swallow any error here (see safety rule in the doc comment
  // above): the transfer already succeeded, so this function must not throw.
  let payout = null;
  try {
    payout = await stripeClient.payouts.create(
      {
        amount,
        currency,
        metadata: { withdrawalId: w.id },
        description: `EGWallet withdrawal ${w.id}`,
      },
      { stripeAccount: account.stripe_account_id, idempotencyKey: `egw-connect-payout-${w.id}` }
    );
    logger.info('[StripeConnect] Payout created on connected account', {
      withdrawalId: w.id, payoutId: payout.id, status: payout.status,
    });
  } catch (payoutErr) {
    logger.warn('[StripeConnect] Explicit payout creation failed after transfer succeeded — relying on the connected account\'s automatic payout schedule; funds are safe in their Stripe balance', {
      withdrawalId: w.id, transferId: transfer.id, error: payoutErr.message,
    });
  }

  return {
    provider: 'stripe_connect',
    reference: payout ? payout.id : transfer.id,
    // Always false — payout.paid on /webhooks/stripe-connect is the only
    // event allowed to mark this withdrawal settled, matching the "only mark
    // paid on confirmed settlement" rule used for Kora/legacy Stripe.
    settled: false,
    raw: {
      transferId: transfer.id,
      payoutId: payout ? payout.id : null,
      connectedAccount: account.stripe_account_id,
    },
  };
}

// ─── Webhook signature verification ──────────────────────────────────────────
/**
 * Verifies a Stripe Connect platform webhook (registered as its own "Connect"
 * webhook destination in the dashboard — NOT the existing /webhooks/stripe
 * account-scoped endpoint) using STRIPE_CONNECT_WEBHOOK_SECRET.
 */
function constructConnectWebhookEvent(rawBody, signatureHeader) {
  if (!stripeClient) throw new Error('Stripe is not configured');
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not configured');
  return stripeClient.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

module.exports = {
  isStripeConnectEnabled,
  getApprovedCountries,
  isCountryStripeConnectApproved,
  ensureConnectOnboardingLink,
  refreshConnectAccountStatus,
  getConnectAccountStatus,
  stripeConnectPayout,
  constructConnectWebhookEvent,
  // Re-exported for the webhook route (idempotent event processing) and tests.
  getConnectAccountByStripeAccountId,
  syncConnectAccountFromStripe,
  reserveConnectWebhookEvent,
  markConnectWebhookEventProcessed,
  deriveOnboardingStatus,
};
