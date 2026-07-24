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
    debit_amount: tx.debitAmount === undefined ? tx.amount : tx.debitAmount,
    debit_currency: tx.debitCurrency || tx.currency,
    sender_cross_currency: !!tx.senderCrossCurrency,
    received_amount: tx.receivedAmount === undefined ? tx.amount : tx.receivedAmount,
    received_currency: tx.receivedCurrency || tx.currency,
    was_converted: !!tx.wasConverted,
    fx_fee_amount: tx.fxFeeAmount || 0,
    send_fee_amount: tx.sendFeeAmount || 0,
    type: tx.type || 'deposit',
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

function mapTransactionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type || null,
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
    feeAmount: row.fee_amount === null ? null : Number(row.fee_amount),
    feeRate: row.fee_rate === null ? null : Number(row.fee_rate),
    grossAmount: row.gross_amount === null ? null : Number(row.gross_amount),
    status: row.status || 'completed',
    timestamp: row.timestamp ? new Date(row.timestamp).getTime() : null,
    memo: row.memo || '',
    direction: row.direction || null,
    stripeIntentId: row.stripe_intent_id || null,
  };
}

async function syncRuntimeWalletGraph(client, { stateDb, userId, walletId }) {
  if (!stateDb) return;
  const users = stateDb.users || [];
  const wallets = stateDb.wallets || [];
  const user = users.find((u) => u.id === userId);
  const wallet = wallets.find((w) => w.id === walletId && w.userId === userId);
  if (!user || !wallet) return;

  const email = user.email || `${userId}@runtime.local`;
  const passwordHash = user.passwordHash || user.password_hash || 'x';
  const region = user.region || 'US';
  const role = user.role || 'individual';
  const preferredCurrency = user.preferredCurrency || null;
  const limitTracking = user.limitTracking ? JSON.stringify(user.limitTracking) : '{}';
  const createdAt = msToDate(user.createdAt || Date.now());

  await client.query(
    `INSERT INTO users (
      id, email, password_hash, region, role, preferred_currency, limit_tracking, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8
    )
    ON CONFLICT (id) DO NOTHING`,
    [userId, email, passwordHash, region, role, preferredCurrency, limitTracking, createdAt]
  );

  await upsertRuntimeWalletMetadata(client, wallet);
}

async function fetchReplayByIntent(intentId, currencyHint) {
  if (!intentId) return null;
  const txResult = await pool.query(
    'SELECT * FROM transactions WHERE stripe_intent_id = $1 LIMIT 1',
    [intentId]
  );
  if (txResult.rowCount === 0) return null;

  const txRow = txResult.rows[0];
  const balanceCurrency = txRow.currency || currencyHint;
  return {
    success: true,
    transaction: mapTransactionRow(txRow),
    currency: balanceCurrency,
    alreadyProcessed: true,
  };
}

async function commitDepositConfirmPostgres({
  walletId,
  currency,
  netCredited,
  tx,
  userId,
  intentId,
  stateDb,
  clientKey,
  idempotencyResponse,
  skipRuntimeStateSync = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await syncRuntimeWalletGraph(client, { stateDb, userId, walletId });

    const wallet = await client.query(
      'SELECT id FROM wallets WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [walletId, userId]
    );
    if (wallet.rowCount === 0) {
      await client.query('ROLLBACK');
      return { walletNotFound: true };
    }

    const existing = await client.query(
      'SELECT * FROM transactions WHERE stripe_intent_id = $1 LIMIT 1',
      [intentId]
    );
    if (existing.rowCount > 0) {
      const replayCurrency = existing.rows[0].currency || currency;
      await client.query('COMMIT');
      return {
        replay: true,
        response: {
          success: true,
          transaction: mapTransactionRow(existing.rows[0]),
          currency: replayCurrency,
          alreadyProcessed: true,
        },
      };
    }

    // Postgres is the sole source of truth for the pre-operation balance
    // (JSON only ever seeds a brand-new, never-before-seen row).
    const beforeAmount = await lockWalletBalanceRow(client, walletId, currency, {
      stateDb, pendingCredit: netCredited,
    });
    const afterAmount = beforeAmount + Number(netCredited);

    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [netCredited, walletId, currency]
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
      `INSERT INTO ledger(
        id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
      ) VALUES (
        $1, NULL, $2, $3, $4, 'deposit_credit', $5, $6, $7, $8, 'system', $9
      )`,
      [
        uuidv4(),
        userId,
        walletId,
        currency,
        netCredited,
        beforeAmount,
        afterAmount,
        txRow.timestamp,
        `deposit:${txRow.id}`,
      ]
    );

    if (clientKey && idempotencyResponse) {
      await client.query(
        'INSERT INTO idempotency_records(key, user_id, response, timestamp) VALUES ($1, $2, $3::jsonb, NOW())',
        [clientKey, userId, JSON.stringify(idempotencyResponse)]
      );
    }

    await client.query('COMMIT');
    return { replay: false, newBalance: afterAmount };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && intentId) {
      const replayResponse = await fetchReplayByIntent(intentId, currency);
      if (replayResponse) return { replay: true, response: replayResponse };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  fetchReplayByIntent,
  commitDepositConfirmPostgres,
};
