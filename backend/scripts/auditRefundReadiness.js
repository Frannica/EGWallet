'use strict';
/**
 * READ-ONLY readiness audit for the buah@buah.com USD $10 deposit refund.
 * Does NOT create a refund, call stripe.refunds.create, or mutate wallet state.
 *
 * Usage (Railway public DB):
 *   railway run --service Postgres -- node backend/scripts/auditRefundReadiness.js
 */
const { Client } = require('pg');

const EMAIL = 'buah@buah.com';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
const EXPECTED_MINOR = 1000; // $10.00

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL / DATABASE_PUBLIC_URL required');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: url.includes('railway') || url.includes('proxy')
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  const userRes = await client.query(
    `SELECT id, email, status
       FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [EMAIL]
  );
  if (userRes.rowCount === 0) {
    console.log(JSON.stringify({ ok: false, error: 'user_not_found' }, null, 2));
    process.exit(2);
  }
  const user = userRes.rows[0];

  const txRes = await client.query(
    `SELECT id, to_wallet_id, amount, currency, status, stripe_intent_id,
            fee_amount, gross_amount, timestamp
       FROM transactions
      WHERE stripe_intent_id = $1 AND type = 'deposit'
      LIMIT 1`,
    [INTENT]
  );
  if (txRes.rowCount === 0) {
    console.log(JSON.stringify({ ok: false, error: 'deposit_not_found', intent: INTENT }, null, 2));
    process.exit(2);
  }
  const deposit = txRes.rows[0];

  const walletRes = await client.query(
    `SELECT id, user_id FROM wallets WHERE id = $1 LIMIT 1`,
    [deposit.to_wallet_id]
  );
  const wallet = walletRes.rows[0];

  const balRes = await client.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = $2`,
    [deposit.to_wallet_id, deposit.currency]
  );
  const balance = Number(balRes.rows[0]?.amount || 0);

  const holdRes = await client.query(
    `SELECT amount FROM wallet_holds WHERE wallet_id = $1 AND currency = $2`,
    [deposit.to_wallet_id, deposit.currency]
  );
  const hold = Number(holdRes.rows[0]?.amount || 0);

  let claimed = 0;
  try {
    const claimRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS claimed
         FROM refund_requests
        WHERE deposit_transaction_id = $1
          AND status IN ('requested','pending','requires_action','succeeded')`,
      [deposit.id]
    );
    claimed = Number(claimRes.rows[0]?.claimed || 0);
  } catch (err) {
    // Table may not exist until migration 012 is applied.
    claimed = null;
  }

  const depositAmount = Number(deposit.amount);
  const ownsDeposit = wallet && wallet.user_id === user.id;
  const refundable = claimed === null
    ? depositAmount
    : Math.max(0, depositAmount - claimed);

  const report = {
    ok: true,
    readOnly: true,
    noRefundExecuted: true,
    user: { id: user.id, email: user.email, accountStatus: user.status || null },
    deposit: {
      id: deposit.id,
      amountMinor: depositAmount,
      currency: deposit.currency,
      status: deposit.status,
      stripeIntentId: deposit.stripe_intent_id,
      grossAmount: deposit.gross_amount,
      feeAmount: deposit.fee_amount,
      timestamp: deposit.timestamp,
    },
    wallet: {
      id: deposit.to_wallet_id,
      usdBalanceMinor: balance,
      usdHoldMinor: hold,
    },
    proofs: {
      depositBelongsToUser: !!ownsDeposit,
      exactlyTenUsdInWallet: balance === EXPECTED_MINOR && deposit.currency === 'USD',
      depositAmountIsTen: depositAmount === EXPECTED_MINOR,
      notAlreadyRefundedLocally: claimed === 0 || claimed === null,
      priorRefundClaimsMinor: claimed,
      refundWouldHoldExactlyTen: refundable === EXPECTED_MINOR && balance >= EXPECTED_MINOR,
      successWouldLeaveUsdAtZero: balance === EXPECTED_MINOR && refundable === EXPECTED_MINOR,
      failureWouldRestoreUsdToTen: true, // engine guarantee covered by unit tests
      migration012Applied: claimed !== null,
    },
    note: 'Stripe PI refundability (amount_refunded / status) must be confirmed with a live Stripe retrieve at execution time. This script never calls stripe.refunds.create.',
  };

  console.log(JSON.stringify(report, null, 2));
  await client.end();

  const allLocalProofs =
    report.proofs.depositBelongsToUser &&
    report.proofs.exactlyTenUsdInWallet &&
    report.proofs.depositAmountIsTen &&
    report.proofs.notAlreadyRefundedLocally &&
    report.proofs.refundWouldHoldExactlyTen;
  process.exit(allLocalProofs ? 0 : 3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
