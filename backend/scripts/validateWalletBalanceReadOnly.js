'use strict';
/**
 * READ-ONLY production wallet-balance validation.
 * Never mutates wallets, ledger, Stripe, or Kora.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/validateWalletBalanceReadOnly.js
 *
 * Optional:
 *   VALIDATE_EMAIL=buah@buah.com
 */
const { Client } = require('pg');

const EMAIL = process.env.VALIDATE_EMAIL || 'buah@buah.com';

function minorToMajor(n) {
  return (Number(n) / 100).toFixed(2);
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL / DATABASE_PUBLIC_URL required');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: /railway|proxy|rlwy/i.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  const checks = [];
  const pass = (id, detail) => checks.push({ id, result: 'PASS', detail });
  const fail = (id, detail) => checks.push({ id, result: 'FAIL', detail });

  // --- User ---
  const userRes = await client.query(
    `SELECT id, email, status, created_at
       FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [EMAIL]
  );
  if (!userRes.rowCount) {
    fail('user.exists', `No user for ${EMAIL}`);
    console.log(JSON.stringify({ ok: false, email: EMAIL, checks }, null, 2));
    await client.end();
    process.exit(2);
  }
  const user = userRes.rows[0];
  pass('user.exists', { id: user.id, email: user.email, status: user.status });

  // --- Wallets + authoritative balances + holds ---
  const walletsRes = await client.query(
    `SELECT id::text AS id, user_id::text AS user_id, type, created_at
       FROM wallets WHERE user_id::text = $1 ORDER BY created_at`,
    [String(user.id)]
  );
  const wallets = walletsRes.rows;
  if (!wallets.length) fail('wallets.exist', 'No wallets');
  else pass('wallets.exist', { count: wallets.length, ids: wallets.map((w) => w.id) });

  const walletIds = wallets.map((w) => String(w.id));
  const balRes = await client.query(
    `SELECT wallet_id::text AS wallet_id, currency, amount
       FROM wallet_balances
      WHERE wallet_id::text = ANY($1::text[])
      ORDER BY wallet_id, currency`,
    [walletIds]
  );
  const holdRes = await client.query(
    `SELECT wallet_id::text AS wallet_id, currency, amount
       FROM wallet_holds
      WHERE wallet_id::text = ANY($1::text[])
      ORDER BY wallet_id, currency`,
    [walletIds]
  );

  const pgBalances = balRes.rows.map((r) => ({
    walletId: r.wallet_id,
    currency: r.currency,
    amountMinor: Number(r.amount),
    amountMajor: minorToMajor(r.amount),
  }));
  const pgHolds = holdRes.rows.map((r) => ({
    walletId: r.wallet_id,
    currency: r.currency,
    amountMinor: Number(r.amount),
    amountMajor: minorToMajor(r.amount),
  }));

  // Non-negative balances (schema CHECK, but verify)
  const negative = pgBalances.filter((b) => b.amountMinor < 0);
  if (negative.length) fail('balances.non_negative', negative);
  else pass('balances.non_negative', { currencies: pgBalances.length });

  // --- JSON app_state cache vs Postgres ---
  const metaRes = await client.query(
    `SELECT value FROM app_metadata WHERE key = 'app_state' LIMIT 1`
  );
  let jsonWallets = [];
  let jsonUser = null;
  if (metaRes.rowCount) {
    const state = typeof metaRes.rows[0].value === 'string'
      ? JSON.parse(metaRes.rows[0].value)
      : metaRes.rows[0].value;
    jsonUser = (state.users || []).find((u) => u.id === user.id) || null;
    jsonWallets = (state.wallets || []).filter((w) => w.userId === user.id);
  } else {
    fail('app_state.present', 'app_metadata.app_state missing');
  }

  const mismatches = [];
  for (const pb of pgBalances) {
    const jw = jsonWallets.find((w) => w.id === pb.walletId);
    const jb = (jw?.balances || []).find((b) => b.currency === pb.currency);
    const jsonAmount = jb ? Number(jb.amount) : null;
    if (jsonAmount === null) {
      mismatches.push({
        walletId: pb.walletId,
        currency: pb.currency,
        postgresAmount: pb.amountMinor,
        jsonAmount: null,
        reason: 'missing_in_json_cache',
      });
    } else if (jsonAmount !== pb.amountMinor) {
      mismatches.push({
        walletId: pb.walletId,
        currency: pb.currency,
        postgresAmount: pb.amountMinor,
        jsonAmount,
        delta: jsonAmount - pb.amountMinor,
        reason: 'amount_mismatch',
      });
    }
  }
  // JSON-only balances that have a PG row missing (never mutated via PG) are noted separately
  const jsonOnly = [];
  for (const jw of jsonWallets) {
    for (const jb of jw.balances || []) {
      const hasPg = pgBalances.some(
        (p) => p.walletId === jw.id && p.currency === jb.currency
      );
      if (!hasPg && Number(jb.amount) !== 0) {
        jsonOnly.push({
          walletId: jw.id,
          currency: jb.currency,
          jsonAmount: Number(jb.amount),
          note: 'JSON balance with no wallet_balances row (never PG-touched or zero-row absent)',
        });
      }
    }
  }

  if (mismatches.length === 0) {
    pass('json_vs_postgres.user', {
      compared: pgBalances.length,
      mismatches: 0,
      jsonOnlyNonZero: jsonOnly.length,
      jsonOnly,
    });
  } else {
    fail('json_vs_postgres.user', { mismatches, jsonOnly });
  }

  // --- Latest ledger.balance_after vs wallet_balances ---
  const ledgerDrift = [];
  for (const pb of pgBalances) {
    const lr = await client.query(
      `SELECT balance_after, type, id, at
         FROM ledger
        WHERE wallet_id::text = $1 AND currency = $2
        ORDER BY at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [String(pb.walletId), pb.currency]
    );
    if (!lr.rowCount) {
      if (pb.amountMinor !== 0) {
        ledgerDrift.push({
          walletId: pb.walletId,
          currency: pb.currency,
          postgresAmount: pb.amountMinor,
          reason: 'no_ledger_rows_but_nonzero_balance',
        });
      }
      continue;
    }
    const after = Number(lr.rows[0].balance_after);
    if (after !== pb.amountMinor) {
      ledgerDrift.push({
        walletId: pb.walletId,
        currency: pb.currency,
        postgresAmount: pb.amountMinor,
        lastLedgerBalanceAfter: after,
        lastLedgerId: lr.rows[0].id,
        lastLedgerType: lr.rows[0].type,
      });
    }
  }
  if (ledgerDrift.length === 0) {
    pass('ledger_vs_wallet_balances', { checked: pgBalances.length });
  } else {
    fail('ledger_vs_wallet_balances', ledgerDrift);
  }

  // --- Rates + total converted (USD) using same formula as backend convertToUSD ---
  let ratesRes = { rows: [] };
  try {
    ratesRes = await client.query(`SELECT * FROM exchange_rates LIMIT 5`);
  } catch (_) {
    ratesRes = { rows: [] };
  }
  // Discover rate shape from first row / information_schema
  const rateCols = ratesRes.rows[0] ? Object.keys(ratesRes.rows[0]) : [];
  let allRates = { rows: [] };
  try {
    allRates = await client.query(`SELECT * FROM exchange_rates`);
  } catch (_) {
    allRates = { rows: [] };
  }
  // Also try JSON rates
  let rateMap = {};
  for (const row of allRates.rows || []) {
    const currency = row.currency || row.code || row.Currency;
    const rate = row.rate ?? row.value ?? row.Rate;
    if (currency != null && rate != null) {
      rateMap[String(currency).toUpperCase()] = Number(rate);
    }
  }
  if (metaRes.rowCount) {
    const state = typeof metaRes.rows[0].value === 'string'
      ? JSON.parse(metaRes.rows[0].value)
      : metaRes.rows[0].value;
    const values = state?.rates?.values || {};
    for (const [c, v] of Object.entries(values)) {
      if (rateMap[c] == null) rateMap[c] = Number(v);
    }
  }

  const converted = [];
  let totalUsd = 0;
  let convertOk = true;
  for (const pb of pgBalances) {
    if (pb.amountMinor === 0) {
      converted.push({ ...pb, usdMajor: '0.00' });
      continue;
    }
    if (pb.currency === 'USD') {
      const usd = pb.amountMinor / 100;
      totalUsd += usd;
      converted.push({ ...pb, usdMajor: usd.toFixed(2), rateUsed: 1 });
      continue;
    }
    const rate = rateMap[pb.currency]; // units of currency per 1 USD
    if (!rate || !(rate > 0)) {
      convertOk = false;
      converted.push({ ...pb, usdMajor: null, error: 'missing_rate' });
      continue;
    }
    const usd = pb.amountMinor / 100 / rate;
    totalUsd += usd;
    converted.push({ ...pb, usdMajor: usd.toFixed(2), rateUsed: rate });
  }
  if (convertOk) {
    pass('multi_currency.total_usd', {
      totalUsdMajor: totalUsd.toFixed(2),
      lines: converted,
      formula: 'amountMajor / rates.values[currency] (currency units per 1 USD)',
    });
  } else {
    fail('multi_currency.total_usd', { lines: converted });
  }

  // --- System-wide mismatch sample (JSON pairs that have PG rows) ---
  let systemMismatches = [];
  let systemScanned = 0;
  if (metaRes.rowCount) {
    const state = typeof metaRes.rows[0].value === 'string'
      ? JSON.parse(metaRes.rows[0].value)
      : metaRes.rows[0].value;
    for (const w of state.wallets || []) {
      for (const b of w.balances || []) {
        systemScanned += 1;
        const r = await client.query(
          `SELECT amount FROM wallet_balances WHERE wallet_id::text = $1 AND currency = $2`,
          [String(w.id), b.currency]
        );
        if (!r.rowCount) continue;
        const pg = Number(r.rows[0].amount);
        const json = Number(b.amount);
        if (pg !== json) {
          systemMismatches.push({
            walletId: w.id,
            userId: w.userId,
            currency: b.currency,
            jsonAmount: json,
            postgresAmount: pg,
            delta: json - pg,
          });
          if (systemMismatches.length >= 50) break;
        }
      }
      if (systemMismatches.length >= 50) break;
    }
  }
  if (systemMismatches.length === 0) {
    pass('json_vs_postgres.system', { scannedJsonPairs: systemScanned, mismatches: 0 });
  } else {
    fail('json_vs_postgres.system', {
      scannedJsonPairs: systemScanned,
      mismatchCount: systemMismatches.length,
      sample: systemMismatches.slice(0, 20),
    });
  }

  // --- Recent history rows for this user (informational) ---
  const txRes = await client.query(
    `SELECT id::text AS id, type, status, amount, currency, fee_amount, stripe_intent_id, timestamp,
            from_wallet_id::text AS from_wallet_id, to_wallet_id::text AS to_wallet_id
       FROM transactions
      WHERE from_wallet_id::text = ANY($1::text[])
         OR to_wallet_id::text = ANY($1::text[])
      ORDER BY timestamp DESC NULLS LAST
      LIMIT 15`,
    [walletIds]
  );

  const failed = checks.filter((c) => c.result === 'FAIL');
  const report = {
    ok: failed.length === 0,
    readOnly: true,
    noMoneyMoved: true,
    email: EMAIL,
    userId: user.id,
    authoritativeSource: 'postgres.wallet_balances',
    postgresBalances: pgBalances,
    postgresHolds: pgHolds,
    recentTransactions: txRes.rows,
    checks,
    summary: {
      pass: checks.filter((c) => c.result === 'PASS').length,
      fail: failed.length,
    },
    deviceScreenshotsRequiredFromUser: [
      'Wallet overview showing each currency balance',
      'Wallet total converted balance (preferred currency)',
      'Transaction history first page',
    ],
    adminReconciliationRequiredFromUser: [
      'Admin user detail balances for this email',
      'Admin ledger balance-check for each wallet/currency above',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  await client.end();
  process.exit(failed.length ? 3 : 0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
