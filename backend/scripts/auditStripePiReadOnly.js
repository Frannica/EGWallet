'use strict';
/**
 * READ-ONLY Stripe PaymentIntent inspect for refund readiness.
 * Never calls stripe.refunds.create.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/auditStripePiReadOnly.js
 */
const INTENT = process.env.AUDIT_PI || 'pi_3Twuw3HZf1hto9p701gBf7vp';
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY required');
  process.exit(1);
}
const stripe = require('stripe')(key);

(async () => {
  const intent = await stripe.paymentIntents.retrieve(INTENT);
  const charged = Number(intent.amount_received || intent.amount || 0);
  const alreadyRefunded = Number(intent.amount_refunded || 0);
  const remaining = Math.max(0, charged - alreadyRefunded);
  const report = {
    readOnly: true,
    noRefundExecuted: true,
    id: intent.id,
    status: intent.status,
    currency: intent.currency,
    charged,
    alreadyRefunded,
    remaining,
    livemode: intent.livemode,
    fullyRefundable: intent.status === 'succeeded' && remaining === charged && charged === 1000,
    created: intent.created,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.fullyRefundable ? 0 : 3);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
