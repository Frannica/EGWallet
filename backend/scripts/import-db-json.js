'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { validateRootShape } = require('./lib/import-validators');
const { mapAll } = require('./lib/import-mappers');
const { insertRows } = require('./lib/import-batch');

function parseArgs(argv) {
  const out = {
    file: path.join(__dirname, '..', 'db.proof-test.json'),
    truncate: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') out.file = path.resolve(argv[i + 1]);
    if (arg === '--truncate') out.truncate = true;
    if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

const TABLE_SPECS = [
  ['app_metadata', ['key', 'value', 'updated_at'], 'appMetadata'],
  ['users', ['id', 'email', 'username', 'password_hash', 'region', 'role', 'preferred_currency', 'auto_convert_incoming', 'kyc_tier', 'kyc_status', 'kyc_documents', 'kyc_id_hash', 'kyc_updated_at', 'device_id', 'risk_flags', 'kyc_device_blocked', 'daily_spent', 'last_reset_date', 'limit_tracking', 'linked_employers', 'token_version', 'status', 'deleted_at', 'deletion_ip', 'consents', 'consents_updated_at', 'first_name', 'last_name', 'created_at'], 'users'],
  ['wallets', ['id', 'user_id', 'type', 'employer_id', 'max_limit_usd', 'created_at'], 'wallets'],
  ['wallet_balances', ['wallet_id', 'currency', 'amount'], 'walletBalances'],
  ['wallet_holds', ['wallet_id', 'currency', 'amount'], 'walletHolds'],
  ['transactions', ['id', 'from_wallet_id', 'to_wallet_id', 'amount', 'currency', 'debit_amount', 'debit_currency', 'sender_cross_currency', 'received_amount', 'received_currency', 'was_converted', 'fx_fee_amount', 'send_fee_amount', 'type', 'status', 'memo', 'direction', 'stripe_intent_id', 'fee_amount', 'fee_rate', 'gross_amount', 'timestamp'], 'transactions'],
  ['employers', ['id', 'user_id', 'company_name', 'tax_id', 'business_license', 'employee_count', 'verification_status', 'funding_wallet_id', 'total_payroll_sent', 'total_batches', 'payroll_limit_tracking', 'created_at'], 'employers'],
  ['employer_employees', ['id', 'employer_id', 'employee_user_id', 'max_request_amount', 'status', 'created_at'], 'employerEmployees'],
  ['payroll_batches', ['id', 'employer_id', 'transaction_ids', 'employee_count', 'total_amount', 'currency', 'pay_period', 'notes', 'status', 'created_at'], 'payrollBatches'],
  ['payment_requests', ['id', 'requester_id', 'wallet_id', 'target_wallet_id', 'target_employer_id', 'amount', 'currency', 'memo', 'status', 'type', 'payroll_metadata', 'compliance_flags', 'paid_at', 'paid_by', 'transaction_id', 'cancelled_at', 'cancel_reason', 'settled_by_transaction_id', 'created_at'], 'paymentRequests'],
  ['withdrawals', ['id', 'idempotency_key', 'user_id', 'wallet_id', 'amount', 'currency', 'fee_amount', 'fee_rate', 'net_payout', 'method', 'is_international', 'country', 'bank_code', 'branch_code', 'bank_name', 'account_number', 'account_holder_name', 'iban', 'swift_bic', 'account_mask', 'bank_name_display', 'status', 'status_history', 'hold_released', 'refund_issued', 'payout_attempts', 'payout_provider', 'payout_reference', 'payout_dispatch_ref', 'payout_error', 'processed_by', 'internal_note', 'created_at', 'approved_at', 'paid_at', 'failed_at', 'reversed_at'], 'withdrawals'],
  ['ledger', ['id', 'withdrawal_id', 'user_id', 'wallet_id', 'currency', 'type', 'amount', 'balance_before', 'balance_after', 'at', 'by_actor', 'note'], 'ledger'],
  ['refresh_tokens', ['token_hash', 'user_id', 'created_at'], 'refreshTokens'],
  ['password_reset_tokens', ['token_hash', 'user_id', 'expires_at', 'created_at'], 'passwordResetTokens'],
  ['idempotency_records', ['key', 'user_id', 'response', 'timestamp'], 'idempotencyRecords'],
  ['exchange_rates', ['currency', 'rate', 'updated_at', 'source'], 'exchangeRates'],
  ['exchange_rate_meta', ['id', 'base', 'updated_at', 'source'], 'exchangeRateMeta'],
  ['kyc_identity_claims', ['kyc_id_hash', 'user_id', 'status', 'claimed_at', 'updated_at'], 'kycIdentityClaims'],
  ['kyc_uploads', ['user_id', 'status', 'documents', 'updated_at'], 'kycUploads'],
  ['devices', ['id', 'user_id', 'fingerprint', 'name', 'type', 'first_seen', 'last_seen', 'trusted'], 'devices'],
  ['notifications', ['id', 'user_id', 'payload', 'created_at'], 'notifications'],
  ['virtual_cards', ['id', 'user_id', 'wallet_id', 'last4', 'expiry', 'currency', 'label', 'status', 'spent_today', 'daily_limit', 'created_at'], 'virtualCards'],
  ['budgets', ['id', 'user_id', 'wallet_id', 'currency', 'monthly_limit', 'spent', 'month_key', 'created_at'], 'budgets'],
  ['qr_codes', ['id', 'user_id', 'created_at', 'payload'], 'qrCodes'],
  ['support_tickets', ['id', 'user_id', 'freshdesk_id', 'subject', 'status', 'payload', 'created_at'], 'supportTickets'],
  ['demo_intents', ['id', 'user_id', 'created_at', 'payload'], 'demoIntents'],
  ['fraud_reports', ['id', 'user_id', 'created_at', 'payload'], 'fraudReports'],
  ['audit_log', ['id', 'user_id', 'action', 'payload', 'created_at'], 'auditLog'],
  ['payout_locks', ['withdrawal_id', 'pid', 'claimed_at', 'expires_at'], 'payoutLocks'],
  ['device_signup_tracker', ['device_id', 'timestamps', 'updated_at'], 'deviceSignupTracker'],
  ['payment_request_rate_limits', ['rate_limit_key', 'timestamps', 'updated_at'], 'paymentRequestRateLimits'],
  ['fraud_alerts', ['id', 'user_id', 'created_at', 'payload'], 'fraudAlerts'],
  ['saved_contacts', ['id', 'user_id', 'created_at', 'payload'], 'savedContacts'],
];

async function getTableCount(client, tableName) {
  const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${tableName}`);
  return Number(result.rows[0].count || 0);
}

async function ensureEmptyDatabase(client) {
  for (const [tableName] of TABLE_SPECS) {
    const count = await getTableCount(client, tableName);
    if (count > 0) {
      throw new Error(`Target database is not empty. Found ${count} rows in "${tableName}". Re-run with --truncate.`);
    }
  }
}

async function truncateAll(client) {
  const names = TABLE_SPECS.map(([table]) => table).join(', ');
  await client.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

function summarize(mapped) {
  const summary = {};
  for (const [, , key] of TABLE_SPECS) {
    summary[key] = (mapped[key] || []).length;
  }
  return summary;
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  const source = readJson(args.file);
  validateRootShape(source);
  const mapped = mapAll(source);
  const summary = summarize(mapped);

  console.log('[db:import] source:', args.file);
  console.log('[db:import] mapped rows:', JSON.stringify(summary, null, 2));

  if (args.dryRun) {
    console.log('[db:import] dry-run complete (no database writes)');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (args.truncate) {
      await truncateAll(client);
    } else {
      await ensureEmptyDatabase(client);
    }

    for (const [tableName, columns, key] of TABLE_SPECS) {
      const count = await insertRows(client, tableName, columns, mapped[key] || []);
      if (count > 0) console.log(`[db:import] inserted ${count} rows into ${tableName}`);
    }

    await client.query('COMMIT');
    console.log('[db:import] import complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[db:import] failed, transaction rolled back:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

run()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error('[db:import] fatal:', error && error.stack ? error.stack : error);
    await pool.end();
    process.exit(1);
  });
