-- Unique Grid incoming-payment reference on the shared ledger.
-- Stripe deposits keep using stripe_intent_id; the two columns never share a key.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS grid_transaction_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_grid_transaction_idx
  ON transactions (grid_transaction_id)
  WHERE grid_transaction_id IS NOT NULL;
