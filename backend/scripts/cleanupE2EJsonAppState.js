'use strict';
/**
 * Clean E2E leftovers from app_metadata JSON blob via DATABASE_PUBLIC_URL.
 * Keeps ledger/audit. Zeros spendable JSON balances for e2e / deleted-e2e users.
 *
 *   CONFIRM_E2E_CLEANUP=YES railway run --service EGWalletSimple -- node backend/scripts/cleanupE2EJsonAppState.js
 */
const { Client } = require('pg');

function isE2eEmail(email) {
  const e = String(email || '');
  return e.endsWith('@egwallet.e2e.test')
    || e.startsWith('deleted-e2e-')
    || e.endsWith('@egwallet.deleted');
}

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

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('BEGIN');
  try {
    const row = await client.query(
      `SELECT value FROM app_metadata WHERE key = 'app_state' FOR UPDATE`
    );
    if (row.rowCount === 0) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ok: false, error: 'no_app_state' }));
      process.exit(3);
    }
    const db = row.rows[0].value;
    const e2eUserIds = new Set();
    let usersTouched = 0;
    let walletsZeroed = 0;
    let notifRemoved = 0;
    let prCancelled = 0;
    let payrollTouched = 0;

    for (const u of db.users || []) {
      if (isE2eEmail(u.email) || String(u.status) === 'deleted') {
        e2eUserIds.add(u.id);
        if (String(u.email || '').endsWith('@egwallet.e2e.test')) {
          u.email = `deleted-e2e-${u.id}@egwallet.deleted`;
        }
        u.status = 'deleted';
        u.accountStatus = 'suspended';
        u.tokenVersion = (u.tokenVersion || 0) + 1;
        u.fraudHold = false;
        u.amlHold = false;
        u.sanctionsHold = false;
        u.courtOrderHold = false;
        usersTouched += 1;
      }
    }

    for (const w of db.wallets || []) {
      if (!e2eUserIds.has(w.userId)) continue;
      if (Array.isArray(w.balances)) {
        for (const b of w.balances) {
          if (Number(b.amount) !== 0) walletsZeroed += 1;
          b.amount = 0;
        }
      }
      if (w.holdBalance && typeof w.holdBalance === 'object') {
        for (const k of Object.keys(w.holdBalance)) w.holdBalance[k] = 0;
      }
    }

    if (Array.isArray(db.notifications)) {
      const before = db.notifications.length;
      db.notifications = db.notifications.filter((n) => !e2eUserIds.has(n.userId));
      notifRemoved = before - db.notifications.length;
    }

    for (const pr of db.paymentRequests || []) {
      if (e2eUserIds.has(pr.requesterId) && pr.status === 'pending') {
        pr.status = 'cancelled';
        pr.cancelReason = 'e2e_cleanup';
        prCancelled += 1;
      }
    }

    for (const q of db.qrCodes || []) {
      if (e2eUserIds.has(q.userId) && (q.status === 'pending' || !q.used)) {
        q.status = 'cancelled';
        q.used = true;
      }
    }

    for (const b of db.payrollBatches || []) {
      if (e2eUserIds.has(b.employerUserId) || e2eUserIds.has(b.createdBy)) {
        if (b.status === 'pending' || b.status === 'draft') {
          b.status = 'cancelled';
          payrollTouched += 1;
        }
      }
    }

    // Snapshot real-user JSON balances (non-e2e) for drift check after write
    const realBefore = {};
    for (const w of db.wallets || []) {
      if (e2eUserIds.has(w.userId)) continue;
      for (const b of w.balances || []) {
        realBefore[`${w.id}:${b.currency}`] = Number(b.amount || 0);
      }
    }

    await client.query(
      `UPDATE app_metadata SET value = $1::jsonb, updated_at = NOW() WHERE key = 'app_state'`,
      [JSON.stringify(db)]
    );
    await client.query('COMMIT');

    // Re-read spendable check from Postgres wallet_balances (authoritative)
    const spendable = await client.query(
      `SELECT COUNT(*)::int AS c FROM wallet_balances wb
         JOIN wallets w ON w.id = wb.wallet_id
         JOIN users u ON u.id = w.user_id
        WHERE (u.email LIKE '%@egwallet.e2e.test' OR u.email LIKE 'deleted-e2e-%')
          AND wb.amount > 0`
    );

    const report = {
      ok: spendable.rows[0].c === 0,
      usersTouched,
      walletsZeroed,
      notifRemoved,
      prCancelled,
      payrollTouched,
      e2eSpendableRemainingPg: spendable.rows[0].c,
      realUserJsonBalanceKeysPreserved: Object.keys(realBefore).length,
    };
    console.log(JSON.stringify(report, null, 2));
    await client.end();
    process.exit(report.ok ? 0 : 3);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    await client.end();
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
