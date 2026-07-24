'use strict';

const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { lockWalletBalanceRow } = require('./walletBalanceAlign');
const { msToDate, upsertRuntimeWalletMetadata } = require('./runtimeWalletSync');

function mapTxRow(tx) {
  return {
    id: tx.id,
    from_wallet_id: tx.fromWalletId,
    to_wallet_id: tx.toWalletId,
    amount: tx.amount,
    currency: tx.currency,
    debit_amount: tx.debitAmount,
    debit_currency: tx.debitCurrency,
    sender_cross_currency: !!tx.senderCrossCurrency,
    received_amount: tx.receivedAmount,
    received_currency: tx.receivedCurrency,
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


async function syncRuntimeP2PGraph(client, { stateDb, userId, fromWalletId, toWalletId, recipientUserId }) {
  if (!stateDb) return;
  const users = stateDb.users || [];
  const wallets = stateDb.wallets || [];
  const fromWallet = wallets.find((w) => w.id === fromWalletId);
  const toWallet = wallets.find((w) => w.id === toWalletId);
  const senderUser = users.find((u) => u.id === userId) || (fromWallet ? users.find((u) => u.id === fromWallet.userId) : null);
  const receiverUser = users.find((u) => u.id === recipientUserId) || (toWallet ? users.find((u) => u.id === toWallet.userId) : null);
  await upsertRuntimeUser(client, senderUser);
  await upsertRuntimeUser(client, receiverUser);
  await upsertRuntimeWalletMetadata(client, fromWallet);
  await upsertRuntimeWalletMetadata(client, toWallet);
}

async function getDurableP2PIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  if (result.rowCount === 0) return null;
  return result.rows[0].response || null;
}

async function commitP2PSendPostgres({
  fromWalletId,
  toWalletId,
  debitCurrency,
  debitAmount,
  receivedCurrency,
  receivedAmount,
  tx,
  clientKey,
  userId,
  responseBody,
  senderLimitTracking,
  stateDb,
  recipientUserId,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await syncRuntimeP2PGraph(client, { stateDb, userId, fromWalletId, toWalletId, recipientUserId });

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

    await client.query(
      'SELECT id FROM wallets WHERE id IN ($1, $2) ORDER BY id FOR UPDATE',
      [fromWalletId, toWalletId]
    );

    // Postgres is the sole source of truth for the pre-operation balance —
    // never derived from (or overwritten by) the JSON app_metadata blob,
    // except as a one-time seed if this wallet/currency has never been
    // touched in Postgres before (see lockWalletBalanceRow doc comment).
    const debitBefore = await lockWalletBalanceRow(client, fromWalletId, debitCurrency, {
      stateDb, pendingDebit: debitAmount,
    });
    if (debitBefore < Number(debitAmount)) {
      await client.query('ROLLBACK');
      return { replay: false, insufficientFunds: true };
    }

    const destBefore = await lockWalletBalanceRow(client, toWalletId, receivedCurrency, {
      stateDb, pendingCredit: receivedAmount,
    });

    await client.query(
      'UPDATE wallet_balances SET amount = amount - $1 WHERE wallet_id = $2 AND currency = $3',
      [debitAmount, fromWalletId, debitCurrency]
    );

    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [receivedAmount, toWalletId, receivedCurrency]
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

    // Append debit/credit ledger entries for P2P sends.
    await client.query(
      `INSERT INTO ledger(
        id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
      ) VALUES
        ($1, NULL, $2, $3, $4, 'p2p_send_debit',  $5, $6, $7, $8, 'system', $9),
        ($10, NULL, $11, $12, $13, 'p2p_send_credit', $14, $15, $16, $17, 'system', $18)`,
      [
        uuidv4(),
        userId,
        fromWalletId,
        debitCurrency,
        debitAmount,
        debitBefore,
        debitBefore - Number(debitAmount),
        txRow.timestamp,
        `p2p:${txRow.id}`,
        uuidv4(),
        recipientUserId || null,
        toWalletId,
        receivedCurrency,
        receivedAmount,
        destBefore,
        destBefore + Number(receivedAmount),
        txRow.timestamp,
        `p2p:${txRow.id}`,
      ]
    );

    if (clientKey) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(responseBody)]
      );
    }

    if (senderLimitTracking) {
      await client.query(
        'UPDATE users SET limit_tracking = $1::jsonb WHERE id = $2',
        [JSON.stringify(senderLimitTracking), userId]
      );
    }

    await client.query('COMMIT');
    // Return the true post-commit Postgres balances so the caller can heal
    // its JSON display cache to match the authoritative ledger, instead of
    // trusting its own pre-computed (and potentially stale) in-memory guess.
    return {
      replay: false,
      insufficientFunds: false,
      debitWalletBalanceAfter: debitBefore - Number(debitAmount),
      creditWalletBalanceAfter: destBefore + Number(receivedAmount),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && clientKey) {
      const replay = await getDurableP2PIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getDurableP2PIdempotency,
  commitP2PSendPostgres,
};
