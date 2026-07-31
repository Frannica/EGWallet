-- Dynamic QR: durable cross-replica storage + single-use redemption columns.
-- payment_requests remains the money-link row; qr_codes holds HMAC/expiry/used state.

ALTER TABLE qr_codes
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS wallet_id TEXT,
  ADD COLUMN IF NOT EXISTS amount BIGINT,
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS hmac_signature TEXT,
  ADD COLUMN IF NOT EXISTS nonce TEXT,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS used_by UUID,
  ADD COLUMN IF NOT EXISTS transaction_id UUID;

CREATE INDEX IF NOT EXISTS qr_codes_status_expires_idx
  ON qr_codes (status, expires_at);

CREATE INDEX IF NOT EXISTS qr_codes_user_created_idx
  ON qr_codes (user_id, created_at DESC);

-- Align wallet_id type with wallets.id (TEXT after migration 009).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'qr_codes' AND column_name = 'wallet_id'
       AND data_type = 'uuid'
  ) THEN
    ALTER TABLE qr_codes ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
  END IF;
END $$;
