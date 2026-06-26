BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  username TEXT,
  password_hash TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'US',
  role TEXT NOT NULL DEFAULT 'individual',
  preferred_currency TEXT,
  auto_convert_incoming BOOLEAN DEFAULT TRUE,
  kyc_tier INT DEFAULT 0,
  kyc_status TEXT DEFAULT 'pending',
  kyc_documents JSONB DEFAULT '{}'::jsonb,
  kyc_id_hash TEXT,
  kyc_updated_at TIMESTAMPTZ,
  device_id TEXT,
  risk_flags JSONB,
  kyc_device_blocked BOOLEAN,
  daily_spent BIGINT DEFAULT 0,
  last_reset_date DATE,
  limit_tracking JSONB DEFAULT '{}'::jsonb,
  linked_employers JSONB DEFAULT '[]'::jsonb,
  token_version INT NOT NULL DEFAULT 0,
  status TEXT,
  deleted_at TIMESTAMPTZ,
  deletion_ip TEXT,
  consents JSONB,
  consents_updated_at TIMESTAMPTZ,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_kyc_id_hash_idx ON users (kyc_id_hash) WHERE kyc_id_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT,
  employer_id UUID,
  max_limit_usd BIGINT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS wallets_user_id_idx ON wallets (user_id);

CREATE TABLE IF NOT EXISTS wallet_balances (
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (wallet_id, currency)
);

CREATE TABLE IF NOT EXISTS wallet_holds (
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (wallet_id, currency)
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  from_wallet_id UUID REFERENCES wallets(id),
  to_wallet_id UUID REFERENCES wallets(id),
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  debit_amount BIGINT,
  debit_currency TEXT,
  sender_cross_currency BOOLEAN,
  received_amount BIGINT,
  received_currency TEXT,
  was_converted BOOLEAN,
  fx_fee_amount BIGINT,
  send_fee_amount BIGINT,
  type TEXT,
  status TEXT,
  memo TEXT,
  direction TEXT,
  stripe_intent_id TEXT,
  fee_amount BIGINT,
  fee_rate NUMERIC,
  gross_amount BIGINT,
  timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_from_wallet_idx ON transactions (from_wallet_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS transactions_to_wallet_idx ON transactions (to_wallet_id, timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_stripe_intent_idx ON transactions (stripe_intent_id)
  WHERE stripe_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS employers (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  company_name TEXT,
  tax_id TEXT,
  business_license TEXT,
  employee_count INT,
  verification_status TEXT,
  funding_wallet_id UUID REFERENCES wallets(id),
  total_payroll_sent BIGINT DEFAULT 0,
  total_batches INT DEFAULT 0,
  payroll_limit_tracking JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS employer_employees (
  id UUID PRIMARY KEY,
  employer_id UUID NOT NULL REFERENCES employers(id),
  employee_user_id UUID NOT NULL REFERENCES users(id),
  max_request_amount BIGINT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (employer_id, employee_user_id)
);

CREATE TABLE IF NOT EXISTS payroll_batches (
  id UUID PRIMARY KEY,
  employer_id UUID NOT NULL REFERENCES employers(id),
  transaction_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  employee_count INT,
  total_amount BIGINT,
  currency TEXT,
  pay_period TEXT,
  notes TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES wallets(id),
  target_wallet_id UUID REFERENCES wallets(id),
  target_employer_id UUID REFERENCES employers(id),
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL,
  type TEXT,
  payroll_metadata JSONB,
  compliance_flags JSONB,
  paid_at TIMESTAMPTZ,
  paid_by UUID REFERENCES users(id),
  transaction_id UUID REFERENCES transactions(id),
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  settled_by_transaction_id UUID REFERENCES transactions(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_requests_requester_idx ON payment_requests (requester_id, status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  fee_amount BIGINT,
  fee_rate NUMERIC,
  net_payout BIGINT,
  method TEXT,
  is_international BOOLEAN DEFAULT FALSE,
  country TEXT,
  bank_code TEXT,
  branch_code TEXT,
  bank_name TEXT,
  account_number TEXT,
  account_holder_name TEXT,
  iban TEXT,
  swift_bic TEXT,
  account_mask TEXT,
  bank_name_display TEXT,
  status TEXT NOT NULL,
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  hold_released BOOLEAN DEFAULT FALSE,
  refund_issued BOOLEAN DEFAULT FALSE,
  payout_attempts INT DEFAULT 0,
  payout_provider TEXT,
  payout_reference TEXT,
  payout_dispatch_ref TEXT,
  payout_error TEXT,
  processed_by TEXT,
  internal_note TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS withdrawals_user_status_idx ON withdrawals (user_id, status);
CREATE INDEX IF NOT EXISTS withdrawals_status_created_idx ON withdrawals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger (
  id UUID PRIMARY KEY,
  withdrawal_id UUID REFERENCES withdrawals(id),
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  currency TEXT NOT NULL,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  balance_before BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  by_actor TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS ledger_wallet_at_idx ON ledger (wallet_id, at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS password_reset_expires_idx ON password_reset_tokens (expires_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  response JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_timestamp_idx ON idempotency_records (timestamp);

CREATE TABLE IF NOT EXISTS exchange_rates (
  currency TEXT PRIMARY KEY,
  rate NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source TEXT
);

CREATE TABLE IF NOT EXISTS exchange_rate_meta (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  base TEXT NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL,
  source TEXT
);

CREATE TABLE IF NOT EXISTS kyc_identity_claims (
  kyc_id_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_uploads (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  status TEXT NOT NULL,
  documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  fingerprint TEXT,
  name TEXT,
  type TEXT,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  trusted BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS virtual_cards (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES wallets(id),
  last4 TEXT,
  expiry TEXT,
  currency TEXT,
  label TEXT,
  status TEXT,
  spent_today BIGINT DEFAULT 0,
  daily_limit BIGINT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  currency TEXT NOT NULL,
  monthly_limit BIGINT,
  spent BIGINT DEFAULT 0,
  month_key TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  freshdesk_id BIGINT,
  subject TEXT,
  status TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_intents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS fraud_reports (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY,
  user_id UUID,
  action TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_locks (
  withdrawal_id UUID PRIMARY KEY REFERENCES withdrawals(id) ON DELETE CASCADE,
  pid INT,
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS device_signup_tracker (
  device_id TEXT PRIMARY KEY,
  timestamps JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_request_rate_limits (
  rate_limit_key TEXT PRIMARY KEY,
  timestamps JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id UUID PRIMARY KEY,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_contacts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

COMMIT;
