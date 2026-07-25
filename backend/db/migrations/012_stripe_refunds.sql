-- Stripe refund-to-original-payment-method.
--
-- Money deposited via Stripe PaymentIntent can be returned ONLY to the original
-- payment method by creating a Stripe Refund against that PaymentIntent.
-- There is no user-supplied destination card — ever.
--
-- Lifecycle (all transitions atomic + auditable via status_history):
--   requested → pending → succeeded
--             ↘ failed / cancelled
--             ↘ requires_action → pending|succeeded|failed|cancelled
--
-- Wallet safety:
--   1. Atomic hold (available → wallet_holds) BEFORE stripe.refunds.create
--   2. Held funds cannot be spent (available balance already decremented)
--   3. On verified Stripe success: release hold without restoring balance
--   4. On failure/cancel: release hold AND restore available balance

CREATE TABLE IF NOT EXISTS refund_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  -- wallets.id was widened to TEXT in migration 009 (employer WALLET-<id> forms).
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  deposit_transaction_id UUID NOT NULL REFERENCES transactions(id),
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_refund_id TEXT UNIQUE,
  -- Wallet amount in minor units (portion of the deposit net credit being returned)
  amount BIGINT NOT NULL CHECK (amount > 0),
  -- Amount submitted to Stripe.refunds.create (minor units). May equal amount
  -- for zero-fee deposits, or the proportional/gross share for fee deposits.
  stripe_refund_amount BIGINT NOT NULL CHECK (stripe_refund_amount > 0),
  currency TEXT NOT NULL,
  -- requested | pending | requires_action | succeeded | failed | cancelled
  status TEXT NOT NULL DEFAULT 'requested',
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key TEXT NOT NULL,
  hold_placed BOOLEAN NOT NULL DEFAULT false,
  hold_released BOOLEAN NOT NULL DEFAULT false,
  wallet_debited BOOLEAN NOT NULL DEFAULT false,
  failure_reason TEXT,
  stripe_status TEXT,
  reconciliation_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS refund_requests_user_idx
  ON refund_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS refund_requests_deposit_idx
  ON refund_requests (deposit_transaction_id);
CREATE INDEX IF NOT EXISTS refund_requests_pi_idx
  ON refund_requests (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS refund_requests_status_idx
  ON refund_requests (status);

-- Durable idempotency for the main /webhooks/stripe endpoint (refund + charge
-- events). Mirrors stripe_connect_webhook_events from migration 010.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON stripe_webhook_events (event_type, received_at DESC);

-- Optional FK from ledger → refund_requests for reconciliation queries.
ALTER TABLE ledger
  ADD COLUMN IF NOT EXISTS refund_request_id UUID REFERENCES refund_requests(id);

CREATE INDEX IF NOT EXISTS ledger_refund_request_idx
  ON ledger (refund_request_id)
  WHERE refund_request_id IS NOT NULL;
