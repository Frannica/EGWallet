-- Durable payroll idempotency: replaces the fragile in-memory 24-hour
-- duplicate-payment scan (which was not atomic, not persisted, and used an
-- arbitrary rolling time window instead of a real payroll-run identity) with
-- a real database UNIQUE constraint. A given (employer, worker, pay_period)
-- combination can be paid at most once, no matter which endpoint is used
-- (/employer/bulk-payment or /payment-requests/:id/pay), no matter how many
-- app instances or retries are involved, and forever — not just for 24 hours.
CREATE TABLE IF NOT EXISTS payroll_payments (
  id UUID PRIMARY KEY,
  employer_id UUID NOT NULL REFERENCES employers(id),
  worker_id UUID NOT NULL REFERENCES users(id),
  pay_period TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount BIGINT NOT NULL,
  source TEXT NOT NULL, -- 'bulk' | 'request'
  batch_id TEXT,
  payment_request_id UUID REFERENCES payment_requests(id),
  transaction_id UUID REFERENCES transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employer_id, worker_id, pay_period)
);

CREATE INDEX IF NOT EXISTS payroll_payments_employer_idx ON payroll_payments (employer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_payments_worker_idx ON payroll_payments (worker_id, created_at DESC);
