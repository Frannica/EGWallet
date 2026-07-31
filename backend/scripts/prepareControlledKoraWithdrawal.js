'use strict';
/**
 * PREPARE (do not execute) one controlled real Kora withdrawal.
 * READ-ONLY against production DB + health. Never calls Kora disbursement.
 *
 *   railway run --service Postgres -- node backend/scripts/prepareControlledKoraWithdrawal.js
 */
const { Client } = require('pg');

async function main() {
  const base = process.env.PUBLIC_API_BASE
    || 'https://egwalletsimple-production.up.railway.app';
  const healthRes = await fetch(`${base}/health`);
  const health = await healthRes.json();

  const url = process.env.DATABASE_PUBLIC_URL
    || (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes('railway.internal')
      ? process.env.DATABASE_URL
      : null);
  if (!url) {
    console.error('DATABASE_PUBLIC_URL required');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const corridors = [
    { country: 'NG', currency: 'NGN', methods: ['bank'] },
    { country: 'KE', currency: 'KES', methods: ['bank', 'mobile_money'] },
    { country: 'ZA', currency: 'ZAR', methods: ['bank'] },
    { country: 'GH', currency: 'GHS', methods: ['mobile_money'] },
    { country: 'CI', currency: 'XOF', methods: ['mobile_money'] },
    { country: 'CM', currency: 'XAF', methods: ['mobile_money'] },
    { country: 'EG', currency: 'EGP', methods: ['mobile_money'] },
    { country: 'TZ', currency: 'TZS', methods: ['mobile_money'] },
  ];

  const recent = await client.query(
    `SELECT id, user_id, status, currency, amount, country, method, created_at
       FROM withdrawals
      ORDER BY created_at DESC LIMIT 10`
  );

  await client.end();

  // Live misc/mobile-money mins probed 2026-07-31 (see probeKoraCorridorMinsReadOnly.js).
  // Smallest published operator min among live corridors: GH mobile money GHS 1.
  // XAF/XOF also require multiples of 5 → effective min 5 despite operator min 2.
  const smallestValid = {
    country: 'GH',
    currency: 'GHS',
    method: 'mobile',
    amountMajor: 1,
    amountMinor: 100,
    operatorSlug: 'mtn-gh',
    operatorAlternates: ['airtel-gh', 'tigo-gh', 'vodafone-gh'],
    beneficiaryFields: {
      country: 'GH',
      currency: 'GHS',
      method: 'mobile',
      bankCode: 'mtn-gh',
      accountNumber: '233XXXXXXXXX',
      accountHolderName: '<legal name on MM wallet>',
      phoneFormat: '233 + 9 digits, no leading + or 0 after country code',
      examplePhone: '233241234567',
    },
    notes: [
      'Amount is Kora live operator minimum (major units) from GET /misc/mobile-money?countryCode=GH',
      'EG EGP 1 mobile money is equally small; GH preferred for GHS funding clarity',
      'Bank corridors have no per-bank min from List Banks; NGN bulk docs cite 1000 NGN — not used for smallest test',
      'Do not execute until exact approval text includes amount, currency, method, country, email, beneficiary',
    ],
  };

  const plan = {
    readOnly: true,
    noKoraDisbursement: true,
    health: {
      status: health.status,
      gitCommit: health.gitCommit,
      koraProviderReady: health.koraProviderReady,
      stripeConnectEnabled: health.stripeConnectEnabled,
    },
    supportedCorridors: corridors,
    smallestValidPrepared: smallestValid,
    notSupported: {
      GQ: 'Equatorial Guinea — no cash-out corridor',
      US_UK_EU: 'Unavailable while Stripe Connect disabled',
      XAF_outside_CM: 'Sharing XAF does not establish payout',
      XOF_outside_CI: 'Sharing XOF does not establish payout',
    },
    recentWithdrawals: recent.rows,
    authorizationRequiredExactTemplate:
      'APPROVE KORA WITHDRAWAL 1 GHS to mobile GH for <email> beneficiary mtn-gh <233XXXXXXXXX> <accountHolderName>',
    stop: 'NO MONEY MOVED. Provide exact amount, currency, country, method, beneficiary, and user email before any live Kora payout.',
    proofsRequiredAfterApproval: [
      'balance before/after',
      'hold + fee',
      'Kora disbursement id',
      'webhook paid/failed',
      'ledger + admin queue',
      'app history/receipt',
    ],
  };

  console.log(JSON.stringify(plan, null, 2));
  process.exit(health.koraProviderReady ? 0 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
