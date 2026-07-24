-- Audit/archive trail for legacy fabricated virtual-card records that were
-- auto-provisioned before VIRTUAL_CARD_ISSUING_ENABLED gating existed. These
-- records were never backed by a real Stripe Issuing card (no stripeCardId),
-- carried a randomly-generated, non-functional card number, and are moved
-- here — not deleted outright — so the audit trail is fully recoverable.
--
-- Deliberately excludes any PAN/CVV (the source records never stored a full
-- card number or CVV to begin with — only last4 — see backend/virtualCards.js
-- generateCardSecrets()/buildVirtualCardRecord()).

CREATE TABLE IF NOT EXISTS virtual_card_remediation_archive (
  archive_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  wallet_id         TEXT,
  last4             TEXT,
  expiry_month      TEXT,
  expiry_year       TEXT,
  currency          TEXT,
  label             TEXT,
  original_status   TEXT,
  original_created_at BIGINT,
  card_snapshot     JSONB NOT NULL,
  archived_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason            TEXT NOT NULL,
  source_commit     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_virtual_card_remediation_archive_user_id
  ON virtual_card_remediation_archive(user_id);
