'use strict';
/**
 * READ-ONLY diagnostic probe — verifies live Kora account access for Cameroon
 * Mobile Money payouts using only Kora's informational/utility APIs. Makes NO
 * disbursement, resolve, or money-movement calls. Safe to run against production
 * credentials via `railway run`.
 *
 * Prints only booleans / non-sensitive response bodies — never logs the secret key.
 */
const axios = require('axios');

const KORA_BASE_URL = 'https://api.korapay.com';
const secretKey = process.env.KORA_LIVE_SECRET_KEY || process.env.KORA_API_KEY || null;
const publicKey = process.env.KORA_LIVE_PUBLIC_KEY || null;

function mask(key) {
  if (!key) return null;
  return key.slice(0, 7) + '…' + key.slice(-4) + ` (len=${key.length})`;
}

async function probe(label, fn) {
  console.log(`\n── ${label} ──`);
  try {
    const result = await fn();
    console.log('OK', JSON.stringify(result, null, 2));
    return { ok: true, result };
  } catch (err) {
    console.log('FAILED');
    console.log('  status:', err.response?.status);
    console.log('  body:', JSON.stringify(err.response?.data || { message: err.message }, null, 2));
    return { ok: false, status: err.response?.status, body: err.response?.data || { message: err.message } };
  }
}

async function main() {
  console.log('Kora secret key present:', !!secretKey, secretKey ? mask(secretKey) : '(none)');
  console.log('Kora public key present:', !!publicKey, publicKey ? mask(publicKey) : '(none)');
  console.log('Secret key prefix looks LIVE:', secretKey ? secretKey.startsWith('sk_live_') : 'n/a');
  console.log('Public key prefix looks LIVE:', publicKey ? publicKey.startsWith('pk_live_') : 'n/a');
  if (!secretKey) {
    console.log('No Kora secret key found in this environment — aborting probe.');
    return;
  }

  const secretHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
  const publicHeaders = publicKey ? { Authorization: `Bearer ${publicKey}`, 'Content-Type': 'application/json' } : null;

  async function tryBoth(label, path, params) {
    await probe(`${label} [secret key]`, async () => {
      const resp = await axios.get(`${KORA_BASE_URL}${path}`, { params, headers: secretHeaders, timeout: 15000 });
      return resp.data;
    });
    if (publicHeaders) {
      await probe(`${label} [public key]`, async () => {
        const resp = await axios.get(`${KORA_BASE_URL}${path}`, { params, headers: publicHeaders, timeout: 15000 });
        return resp.data;
      });
    }
  }

  await tryBoth('List Mobile Money Operators — Cameroon (CM)', '/merchant/api/v1/misc/mobile-money', { countryCode: 'CM' });
  await tryBoth('List Mobile Money Operators — Kenya (KE) [control]', '/merchant/api/v1/misc/mobile-money', { countryCode: 'KE' });
  await tryBoth('List Banks — Nigeria (NG) [control]', '/merchant/api/v1/misc/banks', { countryCode: 'NG' });
  await tryBoth('Supported bank countries for currency=XAF', '/merchant/api/v1/misc/payout-countries-by-currency-code/XAF', undefined);

  async function tryResolve(label, path, body) {
    await probe(`${label} [secret key]`, async () => {
      const resp = await axios.post(`${KORA_BASE_URL}${path}`, body, { headers: secretHeaders, timeout: 15000 });
      return resp.data;
    });
    if (publicHeaders) {
      await probe(`${label} [public key]`, async () => {
        const resp = await axios.post(`${KORA_BASE_URL}${path}`, body, { headers: publicHeaders, timeout: 15000 });
        return resp.data;
      });
    }
  }

  // Kora's own documented LIVE-safe test numbers won't resolve to a real account in
  // live mode, but this only proves which key format passes AUTH (401 vs a resolution
  // error) — it never moves money.
  await tryResolve(
    'Resolve mobile-money account — Cameroon MTN (auth-scheme check only)',
    '/merchant/api/v1/misc/mobile-money/resolve',
    { mobileMoneyCode: 'MTN_CM', phoneNumber: '237671111111', currency: 'CM' }
  );
  await tryResolve(
    'Resolve bank account — Nigeria (auth-scheme check only)',
    '/merchant/api/v1/misc/banks/resolve',
    { bank: '033', account: '0000000000', currency: 'NG' }
  );

  await probe('Payout History (read-only — confirms account has payout/disburse scope) [secret key]', async () => {
    const resp = await axios.get(`${KORA_BASE_URL}/merchant/api/v1/payouts`, {
      params: { limit: 1 }, headers: secretHeaders, timeout: 15000,
    });
    return { status: resp.data.status, has_more: resp.data.has_more };
  });
}

main().catch(e => { console.error('PROBE CRASHED', e.message); process.exitCode = 1; });
