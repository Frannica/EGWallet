'use strict';
/**
 * READ-ONLY production smoke checks (no money movement, no mutations).
 * Distinguishes automated readiness from live provider proofs.
 *
 *   node backend/scripts/productionE2ESmokeReadOnly.js
 *   BASE_URL=https://egwalletsimple-production.up.railway.app node ...
 */
const BASE = process.env.BASE_URL || 'https://egwalletsimple-production.up.railway.app';

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'GET' });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

async function getText(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'GET' });
  const text = await res.text();
  return { status: res.status, text, len: text.length };
}

function check(name, pass, detail) {
  return { name, result: pass ? 'PASS' : 'FAIL', detail: detail || null };
}

(async () => {
  const checks = [];
  const health = await getJson('/health');
  const h = health.body || {};
  checks.push(check('health_status', health.status === 200 && h.status === 'healthy', h.status));
  checks.push(check('database_connected', h.database === 'connected', h.database));
  checks.push(check('stripe_configured', h.stripeConfigured === true));
  checks.push(check('stripe_webhook_configured', h.stripeWebhookConfigured === true));
  checks.push(check('kora_provider_ready', h.koraProviderReady === true));
  checks.push(check('stripe_connect_disabled', h.stripeConnectEnabled === false, 'required until business-model approval'));
  checks.push(check('stripe_issuing_disabled', h.stripeIssuingEnabled === false));

  const terms = await getText('/terms');
  const termsHtml = terms.text || '';
  checks.push(check('terms_http_200', terms.status === 200, `status=${terms.status} len=${terms.len}`));
  checks.push(check('terms_lists_nigeria', /Nigeria/i.test(termsHtml)));
  checks.push(check('terms_lists_kenya_bank_and_mm', /Kenya/i.test(termsHtml) && /mobile money/i.test(termsHtml)));
  checks.push(check('terms_gq_unsupported', /Equatorial Guinea/i.test(termsHtml) && /not/i.test(termsHtml)));
  checks.push(check('terms_us_uk_eu_unavailable', /United States/i.test(termsHtml) && /Stripe Connect/i.test(termsHtml)));
  checks.push(check('terms_refund_not_withdrawal', /refund-to-original-card/i.test(termsHtml) && /deposit reversal|not.*general withdrawal/i.test(termsHtml)));
  checks.push(check('terms_updated_2026_07_31', /July 31, 2026/i.test(termsHtml)));

  const privacy = await getText('/privacy-policy');
  checks.push(check('privacy_http_200', privacy.status === 200, `status=${privacy.status}`));

  const md = await getText('/legal/TERMS_OF_SERVICE.md');
  checks.push(check('legal_md_http_200', md.status === 200, `status=${md.status}`));

  const report = {
    readOnly: true,
    noMoneyMoved: true,
    baseUrl: BASE,
    gitCommit: h.gitCommit || null,
    classification: {
      thisScript: 'production_smoke_read_only',
      notIncluded: [
        'real Stripe deposit',
        'real Stripe refund',
        'real Kora payout',
        'authenticated P2P/QR/payroll money movement',
        'legal MTL/EMI authority confirmation (external)',
      ],
    },
    checks,
    summary: {
      pass: checks.filter((c) => c.result === 'PASS').length,
      fail: checks.filter((c) => c.result === 'FAIL').length,
      total: checks.length,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.fail === 0 ? 0 : 3);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
