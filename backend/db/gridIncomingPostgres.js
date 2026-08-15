'use strict';

/**
 * Atomic Grid incoming-payment credit.
 * Mirrors commitDepositConfirmPostgres: lock wallet_balances, insert
 * transactions + ledger in one transaction. Idempotent on grid_transaction_id.
 * Never writes stripe_intent_id.
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { lockWalletBalanceRow } = require('./walletBalanceAlign');
const { msToDate, upsertRuntimeWalletMetadata } = require('./runtimeWalletSync');

function mapTransactionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type || null,
    fromWalletId: row.from_wallet_id,
    toWalletId: row.to_wallet_id,
    amount: Number(row.amount || 0),
    currency: row.currency,
    receivedAmount: row.received_amount === null ? null : Number(row.received_amount),
    receivedCurrency: row.received_currency || null,
    status: row.status || 'completed',
    timestamp: row.timestamp ? new Date(row.timestamp).getTime() : null,
    memo: row.memo || '',
    direction: row.direction || null,
    stripeIntentId: row.stripe_intent_id || null,
    gridTransactionId: row.grid_transaction_id || null,
  };
}

async function fetchReplayByGridTransaction(gridTransactionId, currencyHint) {
  if (!gridTransactionId) return null;
  const txResult = await pool.query(
    'SELECT * FROM transactions WHERE grid_transaction_id = $1 LIMIT 1',
    [gridTransactionId]
  );
  if (txResult.rowCount === 0) return null;
  const txRow = txResult.rows[0];
  return {
    success: true,
    transaction: mapTransactionRow(txRow),
    currency: txRow.currency || currencyHint,
    alreadyProcessed: true,
  };
}

async function syncRuntimeWalletGraph(client, { stateDb, userId, walletId }) {
  if (!stateDb) return;
  const user = (stateDb.users || []).find((u) => u.id === userId);
  const wallet = (stateDb.wallets || []).find((w) => w.id === walletId && w.userId === userId);
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

async function commitGridIncomingCreditPostgres({
  walletId,
  userId,
  currency,
  netCredited,
  tx,
  gridTransactionId,
  stateDb,
}) {
  if (!gridTransactionId) {
    return { credited: false, reason: 'missing_reference' };
  }

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
      return { credited: false, reason: 'wallet_not_found' };
    }

    const existing = await client.query(
      'SELECT * FROM transactions WHERE grid_transaction_id = $1 LIMIT 1',
      [gridTransactionId]
    );
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return {
        credited: false,
        reason: 'duplicate',
        replay: true,
        transaction: mapTransactionRow(existing.rows[0]),
        newBalance: null,
      };
    }

    const beforeAmount = await lockWalletBalanceRow(client, walletId, currency, {
      stateDb,
      pendingCredit: netCredited,
    });
    const afterAmount = beforeAmount + Number(netCredited);

    await client.query(
      'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
      [netCredited, walletId, currency]
    );

    const timestamp = msToDate(tx.timestamp);
    await client.query(
      `INSERT INTO transactions (
        id, from_wallet_id, to_wallet_id, amount, currency, debit_amount, debit_currency,
        sender_cross_currency, received_amount, received_currency, was_converted, fx_fee_amount,
        send_fee_amount, type, status, memo, direction, stripe_intent_id, fee_amount, fee_rate,
        gross_amount, timestamp, grid_transaction_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      )`,
      [
        tx.id,
        null,
        walletId,
        netCredited,
        currency,
        netCredited,
        currency,
        false,
        netCredited,
        currency,
        false,
        0,
        0,
        'grid_incoming',
        'completed',
        tx.memo || 'Incoming payment via Lightspark Grid',
        'in',
        null,
        0,
        0,
        netCredited,
        timestamp,
        gridTransactionId,
      ]
    );

    await client.query(
      `INSERT INTO ledger(
        id, withdrawal_id, user_id, wallet_id, currency, type, amount, balance_before, balance_after, at, by_actor, note
      ) VALUES (
        $1, NULL, $2, $3, $4, 'grid_incoming_credit', $5, $6, $7, $8, 'system', $9
      )`,
      [
        uuidv4(),
        userId,
        walletId,
        currency,
        netCredited,
        beforeAmount,
        afterAmount,
        timestamp,
        `grid_incoming:${gridTransactionId}`,
      ]
    );

    await client.query('COMMIT');
    return { credited: true, reason: 'credited', replay: false, newBalance: afterAmount };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollback) { /* ignore */ }
    if (error.code === '23505' && gridTransactionId) {
      const replay = await fetchReplayByGridTransaction(gridTransactionId, currency);
      if (replay) return { credited: false, reason: 'duplicate', replay: true, transaction: replay.transaction };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  commitGridIncomingCreditPostgres,
  fetchReplayByGridTransaction,
};
