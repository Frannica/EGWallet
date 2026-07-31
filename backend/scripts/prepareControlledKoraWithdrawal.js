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
    notSupported: {
      GQ: 'Equatorial Guinea — no cash-out corridor',
      US_UK_EU: 'Unavailable while Stripe Connect disabled',
      XAF_outside_CM: 'Sharing XAF does not establish payout',
      XOF_outside_CI: 'Sharing XOF does not establish payout',
    },
    recentWithdrawals: recent.rows,
    authorizationRequiredExactTemplate:
      'APPROVE KORA WITHDRAWAL $<amount> <CURRENCY> to <METHOD> <COUNTRY> for <email> beneficiary <details>',
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
