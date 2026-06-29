ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS spent_month BIGINT DEFAULT 0;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS monthly_limit BIGINT;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS spent_today_key TEXT;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS spent_month_key TEXT;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS freeze_history JSONB DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS virtual_card_charges (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES virtual_cards(id),
  user_id UUID NOT NULL REFERENCES users(id),
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  merchant TEXT,
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  provider_reference TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS virtual_card_charges_card_id_idx ON virtual_card_charges(card_id);
CREATE INDEX IF NOT EXISTS virtual_card_charges_user_id_idx ON virtual_card_charges(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_charges_idempotency_key_idx ON virtual_card_charges(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_charges_provider_reference_idx ON virtual_card_charges(provider_reference) WHERE provider_reference IS NOT NULL;
