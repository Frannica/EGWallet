'use strict';

const { pool } = require('./pool');

function msToDate(ms) {
  return ms ? new Date(Number(ms)) : null;
}

function getWalletCurrencyAmounts(runtimeStateDb, walletId, currency) {
  const wallet = (runtimeStateDb.wallets || []).find((w) => w.id === walletId);
  if (!wallet) return { balance: 0, hold: 0 };
  const balance = (wallet.balances || []).find((b) => b.currency === currency);
  return {
    balance: Number(balance ? balance.amount : 0),
    hold: Number((wallet.holdBalance && wallet.holdBalance[currency]) || 0),
  };
}

function mapWithdrawalRow(w) {
  return {
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
    status_history: JSON.stringify(Array.isArray(w.statusHistory) ? w.statusHistory : []),
    hold_released: !!w.holdReleased,
    refund_issued: !!w.refundIssued,
    payout_attempts: Number(w.payoutAttempts || 0),
    payout_provider: w.payoutProvider || null,
    payout_reference: w.payoutReference || null,
    payout_dispatch_ref: w.payoutDispatchRef || null,
    payout_error: w.payoutError || null,
    processed_by: w.processedBy || null,
    internal_note: w.internalNote || null,
    created_at: msToDate(w.createdAt) || new Date(),
    approved_at: msToDate(w.approvedAt),
    paid_at: msToDate(w.paidAt),
    failed_at: msToDate(w.failedAt),
    reversed_at: msToDate(w.reversedAt),
  };
}

async function upsertWithdrawal(client, w) {
  const row = mapWithdrawalRow(w);
  await client.query(
    `INSERT INTO withdrawals (
      id, idempotency_key, user_id, wallet_id, amount, currency, fee_amount, fee_rate, net_payout,
      method, is_international, country, bank_code, branch_code, bank_name, account_number,
      account_holder_name, iban, swift_bic, account_mask, bank_name_display, status, status_history,
      hold_released, refund_issued, payout_attempts, payout_provider, payout_reference, payout_dispatch_ref,
      payout_error, processed_by, internal_note, created_at, approved_at, paid_at, failed_at, reversed_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,
      $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      status_history = EXCLUDED.status_history,
      hold_released = EXCLUDED.hold_released,
      refund_issued = EXCLUDED.refund_issued,
      payout_attempts = EXCLUDED.payout_attempts,
      payout_provider = EXCLUDED.payout_provider,
      payout_reference = EXCLUDED.payout_reference,
      payout_dispatch_ref = EXCLUDED.payout_dispatch_ref,
      payout_error = EXCLUDED.payout_error,
      processed_by = EXCLUDED.processed_by,
      internal_note = EXCLUDED.internal_note,
      approved_at = EXCLUDED.approved_at,
      paid_at = EXCLUDED.paid_at,
      failed_at = EXCLUDED.failed_at,
      reversed_at = EXCLUDED.reversed_at`,
    [
      row.id,
      row.idempotency_key,
      row.user_id,
      row.wallet_id,
      row.amount,
      row.currency,
      row.fee_amount,
      row.fee_rate,
      row.net_payout,
      row.method,
      row.is_international,
      row.country,
      row.bank_code,
      row.branch_code,
      row.bank_name,
      row.account_number,
      row.account_holder_name,
      row.iban,
      row.swift_bic,
      row.account_mask,
      row.bank_name_display,
      row.status,
      row.status_history,
      row.hold_released,
      row.refund_issued,
      row.payout_attempts,
      row.payout_provider,
      row.payout_reference,
      row.payout_dispatch_ref,
      row.payout_error,
      row.processed_by,
      row.internal_note,
      row.created_at,
      row.approved_at,
      row.paid_at,
      row.failed_at,
      row.reversed_at,
    ]
  );
}

async function upsertWalletRows(client, walletId, currency, balanceAmount, holdAmount) {
  await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  await client.query(
    'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
    [walletId, currency]
  );
  await client.query(
    'SELECT amount FROM wallet_holds WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
    [walletId, currency]
  );

  await client.query(
    `INSERT INTO wallet_balances(wallet_id, currency, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
    [walletId, currency, Number(balanceAmount)]
  );
  await client.query(
    `INSERT INTO wallet_holds(wallet_id, currency, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
    [walletId, currency, Number(holdAmount)]
  );
}

async function upsertRuntimeState(client, runtimeStateDb) {
  if (!runtimeStateDb) return;
  const runtimeLock = await client.query(
    'SELECT version FROM runtime_db_state WHERE id = 1 FOR UPDATE'
  );
  if (runtimeLock.rowCount === 0) {
    const seededVersion = Number(runtimeStateDb._dbVersion || 0) + 1;
    runtimeStateDb._dbVersion = seededVersion;
    await client.query(
      'INSERT INTO runtime_db_state(id, version, data, updated_at) VALUES (1, $1, $2::jsonb, NOW())',
      [seededVersion, JSON.stringify(runtimeStateDb)]
    );
  } else {
    const currentVersion = Number(runtimeLock.rows[0].version || 0);
    const expectedVersion = Number(runtimeStateDb._dbVersion || 0);
    if (currentVersion !== expectedVersion) {
      throw new Error(`DB_VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
    }
    const nextVersion = expectedVersion + 1;
    runtimeStateDb._dbVersion = nextVersion;
    await client.query(
      'UPDATE runtime_db_state SET version = $1, data = $2::jsonb, updated_at = NOW() WHERE id = 1',
      [nextVersion, JSON.stringify(runtimeStateDb)]
    );
  }
}

async function getDurableWithdrawalIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function commitCreateWithdrawalPostgres({
  runtimeStateDb,
  withdrawal,
  userId,
  clientKey,
  responseBody,
  userLimitTracking,
  skipRuntimeStateSync = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (clientKey) {
      const replay = await client.query(
        'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
        [clientKey, userId]
      );
      if (replay.rowCount > 0) {
        await client.query('COMMIT');
        return { replay: true, response: replay.rows[0].response };
      }
    }

    const fundsCheck = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
      [withdrawal.walletId, withdrawal.currency]
    );
    if (fundsCheck.rowCount === 0 || Number(fundsCheck.rows[0].amount) < Number(withdrawal.amount)) {
      await client.query('ROLLBACK');
      return { insufficientFunds: true };
    }

    const nextAmounts = getWalletCurrencyAmounts(runtimeStateDb, withdrawal.walletId, withdrawal.currency);
    await upsertWalletRows(
      client,
      withdrawal.walletId,
      withdrawal.currency,
      nextAmounts.balance,
      nextAmounts.hold
    );

    await upsertWithdrawal(client, withdrawal);

    const holdLedger = (runtimeStateDb.ledger || []).find((l) => l.withdrawalId === withdrawal.id && l.type === 'withdrawal_hold');
    if (holdLedger) {
      await client.query(
        `INSERT INTO ledger(
          id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        ) ON CONFLICT (id) DO NOTHING`,
        [
          holdLedger.id,
          holdLedger.withdrawalId || null,
          holdLedger.userId,
          holdLedger.walletId,
          holdLedger.currency,
          holdLedger.type,
          Number(holdLedger.amount || 0),
          Number(holdLedger.balanceBefore || 0),
          Number(holdLedger.balanceAfter || 0),
          msToDate(holdLedger.at || holdLedger.timestamp || Date.now()),
          holdLedger.by || null,
          holdLedger.note || null,
        ]
      );
    }

    if (userLimitTracking) {
      await client.query(
        'UPDATE users SET limit_tracking = $1::jsonb WHERE id = $2',
        [JSON.stringify(userLimitTracking), userId]
      );
    }

    if (clientKey) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(responseBody)]
      );
    }

    if (!skipRuntimeStateSync) {
      await upsertRuntimeState(client, runtimeStateDb);
    }
    await client.query('COMMIT');
    return { replay: false, insufficientFunds: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && clientKey) {
      const replay = await getDurableWithdrawalIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function commitWithdrawalTransitionPostgres({
  runtimeStateDb,
  withdrawal,
  expectedStatus,
  skipRuntimeStateSync = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      'SELECT id, status FROM withdrawals WHERE id = $1 FOR UPDATE',
      [withdrawal.id]
    );
    if (lock.rowCount === 0) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }
    if (expectedStatus && lock.rows[0].status !== expectedStatus) {
      await client.query('ROLLBACK');
      return { notFound: false, conflict: true };
    }

    const nextAmounts = getWalletCurrencyAmounts(runtimeStateDb, withdrawal.walletId, withdrawal.currency);
    await upsertWalletRows(
      client,
      withdrawal.walletId,
      withdrawal.currency,
      nextAmounts.balance,
      nextAmounts.hold
    );

    await upsertWithdrawal(client, withdrawal);

    const ledgers = (runtimeStateDb.ledger || []).filter((l) => l.withdrawalId === withdrawal.id);
    const latest = ledgers[ledgers.length - 1];
    if (latest) {
      await client.query(
        `INSERT INTO ledger(
          id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        ) ON CONFLICT (id) DO NOTHING`,
        [
          latest.id,
          latest.withdrawalId || null,
          latest.userId,
          latest.walletId,
          latest.currency,
          latest.type,
          Number(latest.amount || 0),
          Number(latest.balanceBefore || 0),
          Number(latest.balanceAfter || 0),
          msToDate(latest.at || latest.timestamp || Date.now()),
          latest.by || null,
          latest.note || null,
        ]
      );
    }

    if (!skipRuntimeStateSync) {
      await upsertRuntimeState(client, runtimeStateDb);
    }
    await client.query('COMMIT');
    return { notFound: false, conflict: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function upsertPayoutLockPostgres({ withdrawalId, pid, claimedAt, expiresAt }) {
  await pool.query(
    `INSERT INTO payout_locks(withdrawal_id, pid, claimed_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (withdrawal_id) DO UPDATE SET
       pid = EXCLUDED.pid,
       claimed_at = EXCLUDED.claimed_at,
       expires_at = EXCLUDED.expires_at`,
    [withdrawalId, pid, msToDate(claimedAt), msToDate(expiresAt)]
  );
}

async function releasePayoutLockPostgres({ withdrawalId }) {
  await pool.query('DELETE FROM payout_locks WHERE withdrawal_id = $1', [withdrawalId]);
}

module.exports = {
  getDurableWithdrawalIdempotency,
  commitCreateWithdrawalPostgres,
  commitWithdrawalTransitionPostgres,
  upsertPayoutLockPostgres,
  releasePayoutLockPostgres,
};
