'use strict';
/**
 * Heal JSON app_state wallet display cache FROM authoritative PostgreSQL.
 *
 * Direction is always Postgres → JSON. Never the reverse.
 * Does not move money. Only rewrites the display cache so mobile/admin reads
 * match wallet_balances / wallet_holds.
 */

const { pool } = require('./pool');

function ensureWalletBalanceEntry(wallet, currency) {
  if (!Array.isArray(wallet.balances)) wallet.balances = [];
  let entry = wallet.balances.find((b) => b.currency === currency);
  if (!entry) {
    entry = { currency, amount: 0 };
    wallet.balances.push(entry);
  }
  return entry;
}

function ensureWalletHoldField(wallet) {
  if (!wallet.holdBalance || typeof wallet.holdBalance !== 'object') {
    wallet.holdBalance = {};
  }
  return wallet.holdBalance;
}

/**
 * Apply one authoritative available-balance into JSON cache.
 * @returns {boolean} true if the JSON amount changed
 */
function setJsonAvailableBalance(stateDb, walletId, currency, amountMinor) {
  const wallet = (stateDb.wallets || []).find((w) => w.id === walletId);
  if (!wallet) return false;
  const entry = ensureWalletBalanceEntry(wallet, String(currency).toUpperCase());
  const next = Math.max(0, Number(amountMinor) || 0);
  if (Number(entry.amount) === next) return false;
  entry.amount = next;
  return true;
}

/**
 * Apply one authoritative hold balance into JSON cache (wallet.holdBalance[currency]).
 */
function setJsonHoldBalance(stateDb, walletId, currency, amountMinor) {
  const wallet = (stateDb.wallets || []).find((w) => w.id === walletId);
  if (!wallet) return false;
  const holds = ensureWalletHoldField(wallet);
  const key = String(currency).toUpperCase();
  const next = Math.max(0, Number(amountMinor) || 0);
  const prev = Number(holds[key] || 0);
  if (prev === next) {
    if (next === 0 && Object.prototype.hasOwnProperty.call(holds, key)) {
      delete holds[key];
      return true;
    }
    return false;
  }
  if (next === 0) delete holds[key];
  else holds[key] = next;
  return true;
}

/**
 * Heal all (or selected) wallets in stateDb from Postgres.
 *
 * @param {object} stateDb
 * @param {object} [opts]
 * @param {string[]} [opts.walletIds] - limit to these wallets; default all PG rows
 * @param {import('pg').Pool} [opts.dbPool]
 * @returns {Promise<{ changed: number, scannedBalances: number, scannedHolds: number, details: object[] }>}
 */
async function healJsonBalancesFromPostgres(stateDb, opts = {}) {
  const dbPool = opts.dbPool || pool;
  const filterIds = Array.isArray(opts.walletIds) && opts.walletIds.length
    ? opts.walletIds.map(String)
    : null;

  let balSql = 'SELECT wallet_id::text AS wallet_id, currency, amount FROM wallet_balances';
  let balParams = [];
  if (filterIds) {
    balSql += ' WHERE wallet_id::text = ANY($1::text[])';
    balParams = [filterIds];
  }
  const balRes = await dbPool.query(balSql, balParams);

  let holdSql = 'SELECT wallet_id::text AS wallet_id, currency, amount FROM wallet_holds';
  let holdParams = [];
  if (filterIds) {
    holdSql += ' WHERE wallet_id::text = ANY($1::text[])';
    holdParams = [filterIds];
  }
  const holdRes = await dbPool.query(holdSql, holdParams);

  const details = [];
  let changed = 0;

  for (const row of balRes.rows) {
    const walletId = String(row.wallet_id);
    const currency = String(row.currency).toUpperCase();
    const postgresAmount = Number(row.amount);
    const wallet = (stateDb.wallets || []).find((w) => w.id === walletId);
    if (!wallet) {
      details.push({
        walletId, currency, kind: 'available',
        skipped: true, reason: 'wallet_missing_in_json',
        postgresAmount,
      });
      continue;
    }
    const entry = ensureWalletBalanceEntry(wallet, currency);
    const jsonBefore = Number(entry.amount);
    if (jsonBefore !== postgresAmount) {
      entry.amount = postgresAmount;
      changed += 1;
      details.push({
        walletId, currency, kind: 'available',
        jsonBefore, postgresAmount, healed: true,
      });
    }
  }

  for (const row of holdRes.rows) {
    const walletId = String(row.wallet_id);
    const currency = String(row.currency).toUpperCase();
    const postgresAmount = Number(row.amount);
    const wallet = (stateDb.wallets || []).find((w) => w.id === walletId);
    if (!wallet) {
      details.push({
        walletId, currency, kind: 'hold',
        skipped: true, reason: 'wallet_missing_in_json',
        postgresAmount,
      });
      continue;
    }
    const holds = ensureWalletHoldField(wallet);
    const jsonBefore = Number(holds[currency] || 0);
    if (jsonBefore !== postgresAmount) {
      if (postgresAmount === 0) delete holds[currency];
      else holds[currency] = postgresAmount;
      changed += 1;
      details.push({
        walletId, currency, kind: 'hold',
        jsonBefore, postgresAmount, healed: true,
      });
    }
  }

  return {
    changed,
    scannedBalances: balRes.rowCount,
    scannedHolds: holdRes.rowCount,
    details: details.filter((d) => d.healed || d.skipped),
  };
}

module.exports = {
  setJsonAvailableBalance,
  setJsonHoldBalance,
  healJsonBalancesFromPostgres,
};
