BEGIN;

CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_refresh_tokens_admin_id_idx ON admin_refresh_tokens (admin_id);

COMMIT;
