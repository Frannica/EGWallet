'use strict';

const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');

function msToDate(ms) {
  return new Date(Number(ms || Date.now()));
}

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
    received_amount: tx.receivedAmount,
    received_currency: tx.receivedCurrency,
    was_converted: !!tx.wasConverted,
    fx_fee_amount: tx.fxFeeAmount || 0,
    send_fee_amount: tx.sendFeeAmount || 0,
    type: tx.type || 'exchange',
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

async function getDurableExchangeIdempotency(clientKey, userId) {
  if (!clientKey) return null;
  const result = await pool.query(
    'SELECT response FROM idempotency_records WHERE key = $1 AND user_id = $2 LIMIT 1',
    [clientKey, userId]
  );
  return result.rowCount > 0 ? result.rows[0].response || null : null;
}

async function commitExchangePostgres({
  walletId,
  fromCurrency,
  toCurrency,
  amount,
  netReceived,
  tx,
  clientKey,
  userId,
  responseBody,
  senderLimitTracking,
  runtimeStateDb,
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

    await client.query(
      'SELECT id FROM wallets WHERE id = $1 FOR UPDATE',
      [walletId]
    );

    const fromRow = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
      [walletId, fromCurrency]
    );
    if (fromRow.rowCount === 0 || Number(fromRow.rows[0].amount) < Number(amount)) {
      await client.query('ROLLBACK');
      return { insufficientFunds: true };
    }

    const toRow = await client.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
      [walletId, toCurrency]
    );

    await client.query(
      'UPDATE wallet_balances SET amount = amount - $1 WHERE wallet_id = $2 AND currency = $3',
      [amount, walletId, fromCurrency]
    );
    if (toRow.rowCount > 0) {
      await client.query(
        'UPDATE wallet_balances SET amount = amount + $1 WHERE wallet_id = $2 AND currency = $3',
        [netReceived, walletId, toCurrency]
      );
    } else {
      await client.query(
        'INSERT INTO wallet_balances(wallet_id, currency, amount) VALUES ($1, $2, $3)',
        [walletId, toCurrency, netReceived]
      );
    }

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
      ) VALUES
        ($1, NULL, $2, $3, $4, 'exchange_debit', $5, $6, $7, $8, 'system', $9),
        ($10, NULL, $11, $12, $13, 'exchange_credit', $14, $15, $16, $17, 'system', $18)`,
      [
        uuidv4(),
        userId,
        walletId,
        fromCurrency,
        amount,
        Number(fromRow.rows[0].amount),
        Number(fromRow.rows[0].amount) - Number(amount),
        txRow.timestamp,
        `exchange:${txRow.id}`,
        uuidv4(),
        userId,
        walletId,
        toCurrency,
        netReceived,
        toRow.rowCount > 0 ? Number(toRow.rows[0].amount) : 0,
        (toRow.rowCount > 0 ? Number(toRow.rows[0].amount) : 0) + Number(netReceived),
        txRow.timestamp,
        `exchange:${txRow.id}`,
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

    if (runtimeStateDb) {
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

    await client.query('COMMIT');
    return { replay: false, insufficientFunds: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && clientKey) {
      const replay = await getDurableExchangeIdempotency(clientKey, userId);
      if (replay) return { replay: true, response: replay };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getDurableExchangeIdempotency,
  commitExchangePostgres,
};
