CREATE TABLE IF NOT EXISTS kyc_documents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  document_type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'under_review',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyc_documents_user_id_idx ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS kyc_documents_status_idx ON kyc_documents(status);
CREATE INDEX IF NOT EXISTS kyc_documents_uploaded_at_idx ON kyc_documents(uploaded_at DESC);
