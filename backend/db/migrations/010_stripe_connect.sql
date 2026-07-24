-- Stripe Connect connected accounts (one Express account per eligible user) for
-- officially-approved US/UK/European withdrawal corridors. Feature-flagged OFF
-- by default at the application layer (STRIPE_CONNECT_ENABLED) — this schema
-- can be deployed safely ahead of activation since it has zero runtime effect
-- until the flag is set and STRIPE_CONNECT_APPROVED_COUNTRIES is populated.
--
-- IMPORTANT: EGWallet's stored-value peer-to-peer wallet/withdrawal model falls
-- within Stripe's Restricted ("money transmitters, remittances... money service
-- businesses", "stored value") and Prohibited ("peer-to-peer money transmission")
-- Businesses policy (https://stripe.com/legal/restricted-businesses). This table
-- and the code that uses it must remain inert (STRIPE_CONNECT_ENABLED unset)
-- until Stripe has explicitly approved this business model for the account.
CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  stripe_account_id TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  email TEXT,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  currently_due JSONB NOT NULL DEFAULT '[]'::jsonb,
  eventually_due JSONB NOT NULL DEFAULT '[]'::jsonb,
  disabled_reason TEXT,
  -- not_started | onboarding | pending_verification | complete | restricted
  onboarding_status TEXT NOT NULL DEFAULT 'not_started',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_user_id_idx
  ON stripe_connect_accounts (user_id);

-- Idempotent, retry-safe processing of Stripe Connect platform webhook events.
-- This is a SEPARATE endpoint/secret from the existing /webhooks/stripe endpoint
-- (which only receives the platform account's own charge/payout events) — Connect
-- events are registered as their own webhook destination in the Stripe Dashboard
-- ("Connect" webhook, not "Account") and signed with STRIPE_CONNECT_WEBHOOK_SECRET.
CREATE TABLE IF NOT EXISTS stripe_connect_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  stripe_account_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stripe_connect_webhook_events_account_idx
  ON stripe_connect_webhook_events (stripe_account_id);
