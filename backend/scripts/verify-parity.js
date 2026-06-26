'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const {
  buildJsonSummary,
  buildPgMap,
  buildStringMap,
  compareMaps,
  compareRates,
  checkCounts,
} = require('./lib/parity-checks');
const { printHumanReport } = require('./lib/parity-report');

function parseArgs(argv) {
  const out = {
    file: path.join(__dirname, '..', 'db.proof-test.json'),
    strict: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') out.file = path.resolve(argv[i + 1]);
    if (arg === '--strict') out.strict = true;
    if (arg === '--json') out.json = true;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function getCounts(client) {
  const tables = [
    'users',
    'wallets',
    'transactions',
    'withdrawals',
    'ledger',
    'refresh_tokens',
    'password_reset_tokens',
    'idempotency_records',
    'employers',
    'employer_employees',
    'payroll_batches',
    'payment_requests',
  ];

  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
    counts[table] = Number(result.rows[0].count || 0);
  }
  return counts;
}

async function getWalletMap(client, tableName) {
  const result = await client.query(`
    SELECT wallet_id || ':' || currency AS key, amount
    FROM ${tableName}
  `);
  return buildPgMap(result.rows, 'key', 'amount');
}

async function getTxSumByCurrency(client) {
  const result = await client.query(`
    SELECT currency AS key, COALESCE(SUM(amount), 0)::bigint AS value
    FROM transactions
    GROUP BY currency
  `);
  return buildPgMap(result.rows, 'key', 'value');
}

async function getWithdrawalStatusCounts(client) {
  const result = await client.query(`
    SELECT status AS key, COUNT(*)::bigint AS value
    FROM withdrawals
    GROUP BY status
  `);
  return buildPgMap(result.rows, 'key', 'value');
}

async function getLedgerTypeCurrencySums(client) {
  const result = await client.query(`
    SELECT type || ':' || currency AS key, COALESCE(SUM(amount), 0)::bigint AS value
    FROM ledger
    GROUP BY type, currency
  `);
  return buildPgMap(result.rows, 'key', 'value');
}

async function getRates(client) {
  const rates = await client.query(`
    SELECT currency AS key, rate::text AS value
    FROM exchange_rates
  `);
  const meta = await client.query(`
    SELECT base, updated_at
    FROM exchange_rate_meta
    WHERE id = 1
  `);
  return {
    map: buildStringMap(rates.rows, 'key', 'value'),
    count: rates.rowCount,
    base: meta.rowCount > 0 ? meta.rows[0].base : null,
  };
}

async function getDbVersion(client) {
  const result = await client.query(`
    SELECT value
    FROM app_metadata
    WHERE key = 'db_version'
  `);
  if (result.rowCount === 0) return 0;
  const parsed = result.rows[0].value || {};
  return Number(parsed.version || 0);
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  const source = readJson(args.file);
  const expected = buildJsonSummary(source);

  const client = await pool.connect();
  const mismatches = [];
  try {
    const counts = await getCounts(client);
    mismatches.push(...checkCounts(expected.counts, counts));

    const walletBalances = await getWalletMap(client, 'wallet_balances');
    mismatches.push(...compareMaps('wallet_balances', expected.walletBalances, walletBalances));

    const walletHolds = await getWalletMap(client, 'wallet_holds');
    mismatches.push(...compareMaps('wallet_holds', expected.walletHolds, walletHolds));

    const txSums = await getTxSumByCurrency(client);
    mismatches.push(...compareMaps('transactions.sum_by_currency', expected.txAmountByCurrency, txSums));

    const withdrawalStatus = await getWithdrawalStatusCounts(client);
    mismatches.push(...compareMaps('withdrawals.status_counts', expected.withdrawalStatusCounts, withdrawalStatus));

    const ledgerSums = await getLedgerTypeCurrencySums(client);
    mismatches.push(...compareMaps('ledger.sum_by_type_currency', expected.ledgerAmountByTypeCurrency, ledgerSums));

    const rates = await getRates(client);
    if (expected.rates.base !== rates.base) {
      mismatches.push({
        check: 'rates.base',
        key: 'base',
        expected: expected.rates.base,
        actual: rates.base,
      });
    }
    if (expected.rates.count !== rates.count) {
      mismatches.push({
        check: 'rates.count',
        key: 'count',
        expected: expected.rates.count,
        actual: rates.count,
      });
    }
    mismatches.push(...compareRates(expected.rates.selected, rates.map));

    const dbVersion = await getDbVersion(client);
    if (dbVersion !== expected.dbVersion) {
      mismatches.push({
        check: 'metadata.db_version',
        key: 'db_version',
        expected: expected.dbVersion,
        actual: dbVersion,
      });
    }
  } finally {
    client.release();
  }

  const report = {
    passed: mismatches.length === 0,
    strict: args.strict,
    checkCount: 9,
    mismatches,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  if (args.strict && mismatches.length > 0) {
    throw new Error('strict parity check failed');
  }
  if (mismatches.length > 0) {
    throw new Error('parity check failed');
  }
}

run()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error('[db:parity] fatal:', error && error.stack ? error.stack : error);
    await pool.end();
    process.exit(1);
  });
