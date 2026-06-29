ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
