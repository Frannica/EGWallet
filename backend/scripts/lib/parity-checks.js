'use strict';

function toMinorMapFromJsonWallets(wallets, keyName) {
  const map = {};
  for (const wallet of wallets || []) {
    if (keyName === 'balances') {
      for (const b of wallet.balances || []) {
        map[`${wallet.id}:${b.currency}`] = Number(b.amount || 0);
      }
      continue;
    }

    const hold = wallet.holdBalance || {};
    for (const currency of Object.keys(hold)) {
      map[`${wallet.id}:${currency}`] = Number(hold[currency] || 0);
    }
  }
  return map;
}

function sumByCurrencyJson(items, amountKey = 'amount', currencyKey = 'currency') {
  const out = {};
  for (const item of items || []) {
    const currency = item[currencyKey];
    if (!currency) continue;
    out[currency] = (out[currency] || 0) + Number(item[amountKey] || 0);
  }
  return out;
}

function countByKey(items, key) {
  const out = {};
  for (const item of items || []) {
    const value = item[key] || 'null';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function buildJsonSummary(db) {
  return {
    counts: {
      users: (db.users || []).length,
      wallets: (db.wallets || []).length,
      transactions: (db.transactions || []).length,
      withdrawals: (db.withdrawals || []).length,
      ledger: (db.ledger || []).length,
      refresh_tokens: (db.refreshTokens || []).length,
      password_reset_tokens: (db.passwordResetTokens || []).length,
      idempotency_records: (db.idempotencyRecords || []).length,
      employers: (db.employers || []).length,
      employer_employees: (db.employerEmployees || []).length,
      payroll_batches: (db.payrollBatches || []).length,
      payment_requests: (db.paymentRequests || []).length,
    },
    walletBalances: toMinorMapFromJsonWallets(db.wallets || [], 'balances'),
    walletHolds: toMinorMapFromJsonWallets(db.wallets || [], 'holds'),
    txAmountByCurrency: sumByCurrencyJson(db.transactions || []),
    withdrawalStatusCounts: countByKey(db.withdrawals || [], 'status'),
    ledgerAmountByTypeCurrency: (() => {
      const out = {};
      for (const row of db.ledger || []) {
        const key = `${row.type || 'unknown'}:${row.currency || 'unknown'}`;
        out[key] = (out[key] || 0) + Number(row.amount || 0);
      }
      return out;
    })(),
    rates: {
      base: db.rates && db.rates.base ? db.rates.base : 'USD',
      count: Object.keys((db.rates && db.rates.values) || {}).length,
      selected: {
        USD: Number((db.rates && db.rates.values && db.rates.values.USD) || 0),
        EUR: Number((db.rates && db.rates.values && db.rates.values.EUR) || 0),
        GBP: Number((db.rates && db.rates.values && db.rates.values.GBP) || 0),
        XAF: Number((db.rates && db.rates.values && db.rates.values.XAF) || 0),
        XOF: Number((db.rates && db.rates.values && db.rates.values.XOF) || 0),
      },
    },
    dbVersion: Number(db._dbVersion || 0),
  };
}

function buildPgMap(rows, keyField, valueField) {
  const out = {};
  for (const row of rows) out[row[keyField]] = Number(row[valueField] || 0);
  return out;
}

function buildStringMap(rows, keyField, valueField) {
  const out = {};
  for (const row of rows) out[row[keyField]] = String(row[valueField] || '');
  return out;
}

function compareMaps(name, expected, actual) {
  const mismatches = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    if (String(expected[key] ?? '') !== String(actual[key] ?? '')) {
      mismatches.push({ check: name, key, expected: expected[key] ?? null, actual: actual[key] ?? null });
    }
  }
  return mismatches;
}

function compareRates(selected, actual) {
  const mismatches = [];
  for (const [currency, expected] of Object.entries(selected)) {
    const actualNum = Number(actual[currency] || 0);
    if (Math.abs(expected - actualNum) > 1e-9) {
      mismatches.push({ check: 'rates.selected', key: currency, expected, actual: actualNum });
    }
  }
  return mismatches;
}

function checkCounts(expectedCounts, actualCounts) {
  return compareMaps('counts', expectedCounts, actualCounts);
}

module.exports = {
  buildJsonSummary,
  buildPgMap,
  buildStringMap,
  compareMaps,
  compareRates,
  checkCounts,
};
