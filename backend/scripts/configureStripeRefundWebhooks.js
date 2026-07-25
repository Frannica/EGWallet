'use strict';
/**
 * READ/UPDATE the existing live Stripe Account webhook endpoint:
 *  - Read current enabled events
 *  - Preserve every existing event
 *  - Add refund.created / refund.updated / refund.failed / charge.refunded
 *  - Do NOT create a duplicate endpoint
 *  - Do NOT rotate or print the webhook secret
 *  - Read back and prove required deposit + refund events are enabled
 *
 * Never creates a refund. Never sends fake events.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/configureStripeRefundWebhooks.js
 */
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY required');
  process.exit(1);
}
if (key.startsWith('sk_test_')) {
  console.error('Refusing to modify webhooks with a test-mode key — live key required');
  process.exit(1);
}

const stripe = require('stripe')(key);

const REQUIRED_ADD = [
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.refunded',
];

const REQUIRED_DEPOSIT = [
  'payment_intent.succeeded',
];

const REQUIRED_ALL = [...REQUIRED_DEPOSIT, ...REQUIRED_ADD];

function matchesAccountWebhook(url) {
  if (!url) return false;
  // Prefer the main Account webhook that hits /webhooks/stripe (not Connect).
  return /\/webhooks\/stripe\/?$/.test(url) || /\/webhooks\/stripe(\?|$)/.test(url);
}

function isConnectWebhook(url) {
  return /stripe-connect/i.test(url || '');
}

(async () => {
  const listed = await stripe.webhookEndpoints.list({ limit: 100 });
  const endpoints = listed.data || [];

  const candidates = endpoints.filter(
    (e) => e.status === 'enabled' && matchesAccountWebhook(e.url) && !isConnectWebhook(e.url)
  );

  if (candidates.length === 0) {
    // Fall back: any enabled non-Connect endpoint whose URL contains our production host.
    const fallback = endpoints.filter(
      (e) => e.status === 'enabled' && !isConnectWebhook(e.url) && /egwalletsimple|egwallet/i.test(e.url || '')
    );
    if (fallback.length === 1 && /webhooks\/stripe/.test(fallback[0].url)) {
      candidates.push(fallback[0]);
    }
  }

  if (candidates.length === 0) {
    console.log(JSON.stringify({
      ok: false,
      error: 'NO_MATCHING_ENDPOINT',
      endpointsFound: endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        status: e.status,
        apiVersion: e.api_version,
        eventCount: (e.enabled_events || []).length,
        // Never print secret
      })),
    }, null, 2));
    process.exit(2);
  }

  if (candidates.length > 1) {
    console.log(JSON.stringify({
      ok: false,
      error: 'MULTIPLE_MATCHING_ENDPOINTS',
      candidates: candidates.map((e) => ({ id: e.id, url: e.url, status: e.status })),
    }, null, 2));
    process.exit(2);
  }

  const endpoint = candidates[0];
  const beforeEvents = Array.isArray(endpoint.enabled_events) ? [...endpoint.enabled_events] : [];

  // Stripe special case: ['*'] means all events — already includes refunds.
  let afterEvents;
  let updatePerformed = false;
  if (beforeEvents.length === 1 && beforeEvents[0] === '*') {
    afterEvents = ['*'];
    updatePerformed = false;
  } else {
    const set = new Set(beforeEvents);
    for (const ev of REQUIRED_ADD) set.add(ev);
    afterEvents = Array.from(set).sort();
    const alreadyHadAll = REQUIRED_ADD.every((ev) => beforeEvents.includes(ev));
    if (!alreadyHadAll) {
      // Update in place — Stripe does NOT rotate the signing secret on enabled_events change.
      const updated = await stripe.webhookEndpoints.update(endpoint.id, {
        enabled_events: afterEvents,
      });
      afterEvents = Array.isArray(updated.enabled_events) ? [...updated.enabled_events].sort() : afterEvents;
      updatePerformed = true;
    }
  }

  // Read back from Stripe (fresh retrieve) — prove required events are enabled.
  const verified = await stripe.webhookEndpoints.retrieve(endpoint.id);
  const verifiedEvents = Array.isArray(verified.enabled_events) ? verified.enabled_events : [];
  const hasAll = verifiedEvents.includes('*')
    || REQUIRED_ALL.every((ev) => verifiedEvents.includes(ev));

  const preserved = beforeEvents.includes('*')
    || beforeEvents.every((ev) => verifiedEvents.includes('*') || verifiedEvents.includes(ev));

  const report = {
    ok: hasAll && preserved && verified.status === 'enabled',
    noRefundExecuted: true,
    noDuplicateEndpointCreated: true,
    secretNotRotatedOrExposed: true,
    endpoint: {
      id: verified.id,
      url: verified.url,
      status: verified.status,
      apiVersion: verified.api_version,
      livemode: verified.livemode,
    },
    updatePerformed,
    eventsBefore: beforeEvents.includes('*') ? ['*'] : beforeEvents.slice().sort(),
    eventsAfter: verifiedEvents.includes('*') ? ['*'] : verifiedEvents.slice().sort(),
    requiredDepositEvents: REQUIRED_DEPOSIT.map((ev) => ({
      event: ev,
      enabled: verifiedEvents.includes('*') || verifiedEvents.includes(ev),
    })),
    requiredRefundEvents: REQUIRED_ADD.map((ev) => ({
      event: ev,
      enabled: verifiedEvents.includes('*') || verifiedEvents.includes(ev),
    })),
    allExistingEventsPreserved: preserved,
    allRequiredEventsEnabled: hasAll,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 3);
})().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
