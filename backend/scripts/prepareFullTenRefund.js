'use strict';
/**
 * PREPARE (do not execute) a full USD $10.00 refund to the original card for:
 *   user: buah@buah.com
 *   PaymentIntent: pi_3Twuw3HZf1hto9p701gBf7vp
 *
 * READ-ONLY. Never calls stripe.refunds.create. Never mutates wallet state.
 *
 * Usage:
 *   railway run --service Postgres -- node backend/scripts/prepareFullTenRefund.js
 *   (Stripe inspect also needs STRIPE_SECRET_KEY — use EGWalletSimple service if needed)
 */
const { Client } = require('pg');

const EMAIL = 'buah@buah.com';
const INTENT = 'pi_3Twuw3HZf1hto9p701gBf7vp';
const EXPECTED_MINOR = 1000;

async function inspectStripe(pi) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { available: false, error: 'STRIPE_SECRET_KEY missing' };
  if (String(key).startsWith('sk_test_')) {
    return { available: false, error: 'refusing sk_test_ against live PI audit' };
  }
  const stripe = require('stripe')(key);
  const intent = await stripe.paymentIntents.retrieve(pi);
  const charged = Number(intent.amount_received || intent.amount || 0);
  const alreadyRefunded = Number(intent.amount_refunded || 0);
  const remaining = Math.max(0, charged - alreadyRefunded);
  return {
    available: intent.status === 'succeeded' && remaining === EXPECTED_MINOR && charged === EXPECTED_MINOR,
    id: intent.id,
    status: intent.status,
    currency: intent.currency,
    livemode: intent.livemode,
    charged,
    alreadyRefunded,
    remaining,
    fullyRefundable: intent.status === 'succeeded' && remaining === charged && charged === EXPECTED_MINOR,
  };
}

async function main() {
  // Prefer the public proxy URL when running from a developer machine.
  // railway.internal hosts are unreachable outside the Railway private network.
  const candidates = [
    process.env.DATABASE_PUBLIC_URL,
    process.env.DATABASE_URL,
  ].filter(Boolean);
  const url = candidates.find((u) => !String(u).includes('railway.internal')) || candidates[0];
  if (!url) {
    console.error('DATABASE_PUBLIC_URL (or non-internal DATABASE_URL) required');
    process.exit(1);
  }
  if (String(url).includes('railway.internal')) {
    console.error('Refusing railway.internal DATABASE_URL from this host; set DATABASE_PUBLIC_URL');
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
    `SELECT id, email, status FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [EMAIL]
  );
  if (!userRes.rowCount) {
    console.log(JSON.stringify({ ok: false, error: 'user_not_found' }, null, 2));
    process.exit(2);
  }
  const user = userRes.rows[0];

  const txRes = await client.query(
    `SELECT id, to_wallet_id, amount, currency, status, stripe_intent_id,
            fee_amount, gross_amount, timestamp, type
       FROM transactions
      WHERE stripe_intent_id = $1 AND type = 'deposit'
      LIMIT 1`,
    [INTENT]
  );
  if (!txRes.rowCount) {
    console.log(JSON.stringify({ ok: false, error: 'deposit_not_found' }, null, 2));
    process.exit(2);
  }
  const deposit = txRes.rows[0];
  const walletId = deposit.to_wallet_id;

  const walletRes = await client.query(
    `SELECT id, user_id FROM wallets WHERE id = $1 LIMIT 1`,
    [walletId]
  );
  const wallet = walletRes.rows[0];

  const balRes = await client.query(
    `SELECT amount FROM wallet_balances WHERE wallet_id = $1 AND currency = 'USD'`,
    [walletId]
  );
  const balance = Number(balRes.rows[0]?.amount || 0);
  const holdRes = await client.query(
    `SELECT COALESCE(amount, 0)::bigint AS amount FROM wallet_holds
      WHERE wallet_id = $1 AND currency = 'USD'`,
    [walletId]
  );
  const hold = Number(holdRes.rows[0]?.amount || 0);

  let claimed = null;
  let existingRefunds = [];
  try {
    const claimRes = await client.query(
      `SELECT id, amount, status, stripe_refund_id, created_at
         FROM refund_requests
        WHERE deposit_transaction_id = $1
        ORDER BY created_at ASC`,
      [deposit.id]
    );
    existingRefunds = claimRes.rows;
    const active = claimRes.rows.filter((r) =>
      ['requested', 'pending', 'requires_action', 'succeeded'].includes(r.status)
    );
    claimed = active.reduce((s, r) => s + Number(r.amount || 0), 0);
  } catch (_) {
    claimed = null;
  }

  // Intervening USD spending after this deposit (debits that could consume the $10).
  const spendRes = await client.query(
    `SELECT id, type, amount, currency, status, timestamp
       FROM transactions
      WHERE (from_wallet_id = $1 OR to_wallet_id = $1)
        AND currency = 'USD'
        AND id <> $2
        AND timestamp >= $3
        AND type NOT IN ('deposit')
      ORDER BY timestamp ASC
      LIMIT 50`,
    [walletId, deposit.id, deposit.timestamp]
  );

  const ledgerRes = await client.query(
    `SELECT id, type, amount, currency, balance_after, note, at AS created_at
       FROM ledger
      WHERE wallet_id = $1 AND currency = 'USD'
      ORDER BY at DESC
      LIMIT 20`,
    [walletId]
  );

  let stripe;
  try {
    stripe = await inspectStripe(INTENT);
  } catch (err) {
    stripe = { available: false, error: err.message };
  }
  // Optional merge: when DB is audited via Postgres service (no Stripe key) and
  // PI was inspected separately with auditStripePiReadOnly.js, pass the JSON path:
  //   STRIPE_AUDIT_FILE=_pi_audit.json
  if ((!stripe || stripe.error) && process.env.STRIPE_AUDIT_FILE) {
    try {
      const fs = require('fs');
      const audit = JSON.parse(fs.readFileSync(process.env.STRIPE_AUDIT_FILE, 'utf8'));
      if (audit.id === INTENT || audit.paymentIntent === INTENT) {
        stripe = {
          available: !!audit.fullyRefundable,
          id: audit.id,
          status: audit.status,
          currency: audit.currency,
          livemode: audit.livemode,
          charged: audit.charged,
          alreadyRefunded: audit.alreadyRefunded,
          remaining: audit.remaining,
          fullyRefundable: !!audit.fullyRefundable,
          mergedFromFile: process.env.STRIPE_AUDIT_FILE,
        };
      }
    } catch (mergeErr) {
      stripe = { ...(stripe || {}), mergeError: mergeErr.message };
    }
  }

  const depositAmount = Number(deposit.amount);
  const ownsDeposit = wallet && wallet.user_id === user.id;
  const noExistingRefund = claimed === 0 || claimed === null;
  const noInterveningSpend = spendRes.rowCount === 0;
  const usdIntact = balance === EXPECTED_MINOR && hold === 0;
  const ready =
    ownsDeposit &&
    depositAmount === EXPECTED_MINOR &&
    usdIntact &&
    noExistingRefund &&
    noInterveningSpend &&
    stripe.fullyRefundable === true;

  const plan = {
    readOnly: true,
    noRefundExecuted: true,
    authorizationRequiredExact:
      'APPROVE FULL $10.00 REFUND TO ORIGINAL CARD FOR pi_3Twuw3HZf1hto9p701gBf7vp',
    doNotSubstitutePartial: true,
    target: {
      email: EMAIL,
      userId: user.id,
      accountStatus: user.status || null,
      paymentIntent: INTENT,
      depositTransactionId: deposit.id,
      walletId,
      refundAmountUsd: 10.0,
      refundAmountMinor: EXPECTED_MINOR,
      amountMode: 'full',
      destination: 'original_payment_method_only',
      expectedWalletUsdAfter: 0,
    },
    currentState: {
      usdBalanceMinor: balance,
      usdHoldMinor: hold,
      depositAmountMinor: depositAmount,
      existingRefunds,
      interveningUsdTransactionsAfterDeposit: spendRes.rows,
      recentUsdLedger: ledgerRes.rows,
      stripe,
    },
    proofs: {
      depositBelongsToUser: !!ownsDeposit,
      depositIsTenUsd: depositAmount === EXPECTED_MINOR,
      walletUsdIsTenAvailable: usdIntact,
      noExistingRefund,
      priorRefundClaimsMinor: claimed,
      noInterveningUsdSpending: noInterveningSpend,
      stripeFullyRefundable: stripe.fullyRefundable === true,
      readyForAuthorization: ready,
    },
    operationsIfAuthorized: {
      http: {
        method: 'POST',
        path: '/refunds',
        headers: ['Authorization: Bearer <buah token>', 'Idempotency-Key: <unique>'],
        body: {
          depositTransactionId: deposit.id,
          amountMode: 'full',
          amount: EXPECTED_MINOR,
        },
        forbiddenBodyFields: ['destination', 'cardNumber', 'paymentMethodId', 'destinationCard'],
      },
      databaseBeforeStripe: [
        'BEGIN',
        'Lock wallet_balances / wallet_holds FOR UPDATE',
        'Debit wallet_balances USD available by 1000 (→ 0)',
        'Credit wallet_holds USD by 1000',
        'Insert refund_requests status=requested amount=1000',
        "Insert ledger type=deposit_refund_hold note tied to refund id",
        'Insert idempotency_records for client key',
        'COMMIT',
      ],
      stripe: [
        "stripe.refunds.create({ payment_intent: 'pi_3Twuw3HZf1hto9p701gBf7vp', amount: 1000, reason? }, { idempotencyKey: 'egw-refund-<refundId>' })",
        'No destination card parameter — refund returns to original PM only',
      ],
      webhooksExpected: [
        'refund.created',
        'refund.updated (and/or charge.refunded)',
        'On success: wallet hold finalized → ledger deposit_refund_debit; refund status succeeded',
        'On failure: hold released → ledger deposit_refund_release; USD restored to 1000',
      ],
      databaseOnSuccess: [
        'refund_requests.status = succeeded + stripe_refund_id',
        'wallet_holds USD → 0',
        'wallet_balances USD remains 0 (hold converted to permanent debit)',
        "transactions row type=deposit_refund",
        'idempotent webhook replay ignored via stripe_webhook_events',
      ],
      databaseOnFailure: [
        'refund_requests.status = failed|cancelled',
        'wallet_holds released',
        'wallet_balances USD restored to 1000',
        'ledger deposit_refund_release',
      ],
      appAndAdmin: [
        'App history shows deposit_refund with durable server id',
        'Receipt uses server-issued refund/transaction reference (not client-fabricated)',
        'Admin Refunds queue shows succeeded/failed with Stripe ids',
        'Admin ledger reconciliation: before 1000 → after 0 on success',
      ],
    },
    stop: 'NO MONEY MOVED. Awaiting exact authorization string above.',
  };

  console.log(JSON.stringify(plan, null, 2));
  await client.end();
  process.exit(ready ? 0 : 3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
