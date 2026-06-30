-- Stripe Issuing identifiers and card metadata (relational mirror; runtime uses app_state JSONB).

ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_cardholder_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_cardholder_id_idx
  ON users (stripe_cardholder_id) WHERE stripe_cardholder_id IS NOT NULL;

ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS stripe_cardholder_id TEXT;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS stripe_card_id TEXT;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE virtual_cards ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'local';

CREATE UNIQUE INDEX IF NOT EXISTS virtual_cards_stripe_card_id_idx
  ON virtual_cards (stripe_card_id) WHERE stripe_card_id IS NOT NULL;
