'use strict';
/**
 * Heal JSON app_state display balances FROM authoritative Postgres.
 * Does NOT move money. Does NOT touch Stripe/Kora.
 *
 * Dry-run (default):
 *   railway run --service EGWalletSimple -- node backend/scripts/healWalletBalancesFromPostgres.js
 *
 * Apply:
 *   railway run --service EGWalletSimple -- env HEAL_APPLY=1 node backend/scripts/healWalletBalancesFromPostgres.js
 */
// When railway run injects the private DATABASE_URL, rewrite to public so this
// script can run from a developer machine against production Postgres.
if (
  process.env.DATABASE_PUBLIC_URL
  && (!process.env.DATABASE_URL || /railway\.internal/i.test(process.env.DATABASE_URL))
) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const { loadAppState, saveAppState } = require('../db/appStateStore');
const { healJsonBalancesFromPostgres } = require('../db/walletBalanceHeal');

async function main() {
  const apply = process.env.HEAL_APPLY === '1' || process.env.HEAL_APPLY === 'true';
  const db = loadAppState();
  const result = await healJsonBalancesFromPostgres(db);

  const report = {
    ok: true,
    readOnly: !apply,
    moneyMoved: false,
    apply,
    changed: result.changed,
    scannedBalances: result.scannedBalances,
    scannedHolds: result.scannedHolds,
    healedSample: result.details.filter((d) => d.healed).slice(0, 40),
    skippedMissingWallets: result.details.filter((d) => d.skipped).length,
  };

  if (!apply) {
    report.note = 'Dry-run only. Re-run with HEAL_APPLY=1 to write JSON cache.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  saveAppState(db, { skipVersionCheck: false });
  report.saved = true;
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
