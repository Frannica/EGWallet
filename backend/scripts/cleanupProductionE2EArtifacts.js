'use strict';
/**
 * Clean production E2E artifacts for *@egwallet.e2e.test.
 * Keeps ledger + audit rows (evidence). Zeros spendable balances / cancels open requests.
 * Soft-deletes users (email rename) so they cannot log in or spend.
 *
 *   CONFIRM_E2E_CLEANUP=YES railway run --service EGWalletSimple -- node backend/scripts/cleanupProductionE2EArtifacts.js
 */
const { Client } = require('pg');
const { loadAppState, saveAppState } = require('../db/appStateStore');

async function main() {
  if (process.env.CONFIRM_E2E_CLEANUP !== 'YES') {
    console.error('Refusing: set CONFIRM_E2E_CLEANUP=YES');
    process.exit(2);
  }
  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL : null);
  if (!url) {
    console.error('DATABASE_PUBLIC_URL required');
    process.exit(2);
  }

  // Snapshot real-user balances (non-e2e) before cleanup
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const beforeReal = await client.query(
    `SELECT u.email, wb.wallet_id, wb.currency, wb.amount
       FROM wallet_balances wb
       JOIN wallets w ON w.id = wb.wallet_id
       JOIN users u ON u.id = w.user_id
      WHERE u.email NOT LIKE '%@egwallet.e2e.test'
        AND u.email NOT LIKE '%@egwallet-gate.test'
        AND u.email NOT LIKE '%@egwallet.test'
        AND u.email NOT LIKE 'deleted-%'
      ORDER BY u.email, wb.currency`
  );

  const e2e = await client.query(
    `SELECT id::text AS id, email FROM users WHERE email LIKE '%@egwallet.e2e.test'`
  );
  const e2eIds = e2e.rows.map((r) => r.id);
  const report = {
    e2eUsers: e2e.rows.length,
    emails: e2e.rows.map((r) => r.email),
    actions: [],
  };

  if (e2eIds.length) {
    await client.query('BEGIN');
    try {
      const wallets = await client.query(
        `SELECT id FROM wallets WHERE user_id = ANY($1::uuid[])`,
        [e2eIds]
      );
      const walletIds = wallets.rows.map((r) => r.id);

      if (walletIds.length) {
        const zeroed = await client.query(
          `UPDATE wallet_balances SET amount = 0 WHERE wallet_id = ANY($1::text[]) AND amount <> 0 RETURNING wallet_id, currency`,
          [walletIds]
        );
        report.actions.push({ zeroBalances: zeroed.rowCount });
        const holds = await client.query(
          `UPDATE wallet_holds SET amount = 0 WHERE wallet_id = ANY($1::text[]) AND amount <> 0 RETURNING wallet_id`,
          [walletIds]
        );
        report.actions.push({ zeroHolds: holds.rowCount });
      }

      const cancelledPr = await client.query(
        `UPDATE payment_requests
            SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'e2e_cleanup'
          WHERE requester_id = ANY($1::uuid[]) AND status = 'pending'
          RETURNING id`,
        [e2eIds]
      );
      report.actions.push({ cancelledPaymentRequests: cancelledPr.rowCount });

      const cancelledQr = await client.query(
        `UPDATE qr_codes SET status = 'cancelled'
          WHERE user_id = ANY($1::uuid[]) AND status = 'pending'
          RETURNING id`,
        [e2eIds]
      );
      report.actions.push({ cancelledQrCodes: cancelledQr.rowCount });

      // Soft-delete users — keep id for FK/ledger integrity
      const soft = await client.query(
        `UPDATE users
            SET email = 'deleted-e2e-' || id::text || '@egwallet.deleted',
                status = 'deleted',
                token_version = COALESCE(token_version,0) + 1
          WHERE id = ANY($1::uuid[])
          RETURNING id`,
        [e2eIds]
      );
      report.actions.push({ softDeletedUsers: soft.rowCount });

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }

  // JSON app_state cleanup (best-effort on API host via railway run may not share volume;
  // also attempt when loadAppState works against same DB blob).
  try {
    const db = loadAppState();
    let notifRemoved = 0;
    let prRemoved = 0;
    const e2eSet = new Set(e2eIds);
    if (Array.isArray(db.notifications)) {
      const before = db.notifications.length;
      db.notifications = db.notifications.filter((n) => !e2eSet.has(n.userId));
      notifRemoved = before - db.notifications.length;
    }
    if (Array.isArray(db.paymentRequests)) {
      for (const pr of db.paymentRequests) {
        if (e2eSet.has(pr.requesterId) && pr.status === 'pending') {
          pr.status = 'cancelled';
          pr.cancelReason = 'e2e_cleanup';
          prRemoved += 1;
        }
      }
    }
    for (const u of db.users || []) {
      if (e2eSet.has(u.id) || (u.email && String(u.email).endsWith('@egwallet.e2e.test'))) {
        u.status = 'deleted';
        u.accountStatus = 'suspended';
        u.email = `deleted-e2e-${u.id}@egwallet.deleted`;
        u.tokenVersion = (u.tokenVersion || 0) + 1;
      }
    }
    for (const w of db.wallets || []) {
      if (e2eSet.has(w.userId) && Array.isArray(w.balances)) {
        for (const b of w.balances) b.amount = 0;
        if (w.holdBalance) w.holdBalance = {};
      }
    }
    saveAppState(db);
    report.actions.push({ jsonNotificationsRemoved: notifRemoved, jsonPrCancelled: prRemoved, jsonSaved: true });
  } catch (e) {
    report.actions.push({ jsonCleanup: 'skipped', reason: e.message });
  }

  const afterReal = await client.query(
    `SELECT u.email, wb.wallet_id, wb.currency, wb.amount
       FROM wallet_balances wb
       JOIN wallets w ON w.id = wb.wallet_id
       JOIN users u ON u.id = w.user_id
      WHERE u.email NOT LIKE '%@egwallet.e2e.test'
        AND u.email NOT LIKE '%@egwallet-gate.test'
        AND u.email NOT LIKE '%@egwallet.test'
        AND u.email NOT LIKE 'deleted-%'
        AND u.email NOT LIKE 'deleted-e2e-%'
      ORDER BY u.email, wb.currency`
  );

  const beforeMap = new Map(beforeReal.rows.map((r) => [`${r.wallet_id}:${r.currency}`, Number(r.amount)]));
  const drift = [];
  for (const r of afterReal.rows) {
    const key = `${r.wallet_id}:${r.currency}`;
    const prev = beforeMap.get(key);
    if (prev !== undefined && prev !== Number(r.amount)) {
      drift.push({ email: r.email, key, before: prev, after: Number(r.amount) });
    }
  }

  const remainingSpendable = await client.query(
    `SELECT COUNT(*)::int AS c FROM wallet_balances wb
       JOIN wallets w ON w.id = wb.wallet_id
       JOIN users u ON u.id = w.user_id
      WHERE u.email LIKE '%@egwallet.e2e.test' AND wb.amount > 0`
  );

  await client.end();

  report.realUserBalanceDrift = drift;
  report.e2eSpendableRemaining = remainingSpendable.rows[0].c;
  report.ok = drift.length === 0 && remainingSpendable.rows[0].c === 0;
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 3);
}

main().catch((e) => { console.error(e); process.exit(1); });
