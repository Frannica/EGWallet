-- Widen wallet/employer identifier columns from UUID to TEXT.
--
-- Why: the application does not always use plain UUIDs for these ids.
-- Regular user wallets and transaction/ledger ids ARE plain uuidv4() strings,
-- but the employer funding wallet is deliberately created with the id
-- `WALLET-<employerId>` and employer records use `EMP-<uuid>` (see
-- backend/index.js /employer/register). Both are perfectly valid, stable
-- string identifiers — they were simply never storable in a strict UUID
-- column, which is why the employer/payroll domain had never been wired to
-- Postgres until now (see payrollPostgres.js).
--
-- This is a pure type-widening migration: every existing value already
-- stored in these UUID columns is a syntactically valid UUID, which is also
-- syntactically valid TEXT, so `USING column::text` is lossless and requires
-- no data rewrite. No application code changes are required — Node's `pg`
-- driver already sends/receives these values as plain JS strings regardless
-- of the underlying Postgres column type.
BEGIN;

-- Drop FKs that reference wallets(id) or employers(id) so the column types
-- can be widened (Postgres refuses to ALTER TYPE on a column used in an FK).
ALTER TABLE wallet_balances DROP CONSTRAINT IF EXISTS wallet_balances_wallet_id_fkey;
ALTER TABLE wallet_holds DROP CONSTRAINT IF EXISTS wallet_holds_wallet_id_fkey;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_from_wallet_id_fkey;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_to_wallet_id_fkey;
ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_wallet_id_fkey;
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_wallet_id_fkey;
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_target_wallet_id_fkey;
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_target_employer_id_fkey;
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_wallet_id_fkey;
ALTER TABLE employer_employees DROP CONSTRAINT IF EXISTS employer_employees_employer_id_fkey;
ALTER TABLE payroll_batches DROP CONSTRAINT IF EXISTS payroll_batches_employer_id_fkey;
ALTER TABLE employers DROP CONSTRAINT IF EXISTS employers_funding_wallet_id_fkey;
ALTER TABLE virtual_cards DROP CONSTRAINT IF EXISTS virtual_cards_wallet_id_fkey;
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_wallet_id_fkey;

-- Widen the primary/id columns first.
ALTER TABLE wallets ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE wallets ALTER COLUMN employer_id TYPE TEXT USING employer_id::text;
ALTER TABLE employers ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE employers ALTER COLUMN funding_wallet_id TYPE TEXT USING funding_wallet_id::text;

-- Widen every referencing column to match.
ALTER TABLE wallet_balances ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
ALTER TABLE wallet_holds ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
ALTER TABLE transactions ALTER COLUMN from_wallet_id TYPE TEXT USING from_wallet_id::text;
ALTER TABLE transactions ALTER COLUMN to_wallet_id TYPE TEXT USING to_wallet_id::text;
ALTER TABLE ledger ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
ALTER TABLE payment_requests ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
ALTER TABLE payment_requests ALTER COLUMN target_wallet_id TYPE TEXT USING target_wallet_id::text;
ALTER TABLE payment_requests ALTER COLUMN target_employer_id TYPE TEXT USING target_employer_id::text;
ALTER TABLE withdrawals ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
ALTER TABLE employer_employees ALTER COLUMN employer_id TYPE TEXT USING employer_id::text;
ALTER TABLE payroll_batches ALTER COLUMN employer_id TYPE TEXT USING employer_id::text;
ALTER TABLE virtual_cards ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;
ALTER TABLE budgets ALTER COLUMN wallet_id TYPE TEXT USING wallet_id::text;

-- Re-create the foreign keys with matching TEXT types on both sides.
ALTER TABLE wallet_balances ADD CONSTRAINT wallet_balances_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE;
ALTER TABLE wallet_holds ADD CONSTRAINT wallet_holds_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD CONSTRAINT transactions_from_wallet_id_fkey FOREIGN KEY (from_wallet_id) REFERENCES wallets(id);
ALTER TABLE transactions ADD CONSTRAINT transactions_to_wallet_id_fkey FOREIGN KEY (to_wallet_id) REFERENCES wallets(id);
ALTER TABLE ledger ADD CONSTRAINT ledger_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id);
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id);
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_target_wallet_id_fkey FOREIGN KEY (target_wallet_id) REFERENCES wallets(id);
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_target_employer_id_fkey FOREIGN KEY (target_employer_id) REFERENCES employers(id);
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id);
ALTER TABLE employer_employees ADD CONSTRAINT employer_employees_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES employers(id);
ALTER TABLE payroll_batches ADD CONSTRAINT payroll_batches_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES employers(id);
ALTER TABLE employers ADD CONSTRAINT employers_funding_wallet_id_fkey FOREIGN KEY (funding_wallet_id) REFERENCES wallets(id);
ALTER TABLE virtual_cards ADD CONSTRAINT virtual_cards_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id);
ALTER TABLE budgets ADD CONSTRAINT budgets_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id);

COMMIT;
