BEGIN;

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read_only',
  status TEXT NOT NULL DEFAULT 'active',
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  token_version INT NOT NULL DEFAULT 0,
  totp_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_idx ON admin_users (LOWER(email));

CREATE TABLE IF NOT EXISTS admin_user_notes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  admin_id UUID NOT NULL REFERENCES admin_users(id),
  admin_email TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_user_notes_user_id_idx ON admin_user_notes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES admin_users(id)
);

INSERT INTO admin_settings (key, value) VALUES
  ('maintenance_mode', '{"enabled": false, "message": "EG Wallet is temporarily unavailable."}'::jsonb),
  ('feature_flags', '{}'::jsonb),
  ('daily_limits', '{"defaultDailySpendMinor": 500000}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
