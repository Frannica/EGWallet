-- Lightspark Grid sandbox customer, account, quote, and webhook state.
-- No secrets are stored. Bank account numbers stay on withdrawals (encrypted)
-- or as masked display fields here.

CREATE TABLE IF NOT EXISTS grid_customers (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  grid_customer_id TEXT NOT NULL UNIQUE,
  platform_customer_id TEXT NOT NULL,
  kyc_status TEXT,
  customer_type TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  terms_version TEXT,
  terms_accepted_at TIMESTAMPTZ,
  terms_acceptance_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS grid_customers_grid_id_idx
  ON grid_customers (grid_customer_id);

CREATE TABLE IF NOT EXISTS grid_internal_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  grid_customer_id TEXT,
  grid_internal_account_id TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS grid_internal_accounts_user_idx
  ON grid_internal_accounts (user_id);

CREATE TABLE IF NOT EXISTS grid_external_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  grid_customer_id TEXT NOT NULL,
  grid_external_account_id TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL,
  status TEXT,
  account_mask TEXT,
  bank_name_display TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS grid_external_accounts_user_idx
  ON grid_external_accounts (user_id);

CREATE TABLE IF NOT EXISTS grid_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id UUID REFERENCES withdrawals(id),
  user_id UUID NOT NULL REFERENCES users(id),
  grid_quote_id TEXT UNIQUE,
  grid_transaction_id TEXT,
  status TEXT,
  sending_currency TEXT,
  receiving_currency TEXT,
  sending_amount BIGINT,
  receiving_amount BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS grid_quotes_withdrawal_idx
  ON grid_quotes (withdrawal_id);

CREATE INDEX IF NOT EXISTS grid_quotes_transaction_idx
  ON grid_quotes (grid_transaction_id);

CREATE TABLE IF NOT EXISTS grid_webhook_events (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS grid_webhook_events_type_idx
  ON grid_webhook_events (event_type, received_at DESC);

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS grid_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS grid_external_account_id TEXT,
  ADD COLUMN IF NOT EXISTS grid_quote_id TEXT,
  ADD COLUMN IF NOT EXISTS grid_transaction_id TEXT;
