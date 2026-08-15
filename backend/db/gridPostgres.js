'use strict';

const { pool } = require('./pool');

async function getGridCustomerByUserId(userId) {
  const result = await pool.query(
    `SELECT user_id, grid_customer_id, platform_customer_id, kyc_status, customer_type,
            terms_version, terms_accepted_at, terms_acceptance_method, created_at, updated_at
       FROM grid_customers WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getGridCustomerByGridId(gridCustomerId) {
  const result = await pool.query(
    `SELECT user_id, grid_customer_id, platform_customer_id, kyc_status, customer_type,
            terms_version, terms_accepted_at, terms_acceptance_method, created_at, updated_at
       FROM grid_customers WHERE grid_customer_id = $1 LIMIT 1`,
    [gridCustomerId]
  );
  return result.rows[0] || null;
}

async function upsertGridCustomer(row) {
  const result = await pool.query(
    `INSERT INTO grid_customers (
       user_id, grid_customer_id, platform_customer_id, kyc_status, customer_type,
       terms_version, terms_accepted_at, terms_acceptance_method, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       grid_customer_id = EXCLUDED.grid_customer_id,
       platform_customer_id = EXCLUDED.platform_customer_id,
       kyc_status = COALESCE(EXCLUDED.kyc_status, grid_customers.kyc_status),
       customer_type = EXCLUDED.customer_type,
       terms_version = COALESCE(EXCLUDED.terms_version, grid_customers.terms_version),
       terms_accepted_at = COALESCE(EXCLUDED.terms_accepted_at, grid_customers.terms_accepted_at),
       terms_acceptance_method = COALESCE(EXCLUDED.terms_acceptance_method, grid_customers.terms_acceptance_method),
       updated_at = NOW()
     RETURNING user_id, grid_customer_id, platform_customer_id, kyc_status, customer_type,
               terms_version, terms_accepted_at, terms_acceptance_method, created_at, updated_at`,
    [
      row.userId,
      row.gridCustomerId,
      row.platformCustomerId,
      row.kycStatus || null,
      row.customerType || 'INDIVIDUAL',
      row.termsVersion || null,
      row.termsAcceptedAt || null,
      row.termsAcceptanceMethod || null,
    ]
  );
  return result.rows[0];
}

async function updateGridCustomerStatus(gridCustomerId, kycStatus) {
  const result = await pool.query(
    `UPDATE grid_customers SET kyc_status = $2, updated_at = NOW()
      WHERE grid_customer_id = $1
      RETURNING user_id, grid_customer_id, kyc_status`,
    [gridCustomerId, kycStatus]
  );
  return result.rows[0] || null;
}

async function upsertGridInternalAccount(row) {
  const result = await pool.query(
    `INSERT INTO grid_internal_accounts (
       user_id, grid_customer_id, grid_internal_account_id, currency, status, updated_at
     ) VALUES ($1,$2,$3,$4,$5, NOW())
     ON CONFLICT (grid_internal_account_id) DO UPDATE SET
       status = COALESCE(EXCLUDED.status, grid_internal_accounts.status),
       currency = EXCLUDED.currency,
       updated_at = NOW()
     RETURNING grid_internal_account_id, currency, status`,
    [row.userId || null, row.gridCustomerId || null, row.gridInternalAccountId, row.currency, row.status || null]
  );
  return result.rows[0];
}

async function listGridInternalAccounts(userId) {
  const result = await pool.query(
    `SELECT grid_internal_account_id, currency, status
       FROM grid_internal_accounts WHERE user_id = $1`,
    [userId]
  );
  return result.rows;
}

async function getGridInternalAccountByGridId(gridInternalAccountId) {
  const result = await pool.query(
    `SELECT user_id, grid_customer_id, grid_internal_account_id, currency, status
       FROM grid_internal_accounts WHERE grid_internal_account_id = $1 LIMIT 1`,
    [gridInternalAccountId]
  );
  return result.rows[0] || null;
}

async function findWalletIdForUser(userId) {
  const result = await pool.query(
    `SELECT id FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

async function upsertGridExternalAccount(row) {
  const result = await pool.query(
    `INSERT INTO grid_external_accounts (
       user_id, grid_customer_id, grid_external_account_id, currency, status,
       account_mask, bank_name_display, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
     ON CONFLICT (grid_external_account_id) DO UPDATE SET
       status = COALESCE(EXCLUDED.status, grid_external_accounts.status),
       account_mask = COALESCE(EXCLUDED.account_mask, grid_external_accounts.account_mask),
       bank_name_display = COALESCE(EXCLUDED.bank_name_display, grid_external_accounts.bank_name_display),
       updated_at = NOW()
     RETURNING user_id, grid_external_account_id, currency, status, account_mask, bank_name_display`,
    [
      row.userId,
      row.gridCustomerId,
      row.gridExternalAccountId,
      row.currency,
      row.status || null,
      row.accountMask || null,
      row.bankNameDisplay || null,
    ]
  );
  return result.rows[0];
}

async function listGridExternalAccounts(userId) {
  const result = await pool.query(
    `SELECT grid_external_account_id, currency, status, account_mask, bank_name_display
       FROM grid_external_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function getGridExternalAccountByGridId(gridExternalAccountId) {
  const result = await pool.query(
    `SELECT user_id, grid_customer_id, grid_external_account_id, currency, status
       FROM grid_external_accounts WHERE grid_external_account_id = $1 LIMIT 1`,
    [gridExternalAccountId]
  );
  return result.rows[0] || null;
}

async function upsertGridQuote(row) {
  const result = await pool.query(
    `INSERT INTO grid_quotes (
       withdrawal_id, user_id, grid_quote_id, grid_transaction_id, status,
       sending_currency, receiving_currency, sending_amount, receiving_amount, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
     ON CONFLICT (grid_quote_id) DO UPDATE SET
       grid_transaction_id = COALESCE(EXCLUDED.grid_transaction_id, grid_quotes.grid_transaction_id),
       status = COALESCE(EXCLUDED.status, grid_quotes.status),
       updated_at = NOW()
     RETURNING withdrawal_id, grid_quote_id, grid_transaction_id, status`,
    [
      row.withdrawalId || null,
      row.userId,
      row.gridQuoteId || null,
      row.gridTransactionId || null,
      row.status || null,
      row.sendingCurrency || null,
      row.receivingCurrency || null,
      row.sendingAmount === undefined ? null : row.sendingAmount,
      row.receivingAmount === undefined ? null : row.receivingAmount,
    ]
  );
  return result.rows[0];
}

async function getGridQuoteByTransactionId(transactionId) {
  const result = await pool.query(
    `SELECT withdrawal_id, user_id, grid_quote_id, grid_transaction_id, status
       FROM grid_quotes WHERE grid_transaction_id = $1 LIMIT 1`,
    [transactionId]
  );
  return result.rows[0] || null;
}

async function updateWithdrawalGridRefs(withdrawalId, refs = {}) {
  if (!withdrawalId) return null;
  const result = await pool.query(
    `UPDATE withdrawals SET
       grid_customer_id = COALESCE($2, grid_customer_id),
       grid_external_account_id = COALESCE($3, grid_external_account_id),
       grid_quote_id = COALESCE($4, grid_quote_id),
       grid_transaction_id = COALESCE($5, grid_transaction_id)
     WHERE id = $1
     RETURNING id, grid_customer_id, grid_external_account_id, grid_quote_id, grid_transaction_id`,
    [
      withdrawalId,
      refs.gridCustomerId || null,
      refs.gridExternalAccountId || null,
      refs.gridQuoteId || null,
      refs.gridTransactionId || null,
    ]
  );
  return result.rows[0] || null;
}

async function findWithdrawalIdByGridTransaction(transactionId) {
  const byQuote = await getGridQuoteByTransactionId(transactionId);
  if (byQuote && byQuote.withdrawal_id) return byQuote.withdrawal_id;
  const result = await pool.query(
    `SELECT id FROM withdrawals WHERE grid_transaction_id = $1 OR payout_reference = $1 LIMIT 1`,
    [transactionId]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

async function reserveGridWebhookEvent({ webhookId, eventType }) {
  const result = await pool.query(
    `INSERT INTO grid_webhook_events (webhook_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (webhook_id) DO NOTHING
     RETURNING webhook_id`,
    [webhookId, eventType]
  );
  return result.rowCount > 0;
}

async function markGridWebhookEventProcessed(webhookId) {
  await pool.query(
    `UPDATE grid_webhook_events SET processed_at = NOW() WHERE webhook_id = $1`,
    [webhookId]
  );
}

module.exports = {
  getGridCustomerByUserId,
  getGridCustomerByGridId,
  upsertGridCustomer,
  updateGridCustomerStatus,
  upsertGridInternalAccount,
  listGridInternalAccounts,
  getGridInternalAccountByGridId,
  findWalletIdForUser,
  upsertGridExternalAccount,
  listGridExternalAccounts,
  getGridExternalAccountByGridId,
  upsertGridQuote,
  getGridQuoteByTransactionId,
  updateWithdrawalGridRefs,
  findWithdrawalIdByGridTransaction,
  reserveGridWebhookEvent,
  markGridWebhookEventProcessed,
};
