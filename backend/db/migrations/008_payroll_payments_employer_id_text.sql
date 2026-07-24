-- The application's employer identifiers are NOT plain UUIDs — they are
-- generated as `EMP-<uuid>` (see backend/index.js /employer/register), and
-- the `employers` Postgres table (UUID primary key) has never actually been
-- populated by any code path; the employer/payroll domain has always lived
-- entirely in the JSON app_metadata blob. payroll_payments.employer_id must
-- therefore be TEXT with no foreign key to employers(id), or every payroll
-- payment through the real API would fail with
-- "invalid input syntax for type uuid".
ALTER TABLE payroll_payments DROP CONSTRAINT IF EXISTS payroll_payments_employer_id_fkey;
ALTER TABLE payroll_payments ALTER COLUMN employer_id TYPE TEXT;
