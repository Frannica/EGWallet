'use strict';
/**
 * Annotate the live buah $10 refund reconciliation_result with an immutable
 * ledger narrative (no money movement).
 *
 *   APPROVAL=ANNOTATE_LIVE_REFUND_LEDGER_NARRATIVE \
 *   railway run --service EGWalletSimple -- node backend/scripts/annotateLiveRefundLedgerNarrative.js
 */
const REFUND_ID = 'fda1e0c9-03d5-439d-8b24-b86fd45a036a';
const EXPECTED = 'ANNOTATE_LIVE_REFUND_LEDGER_NARRATIVE';

async function main() {
  if (process.env.APPROVAL !== EXPECTED) {
    console.error(JSON.stringify({ ok: false, error: 'APPROVAL_MISMATCH', required: EXPECTED }));
    process.exit(2);
  }
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (!pub) throw new Error('DATABASE_PUBLIC_URL required');
  process.env.DATABASE_URL = pub;

  const { loadAppState, saveAppState } = require('../db/appStateStore');
  const { buildRefundLedgerNarrative } = require('../refundStripeSafety');
  const { pool } = require('../db/pool');

  const db = loadAppState();
  const refund = (db.refundRequests || []).find((r) => r.id === REFUND_ID);
  if (!refund) throw new Error('refund_not_found');
  const ledger = (db.ledger || []).filter((l) => l.refundRequestId === REFUND_ID);
  const narrative = buildRefundLedgerNarrative(ledger);

  refund.reconciliationResult = {
    ...(refund.reconciliationResult || {}),
    at: Date.now(),
    outcome: refund.reconciliationResult?.outcome || 'succeeded_after_false_failure_wallet_redebit',
    ledgerNarrative: narrative,
    incidentNote:
      'Immutable path: hold → temporary restoration (false failure after Stripe success / 502) → final debit. Stripe re_3Twuw3HZf1hto9p70t00xc7l succeeded; wallet corrected without a second Stripe refund.',
  };

  await pool.query(
    `UPDATE refund_requests SET reconciliation_result = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [REFUND_ID, JSON.stringify(refund.reconciliationResult)]
  );
  saveAppState(db);

  console.log(JSON.stringify({
    annotated: true,
    moneyMoved: false,
    refundId: REFUND_ID,
    status: refund.status,
    narrative,
  }, null, 2));
  await pool.end().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
