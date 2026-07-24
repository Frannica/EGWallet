'use strict';

function msToDate(ms) {
  return new Date(Number(ms || Date.now()));
}

async function upsertRuntimeWalletMetadata(client, wallet) {
  if (!wallet || !wallet.id || !wallet.userId) return;
  // Employer funding wallets (and some legacy wallets) use Infinity in JSON
  // to mean "no explicit cap" — BIGINT cannot represent that, so store NULL
  // (unlimited) instead of letting the driver reject the whole insert.
  const rawLimit = wallet.maxLimitUSD;
  const safeMaxLimitUSD = (rawLimit === undefined || rawLimit === null || !Number.isFinite(Number(rawLimit)))
    ? null
    : Number(rawLimit);
  await client.query(
    `INSERT INTO wallets (id, user_id, type, employer_id, max_limit_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      wallet.id,
      wallet.userId,
      wallet.type || null,
      wallet.employerId || null,
      safeMaxLimitUSD,
      msToDate(wallet.createdAt),
    ]
  );
}

async function upsertRuntimeUser(client, user) {
  if (!user || !user.id) return;
  await client.query(
    `INSERT INTO users (
      id, email, username, password_hash, region, role, preferred_currency, auto_convert_incoming,
      kyc_tier, kyc_status, kyc_documents, device_id, risk_flags, kyc_device_blocked,
      daily_spent, last_reset_date, limit_tracking, linked_employers, token_version, status, created_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21
    )
    ON CONFLICT (id) DO NOTHING`,
    [
      user.id,
      user.email || `${user.id}@runtime.local`,
      user.username || null,
      user.passwordHash || user.password_hash || 'x',
      user.region || 'US',
      user.role || 'individual',
      user.preferredCurrency || user.preferred_currency || null,
      user.autoConvertIncoming === undefined ? true : !!user.autoConvertIncoming,
      Number(user.kycTier || 0),
      user.kycStatus || 'pending',
      JSON.stringify(user.kycDocuments || {}),
      user.deviceId || null,
      user.riskFlags ? JSON.stringify(user.riskFlags) : null,
      user.kycDeviceBlocked === undefined ? null : !!user.kycDeviceBlocked,
      Number(user.dailySpent || 0),
      user.lastResetDate || null,
      JSON.stringify(user.limitTracking || {}),
      JSON.stringify(user.linkedEmployers || []),
      Number(user.tokenVersion || 0),
      user.status || null,
      msToDate(user.createdAt),
    ]
  );
}

/** Backfills an employer row (and its owning user) from the JSON runtime
 *  state on first touch, so payroll's Postgres-authoritative money movement
 *  can satisfy the employers(id) foreign key even though /employer/register
 *  itself is still JSON-only. */
async function upsertRuntimeEmployer(client, employer, ownerUser) {
  if (!employer || !employer.id) return;
  if (ownerUser) await upsertRuntimeUser(client, ownerUser);
  // funding_wallet_id is intentionally left NULL here to avoid a circular FK
  // ordering problem (wallets.employer_id -> employers.id AND
  // employers.funding_wallet_id -> wallets.id). The caller links it with
  // linkRuntimeEmployerFundingWallet() after the wallet row is upserted.
  await client.query(
    `INSERT INTO employers (
      id, user_id, company_name, tax_id, business_license, employee_count,
      verification_status, funding_wallet_id, total_payroll_sent, total_batches,
      payroll_limit_tracking, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10::jsonb,$11)
    ON CONFLICT (id) DO UPDATE SET
      verification_status = EXCLUDED.verification_status,
      total_payroll_sent = EXCLUDED.total_payroll_sent,
      total_batches = EXCLUDED.total_batches,
      payroll_limit_tracking = EXCLUDED.payroll_limit_tracking`,
    [
      employer.id,
      employer.userId,
      employer.companyName || null,
      employer.taxId || null,
      employer.businessLicense || null,
      employer.employeeCount === undefined ? null : Number(employer.employeeCount),
      employer.verificationStatus || null,
      Number(employer.totalPayrollSent || 0),
      Number(employer.totalBatches || 0),
      JSON.stringify(employer.payrollLimitTracking || {}),
      msToDate(employer.createdAt),
    ]
  );
}

/** Links an employer's funding wallet after both rows exist in Postgres. */
async function linkRuntimeEmployerFundingWallet(client, employerId, fundingWalletId) {
  if (!employerId || !fundingWalletId) return;
  await client.query(
    'UPDATE employers SET funding_wallet_id = $1 WHERE id = $2 AND (funding_wallet_id IS NULL OR funding_wallet_id != $1)',
    [fundingWalletId, employerId]
  );
}

module.exports = {
  msToDate,
  upsertRuntimeWalletMetadata,
  upsertRuntimeUser,
  upsertRuntimeEmployer,
  linkRuntimeEmployerFundingWallet,
};
