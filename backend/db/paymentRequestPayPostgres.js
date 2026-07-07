'use strict';

const { pool } = require('./pool');
const { alignWalletBalanceBeforeMutation } = require('./walletBalanceAlign');
const { msToDate, upsertRuntimeWalletMetadata } = require('./runtimeWalletSync');

function mapTxRow(tx) {
  return {
    id: tx.id,
    from_wallet_id: tx.fromWalletId,
    to_wallet_id: tx.toWalletId,
    amount: tx.amount,
    currency: tx.currency,
    debit_amount: tx.debitAmount || tx.amount,
    debit_currency: tx.debitCurrency || tx.currency,
    sender_cross_currency: !!tx.senderCrossCurrency,
    received_amount: tx.receivedAmount || tx.amount,
    received_currency: tx.receivedCurrency || tx.currency,
    was_converted: !!tx.wasConverted,
    fx_fee_amount: tx.fxFeeAmount || 0,
    send_fee_amount: tx.sendFeeAmount || 0,
    type: tx.type || null,
    status: tx.status || 'completed',
    memo: tx.memo || '',
    direction: tx.direction || null,
    stripe_intent_id: tx.stripeIntentId || null,
    fee_amount: tx.feeAmount || null,
    fee_rate: tx.feeRate || null,
    gross_amount: tx.grossAmount || null,
    timestamp: msToDate(tx.timestamp),
  };
}

function mapRequestRow(row) {
  return {
    id: row.id,
    requesterId: row.requester_id,
    walletId: row.wallet_id,
    targetWalletId: row.target_wallet_id,
    targetEmployerId: row.target_employer_id,
    amount: Number(row.amount || 0),
    currency: row.currency,
    memo: row.memo || '',
    status: row.status,
    type: row.type || null,
    payrollMetadata: row.payroll_metadata || null,
    complianceFlags: row.compliance_flags || null,
    paidAt: row.paid_at ? new Date(row.paid_at).getTime() : null,
    paidBy: row.paid_by || null,
    transactionId: row.transaction_id || null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).getTime() : null,
    cancelReason: row.cancel_reason || null,
    settledByTransactionId: row.settled_by_transaction_id || null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

function mapTransactionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromWalletId: row.from_wallet_id,
    toWalletId: row.to_wallet_id,
    amount: Number(row.amount || 0),
    currency: row.currency,
    debitAmount: row.debit_amount === null ? null : Number(row.debit_amount),
    debitCurrency: row.debit_currency || null,
    senderCrossCurrency: !!row.sender_cross_currency,
    receivedAmount: row.received_amount === null ? null : Number(row.received_amount),
    receivedCurrency: row.received_currency || null,
    wasConverted: !!row.was_converted,
    fxFeeAmount: row.fx_fee_amount === null ? null : Number(row.fx_fee_amount),
    sendFeeAmount: row.send_fee_amount === null ? null : Number(row.send_fee_amount),
    memo: row.memo || '',
    status: row.status || 'completed',
    timestamp: row.timestamp ? new Date(row.timestamp).getTime() : null,
    type: row.type || null,
  };
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


async function upsertRuntimePaymentRequest(client, request) {
  if (!request || !request.id) return;
  const requesterId = request.requesterId || request.userId || null;
  if (!requesterId) return;
  const safeStatus = request.status === 'cancelled' ? 'cancelled' : 'pending';
  const safeTransactionId = null;
  const safePaidBy = null;
  const safeSettledByTransactionId = null;
  await client.query(
    `INSERT INTO payment_requests (
      id, requester_id, wallet_id, target_wallet_id, target_employer_id,
      amount, currency, memo, status, type, payroll_metadata, compliance_flags,
      paid_at, paid_by, transaction_id, cancelled_at, cancel_reason, settled_by_transaction_id, created_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19
    )
    ON CONFLICT (id) DO UPDATE SET
      requester_id = EXCLUDED.requester_id,
      wallet_id = EXCLUDED.wallet_id,
      target_wallet_id = EXCLUDED.target_wallet_id,
      target_employer_id = EXCLUDED.target_employer_id,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      memo = EXCLUDED.memo,
      status = EXCLUDED.status,
      type = EXCLUDED.type,
      payroll_metadata = EXCLUDED.payroll_metadata,
      compliance_flags = EXCLUDED.compliance_flags`,
    [
      request.id,
      requesterId,
      request.walletId || null,
      request.targetWalletId || null,
      request.targetEmployerId || null,
      Number(request.amount || 0),
      request.currency || 'USD',
      request.memo || '',
      safeStatus,
      request.type || null,
      JSON.stringify(request.payrollMetadata || null),
      JSON.stringify(request.complianceFlags || null),
      null,
      safePaidBy,
      safeTransactionId,
      request.cancelledAt ? msToDate(request.cancelledAt) : null,
      request.cancelReason || null,
      safeSettledByTransactionId,
      msToDate(request.createdAt),
    ]
  );
}

async function syncRuntimePaymentRequestGraph(client, { stateDb, requestId, payerUserId, fromWalletId, toWalletId }) {
  if (!stateDb) return;
  const users = stateDb.users || [];
  const wallets = stateDb.wallets || [];
  const requests = stateDb.paymentRequests || [];
  const request = requests.find((r) => r.id === requestId);
  const fromWallet = wallets.find((w) => w.id === fromWalletId);
  const payeeWallet = wallets.find((w) => w.id === toWalletId) || (request ? wallets.find((w) => w.id === request.walletId) : null);
  const payerUser = users.find((u) => u.id === payerUserId) || (fromWallet ? users.find((u) => u.id === fromWallet.userId) : null);
  const requesterId = request ? (request.requesterId || request.userId) : null;
  const requesterUser = requesterId ? users.find((u) => u.id === requesterId) : null;

  await upsertRuntimeUser(client, payerUser);
  await upsertRuntimeUser(client, requesterUser);
  await upsertRuntimeWalletMetadata(client, fromWallet);
  await upsertRuntimeWalletMetadata(client, payeeWallet);
  await upsertRuntimePaymentRequest(client, request);
}

async function getDurablePaymentRequestIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function commitPaymentRequestPayPostgres({
  requestId,
  fromWalletId,
  toWalletId,
  debitCurrency,
  debitAmount,
  requestCurrency,
  requestAmount,
  tx,
  clientKey,
  userId,
  responseBody,
  payerLimitTracking,
  employerPayrollLimitTracking,
  employerId,
  stateDb,
  skipRuntimeStateSync = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await syncRuntimePaymentRequestGraph(client, {
      stateDb,
      requestId,
      payerUserId: userId,
      fromWalletId,
      toWalletId,
    });

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

    const reqRowResult = await client.query(
      `SELECT *
       FROM payment_requests
       WHERE id = $1
       FOR UPDATE`,
      [requestId]
    );
    if (reqRowResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { requestNotFound: true };
    }
    const reqRow = reqRowResult.rows[0];

    if (reqRow.status === 'paid') {
      if (reqRow.paid_by === userId && reqRow.transaction_id) {
        const txRow = await client.query(
          'SELECT * FROM transactions WHERE id = $1 LIMIT 1',
          [reqRow.transaction_id]
        );
        const replayBody = {
          request: mapRequestRow(reqRow),
          transaction: mapTransactionRow(txRow.rows[0] || null),
          idempotentReplay: true,
        };
        await client.query('COMMIT');
        return { replay: true, response: replayBody };
      }
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    if (reqRow.status !== 'pending') {
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    await client.query(
      'SELECT id FROM wallets WHERE id IN ($1, $2) ORDER BY id FOR UPDATE',
      [fromWalletId, toWalletId]
    );

    const payerAligned = await alignWalletBalanceBeforeMutation(
      client,
      fromWalletId,
      debitCurrency,
      stateDb,
      { pendingDebit: debitAmount }
    );
    if (payerAligned.amount < Number(debitAmount)) {
      await client.query('ROLLBACK');
      return { insufficientFunds: true };
    }

    await alignWalletBalanceBeforeMutation(
      client,
      toWalletId,
      requestCurrency,
      stateDb,
      { pendingCredit: requestAmount }
    );

    await client.query(
      'UPDATE wallet_balances SET amount = amount - $1 WHERE wallet_id = $2 AND currency = $3',
      [debitAmount, fromWalletId, debitCurrency]
    );
    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [requestAmount, toWalletId, requestCurrency]
    );

    const txRow = mapTxRow(tx);
    await client.query(
      `INSERT INTO transactions (
        id, from_wallet_id, to_wallet_id, amount, currency, debit_amount, debit_currency,
        sender_cross_currency, received_amount, received_currency, was_converted, fx_fee_amount,
        send_fee_amount, type, status, memo, direction, stripe_intent_id, fee_amount, fee_rate,
        gross_amount, timestamp
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
      )`,
      [
        txRow.id,
        txRow.from_wallet_id,
        txRow.to_wallet_id,
        txRow.amount,
        txRow.currency,
        txRow.debit_amount,
        txRow.debit_currency,
        txRow.sender_cross_currency,
        txRow.received_amount,
        txRow.received_currency,
        txRow.was_converted,
        txRow.fx_fee_amount,
        txRow.send_fee_amount,
        txRow.type,
        txRow.status,
        txRow.memo,
        txRow.direction,
        txRow.stripe_intent_id,
        txRow.fee_amount,
        txRow.fee_rate,
        txRow.gross_amount,
        txRow.timestamp,
      ]
    );

    await client.query(
      `UPDATE payment_requests
       SET status = 'paid',
           paid_at = NOW(),
           paid_by = $1,
           transaction_id = $2
       WHERE id = $3`,
      [userId, tx.id, requestId]
    );

    if (payerLimitTracking) {
      await client.query(
        'UPDATE users SET limit_tracking = $1::jsonb WHERE id = $2',
        [JSON.stringify(payerLimitTracking), userId]
      );
    }

    if (employerPayrollLimitTracking && employerId) {
      await client.query(
        'UPDATE employers SET payroll_limit_tracking = $1::jsonb WHERE id = $2',
        [JSON.stringify(employerPayrollLimitTracking), employerId]
      );
    }

    if (clientKey) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(responseBody)]
      );
    }

    await client.query('COMMIT');
    return { replay: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && clientKey) {
      const replay = await getDurablePaymentRequestIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getDurablePaymentRequestIdempotency,
  commitPaymentRequestPayPostgres,
};
