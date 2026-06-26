'use strict';

const crypto = require('crypto');

function toIso(value, fallbackNow = true) {
  if (value === null || value === undefined || value === '') {
    return fallbackNow ? new Date().toISOString() : null;
  }
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber) && /^\d+$/.test(value)) {
      return new Date(asNumber).toISOString();
    }
    return new Date(value).toISOString();
  }
  return fallbackNow ? new Date().toISOString() : null;
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return value;
}

function mapUsers(db) {
  return (db.users || []).map((u) => ({
    id: u.id,
    email: u.email || '',
    username: u.username || null,
    password_hash: u.passwordHash || '',
    region: u.region || 'US',
    role: u.role || 'individual',
    preferred_currency: u.preferredCurrency || null,
    auto_convert_incoming: u.autoConvertIncoming !== undefined ? !!u.autoConvertIncoming : true,
    kyc_tier: u.kycTier || 0,
    kyc_status: u.kycStatus || 'pending',
    kyc_documents: JSON.stringify(safeJson(u.kycDocuments, {})),
    kyc_id_hash: u.kycIdHash || null,
    kyc_updated_at: toIso(u.kycUpdatedAt, false),
    device_id: u.deviceId || null,
    risk_flags: JSON.stringify(safeJson(u.riskFlags, null)),
    kyc_device_blocked: u.kycDeviceBlocked === undefined ? null : !!u.kycDeviceBlocked,
    daily_spent: u.dailySpent || 0,
    last_reset_date: u.lastResetDate || null,
    limit_tracking: JSON.stringify(safeJson(u.limitTracking, {})),
    linked_employers: JSON.stringify(safeJson(u.linkedEmployers, [])),
    token_version: u.tokenVersion || 0,
    status: u.status || null,
    deleted_at: toIso(u.deletedAt, false),
    deletion_ip: u.deletionIP || null,
    consents: JSON.stringify(safeJson(u.consents, null)),
    consents_updated_at: toIso(u.consentsUpdatedAt, false),
    first_name: u.firstName || null,
    last_name: u.lastName || null,
    created_at: toIso(u.createdAt),
  }));
}

function mapWalletRows(db) {
  const wallets = [];
  const balances = [];
  const holds = [];

  for (const w of db.wallets || []) {
    wallets.push({
      id: w.id,
      user_id: w.userId,
      type: w.type || null,
      employer_id: w.employerId || null,
      max_limit_usd: Number.isFinite(w.maxLimitUSD) ? w.maxLimitUSD : null,
      created_at: toIso(w.createdAt),
    });

    for (const b of w.balances || []) {
      balances.push({
        wallet_id: w.id,
        currency: b.currency,
        amount: Number(b.amount || 0),
      });
    }

    const holdBalance = w.holdBalance || {};
    for (const currency of Object.keys(holdBalance)) {
      holds.push({
        wallet_id: w.id,
        currency,
        amount: Number(holdBalance[currency] || 0),
      });
    }
  }

  return { wallets, balances, holds };
}

function mapTransactions(db) {
  return (db.transactions || []).map((t) => ({
    id: t.id,
    from_wallet_id: t.fromWalletId || null,
    to_wallet_id: t.toWalletId || null,
    amount: Number(t.amount || 0),
    currency: t.currency || 'USD',
    debit_amount: t.debitAmount === undefined ? null : Number(t.debitAmount),
    debit_currency: t.debitCurrency || null,
    sender_cross_currency: t.senderCrossCurrency === undefined ? null : !!t.senderCrossCurrency,
    received_amount: t.receivedAmount === undefined ? null : Number(t.receivedAmount),
    received_currency: t.receivedCurrency || null,
    was_converted: t.wasConverted === undefined ? null : !!t.wasConverted,
    fx_fee_amount: t.fxFeeAmount === undefined ? null : Number(t.fxFeeAmount),
    send_fee_amount: t.sendFeeAmount === undefined ? null : Number(t.sendFeeAmount),
    type: t.type || null,
    status: t.status || null,
    memo: t.memo || null,
    direction: t.direction || null,
    stripe_intent_id: t.stripeIntentId || null,
    fee_amount: t.feeAmount === undefined ? null : Number(t.feeAmount),
    fee_rate: t.feeRate === undefined ? null : String(t.feeRate),
    gross_amount: t.grossAmount === undefined ? null : Number(t.grossAmount),
    timestamp: toIso(t.timestamp),
  }));
}

function mapWithdrawals(db) {
  return (db.withdrawals || []).map((w) => ({
    id: w.id,
    idempotency_key: w.idempotencyKey || w.id,
    user_id: w.userId,
    wallet_id: w.walletId,
    amount: Number(w.amount || 0),
    currency: w.currency || 'USD',
    fee_amount: w.feeAmount === undefined ? null : Number(w.feeAmount),
    fee_rate: w.feeRate === undefined ? null : String(w.feeRate),
    net_payout: w.netPayout === undefined ? null : Number(w.netPayout),
    method: w.method || null,
    is_international: !!w.isInternational,
    country: w.country || null,
    bank_code: w.bankCode || null,
    branch_code: w.branchCode || null,
    bank_name: w.bankName || null,
    account_number: w.accountNumber || null,
    account_holder_name: w.accountHolderName || null,
    iban: w.iban || null,
    swift_bic: w.swiftBic || null,
    account_mask: w.accountMask || null,
    bank_name_display: w.bankNameDisplay || null,
    status: w.status || 'pending_review',
    status_history: JSON.stringify(safeJson(w.statusHistory, [])),
    hold_released: !!w.holdReleased,
    refund_issued: !!w.refundIssued,
    payout_attempts: Number(w.payoutAttempts || 0),
    payout_provider: w.payoutProvider || null,
    payout_reference: w.payoutReference || null,
    payout_dispatch_ref: w.payoutDispatchRef || null,
    payout_error: w.payoutError || null,
    processed_by: w.processedBy || null,
    internal_note: w.internalNote || null,
    created_at: toIso(w.createdAt),
    approved_at: toIso(w.approvedAt, false),
    paid_at: toIso(w.paidAt, false),
    failed_at: toIso(w.failedAt, false),
    reversed_at: toIso(w.reversedAt, false),
  }));
}

function mapLedger(db) {
  return (db.ledger || []).map((l) => ({
    id: l.id,
    withdrawal_id: l.withdrawalId || null,
    user_id: l.userId,
    wallet_id: l.walletId,
    currency: l.currency || 'USD',
    type: l.type || 'entry',
    amount: Number(l.amount || 0),
    balance_before: Number(l.balanceBefore || 0),
    balance_after: Number(l.balanceAfter || 0),
    at: toIso(l.at || l.timestamp),
    by_actor: l.by || null,
    note: l.note || null,
  }));
}

function mapIdentityClaims(db) {
  return Object.entries(db.kycIdentityClaims || {}).map(([kycIdHash, claim]) => ({
    kyc_id_hash: kycIdHash,
    user_id: claim.userId,
    status: claim.status || 'claimed',
    claimed_at: toIso(claim.claimedAt),
    updated_at: toIso(claim.updatedAt),
  }));
}

function mapRates(db) {
  const rates = Object.entries((db.rates && db.rates.values) || {}).map(([currency, rate]) => ({
    currency,
    rate: String(rate),
    updated_at: toIso(db.rates.updatedAt),
    source: db.rates.source || null,
  }));
  const meta = [{
    id: 1,
    base: (db.rates && db.rates.base) || 'USD',
    updated_at: toIso(db.rates && db.rates.updatedAt),
    source: (db.rates && db.rates.source) || null,
  }];
  return { rates, meta };
}

function mapSimplePayloadRows(items, options = {}) {
  const now = new Date().toISOString();
  return (items || []).map((item) => ({
    id: item.id || crypto.randomUUID(),
    user_id: item.userId || null,
    created_at: toIso(item.createdAt || item.timestamp || now),
    payload: JSON.stringify(item),
    ...options.extra(item),
  }));
}

function mapAll(db) {
  const walletRows = mapWalletRows(db);
  const rateRows = mapRates(db);

  return {
    appMetadata: [{
      key: 'db_version',
      value: JSON.stringify({ version: db._dbVersion || 0 }),
      updated_at: new Date().toISOString(),
    }],
    users: mapUsers(db),
    wallets: walletRows.wallets,
    walletBalances: walletRows.balances,
    walletHolds: walletRows.holds,
    transactions: mapTransactions(db),
    withdrawals: mapWithdrawals(db),
    ledger: mapLedger(db),
    refreshTokens: (db.refreshTokens || []).map((r) => ({
      token_hash: r.tokenHash,
      user_id: r.userId,
      created_at: toIso(r.createdAt),
    })),
    passwordResetTokens: (db.passwordResetTokens || []).map((r) => ({
      token_hash: r.tokenHash,
      user_id: r.userId,
      expires_at: toIso(r.expiresAt),
      created_at: toIso(r.createdAt),
    })),
    idempotencyRecords: (db.idempotencyRecords || []).map((r) => ({
      key: r.key,
      user_id: r.userId,
      response: JSON.stringify(safeJson(r.response, {})),
      timestamp: toIso(r.timestamp),
    })),
    employers: (db.employers || []).map((e) => ({
      id: e.id,
      user_id: e.userId,
      company_name: e.companyName || null,
      tax_id: e.taxId || null,
      business_license: e.businessLicense || null,
      employee_count: Number(e.employeeCount || 0),
      verification_status: e.verificationStatus || null,
      funding_wallet_id: e.fundingWalletId || null,
      total_payroll_sent: Number(e.totalPayrollSent || 0),
      total_batches: Number(e.totalBatches || 0),
      payroll_limit_tracking: JSON.stringify(safeJson(e.payrollLimitTracking, {})),
      created_at: toIso(e.createdAt),
    })),
    employerEmployees: (db.employerEmployees || []).map((ee) => ({
      id: ee.id,
      employer_id: ee.employerId,
      employee_user_id: ee.employeeUserId,
      max_request_amount: ee.maxRequestAmount === undefined ? null : Number(ee.maxRequestAmount),
      status: ee.status || null,
      created_at: toIso(ee.createdAt),
    })),
    payrollBatches: (db.payrollBatches || []).map((p) => ({
      id: p.id,
      employer_id: p.employerId,
      transaction_ids: JSON.stringify(safeJson(p.transactions, [])),
      employee_count: Number(p.employeeCount || 0),
      total_amount: Number(p.totalAmount || 0),
      currency: p.currency || null,
      pay_period: p.payPeriod || null,
      notes: p.notes || null,
      status: p.status || null,
      created_at: toIso(p.createdAt),
    })),
    paymentRequests: (db.paymentRequests || []).map((p) => ({
      id: p.id,
      requester_id: p.requesterId,
      wallet_id: p.walletId || null,
      target_wallet_id: p.targetWalletId || null,
      target_employer_id: p.targetEmployerId || null,
      amount: Number(p.amount || 0),
      currency: p.currency || 'USD',
      memo: p.memo || null,
      status: p.status || 'pending',
      type: p.type || null,
      payroll_metadata: JSON.stringify(safeJson(p.payrollMetadata, null)),
      compliance_flags: JSON.stringify(safeJson(p.complianceFlags, null)),
      paid_at: toIso(p.paidAt, false),
      paid_by: p.paidBy || null,
      transaction_id: p.transactionId || null,
      cancelled_at: toIso(p.cancelledAt, false),
      cancel_reason: p.cancelReason || null,
      settled_by_transaction_id: p.settledByTransactionId || null,
      created_at: toIso(p.createdAt),
    })),
    kycIdentityClaims: mapIdentityClaims(db),
    kycUploads: (db.kyc || []).map((k) => ({
      user_id: k.userId,
      status: k.status || 'pending',
      documents: JSON.stringify(safeJson(k.documents, [])),
      updated_at: toIso(k.updatedAt || k.createdAt),
    })),
    devices: (db.devices || []).map((d) => ({
      id: d.id,
      user_id: d.userId,
      fingerprint: d.fingerprint || null,
      name: d.name || null,
      type: d.type || null,
      first_seen: toIso(d.firstSeen, false),
      last_seen: toIso(d.lastSeen, false),
      trusted: !!d.trusted,
    })),
    notifications: (db.notifications || []).map((n) => ({
      id: n.id,
      user_id: n.userId,
      payload: JSON.stringify(n),
      created_at: toIso(n.createdAt),
    })),
    virtualCards: (db.virtualCards || []).map((v) => ({
      id: v.id,
      user_id: v.userId,
      wallet_id: v.walletId || null,
      last4: v.last4 || null,
      expiry: v.expiry || null,
      currency: v.currency || null,
      label: v.label || null,
      status: v.status || null,
      spent_today: Number(v.spentToday || 0),
      daily_limit: v.dailyLimit === undefined ? null : Number(v.dailyLimit),
      created_at: toIso(v.createdAt),
    })),
    budgets: (db.budgets || []).map((b) => ({
      id: b.id,
      user_id: b.userId,
      wallet_id: b.walletId,
      currency: b.currency || 'USD',
      monthly_limit: b.monthlyLimit === undefined ? null : Number(b.monthlyLimit),
      spent: Number(b.spent || 0),
      month_key: b.monthKey || null,
      created_at: toIso(b.createdAt),
    })),
    qrCodes: mapSimplePayloadRows(db.qrCodes || [], {
      extra: () => ({}),
    }),
    supportTickets: (db.supportTickets || []).map((s) => ({
      id: s.id,
      user_id: s.userId,
      freshdesk_id: s.freshdeskId || null,
      subject: s.subject || null,
      status: s.status || null,
      payload: JSON.stringify(s),
      created_at: toIso(s.createdAt),
    })),
    demoIntents: mapSimplePayloadRows(db.demoIntents || [], {
      extra: () => ({}),
    }),
    fraudReports: mapSimplePayloadRows(db.fraudReports || [], {
      extra: () => ({}),
    }),
    auditLog: (db.auditLog || []).map((a) => ({
      id: a.id || crypto.randomUUID(),
      user_id: a.userId || null,
      action: a.action || a.type || null,
      payload: JSON.stringify(a),
      created_at: toIso(a.createdAt || a.timestamp),
    })),
    payoutLocks: (db.payoutLocks || []).map((p) => ({
      withdrawal_id: p.withdrawalId,
      pid: p.pid || null,
      claimed_at: toIso(p.claimedAt),
      expires_at: toIso(p.expiresAt),
    })),
    deviceSignupTracker: (db.device_signup_tracker || []).map((r) => ({
      device_id: r.deviceId,
      timestamps: JSON.stringify(safeJson(r.timestamps, [])),
      updated_at: toIso(r.updatedAt),
    })),
    paymentRequestRateLimits: Object.entries(db.paymentRequestsRateLimit || {}).map(([key, timestamps]) => ({
      rate_limit_key: key,
      timestamps: JSON.stringify(Array.isArray(timestamps) ? timestamps : []),
      updated_at: new Date().toISOString(),
    })),
    fraudAlerts: mapSimplePayloadRows(db.fraudAlerts || [], {
      extra: () => ({}),
    }),
    savedContacts: mapSimplePayloadRows(db.savedContacts || [], {
      extra: () => ({}),
    }),
    exchangeRates: rateRows.rates,
    exchangeRateMeta: rateRows.meta,
  };
}

module.exports = {
  mapAll,
};
