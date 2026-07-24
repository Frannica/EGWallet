'use strict';
/**
 * stripeConnectPostgres.js
 *
 * PostgreSQL persistence for Stripe Connect connected accounts (one Express
 * account per eligible user) and idempotent Stripe Connect webhook-event
 * processing.
 *
 * This module has ZERO effect on any existing flow — it is only ever called
 * from stripeConnect.js, which itself is gated end-to-end by
 * STRIPE_CONNECT_ENABLED (see the long compliance note in
 * backend/db/migrations/010_stripe_connect.sql and backend/stripeConnect.js).
 */

const { pool } = require('./pool');

/**
 * Derives EGWallet's onboarding_status from a Stripe Account object.
 *  - not_started:          should never be persisted (row only created once
 *                           the Stripe account itself exists) — kept for the
 *                           in-memory default before first sync.
 *  - restricted:            disabled_reason present (e.g. rejected.fraud,
 *                           requirements.past_due) — user must be told.
 *  - pending_verification:  details submitted, Stripe still verifying.
 *  - onboarding:            account created, hosted onboarding not finished.
 *  - complete:              charges_enabled && payouts_enabled && no
 *                           disabled_reason.
 */
function deriveOnboardingStatus(account) {
  if (!account) return 'not_started';
  const req = account.requirements || {};
  if (req.disabled_reason) return 'restricted';
  if (account.charges_enabled && account.payouts_enabled) return 'complete';
  if (account.details_submitted) return 'pending_verification';
  return 'onboarding';
}

async function getConnectAccountByUserId(userId) {
  const result = await pool.query(
    `SELECT id, user_id, stripe_account_id, country, email, charges_enabled,
            payouts_enabled, details_submitted, currently_due, eventually_due,
            disabled_reason, onboarding_status, created_at, updated_at
       FROM stripe_connect_accounts WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getConnectAccountByStripeAccountId(stripeAccountId) {
  const result = await pool.query(
    `SELECT id, user_id, stripe_account_id, country, email, charges_enabled,
            payouts_enabled, details_submitted, currently_due, eventually_due,
            disabled_reason, onboarding_status, created_at, updated_at
       FROM stripe_connect_accounts WHERE stripe_account_id = $1 LIMIT 1`,
    [stripeAccountId]
  );
  return result.rows[0] || null;
}

/** Creates the initial row right after stripe.accounts.create() succeeds. */
async function insertConnectAccount({ userId, stripeAccountId, country, email }) {
  const result = await pool.query(
    `INSERT INTO stripe_connect_accounts (user_id, stripe_account_id, country, email, onboarding_status)
     VALUES ($1, $2, $3, $4, 'onboarding')
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING id, user_id, stripe_account_id, country, email, charges_enabled,
               payouts_enabled, details_submitted, currently_due, eventually_due,
               disabled_reason, onboarding_status, created_at, updated_at`,
    [userId, stripeAccountId, country, email || null]
  );
  return result.rows[0];
}

/** Syncs charges/payouts/requirements from a fresh stripe.accounts.retrieve() response. */
async function syncConnectAccountFromStripe(stripeAccountId, account) {
  const req = account.requirements || {};
  const status = deriveOnboardingStatus(account);
  const result = await pool.query(
    `UPDATE stripe_connect_accounts SET
       charges_enabled = $2,
       payouts_enabled = $3,
       details_submitted = $4,
       currently_due = $5::jsonb,
       eventually_due = $6::jsonb,
       disabled_reason = $7,
       onboarding_status = $8,
       updated_at = NOW()
     WHERE stripe_account_id = $1
     RETURNING id, user_id, stripe_account_id, country, email, charges_enabled,
               payouts_enabled, details_submitted, currently_due, eventually_due,
               disabled_reason, onboarding_status, created_at, updated_at`,
    [
      stripeAccountId,
      !!account.charges_enabled,
      !!account.payouts_enabled,
      !!account.details_submitted,
      JSON.stringify(req.currently_due || []),
      JSON.stringify(req.eventually_due || []),
      req.disabled_reason || null,
      status,
    ]
  );
  return result.rows[0] || null;
}

// ─── Webhook event idempotency ───────────────────────────────────────────────
/**
 * Attempts to reserve processing of a Stripe Connect webhook event.
 * @returns {Promise<boolean>} true if this call reserved the event (caller
 *   should process it), false if it was already recorded (skip — duplicate
 *   delivery / retry from Stripe).
 */
async function reserveConnectWebhookEvent({ eventId, eventType, stripeAccountId }) {
  const result = await pool.query(
    `INSERT INTO stripe_connect_webhook_events (event_id, event_type, stripe_account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType, stripeAccountId || null]
  );
  return result.rowCount > 0;
}

async function markConnectWebhookEventProcessed(eventId) {
  await pool.query(
    `UPDATE stripe_connect_webhook_events SET processed_at = NOW() WHERE event_id = $1`,
    [eventId]
  );
}

module.exports = {
  deriveOnboardingStatus,
  getConnectAccountByUserId,
  getConnectAccountByStripeAccountId,
  insertConnectAccount,
  syncConnectAccountFromStripe,
  reserveConnectWebhookEvent,
  markConnectWebhookEventProcessed,
};
