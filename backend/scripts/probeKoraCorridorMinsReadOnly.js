'use strict';
/**
 * READ-ONLY: fetch live Kora bank + mobile-money corridor limits.
 * Never calls disburse. Prefers railway run with KORA_LIVE_* env.
 *
 *   railway run --service EGWalletSimple -- node backend/scripts/probeKoraCorridorMinsReadOnly.js
 */
const {
  listKoraBanks,
  listKoraMobileMoneyOperators,
} = require('../payoutProviders');
const { MOBILE_MONEY_SNAPSHOT } = (() => {
  // Snapshot is not exported; re-read mins via live API + document bank corridors.
  return { MOBILE_MONEY_SNAPSHOT: null };
})();

const MM_COUNTRIES = ['KE', 'GH', 'CI', 'CM', 'EG', 'TZ'];
const BANK_COUNTRIES = ['NG', 'KE', 'ZA'];

async function main() {
  const report = {
    readOnly: true,
    noDisbursement: true,
    probedAt: new Date().toISOString(),
    mobileMoney: {},
    banks: {},
    smallestCandidates: [],
  };

  for (const cc of MM_COUNTRIES) {
    try {
      const ops = await listKoraMobileMoneyOperators(cc);
      report.mobileMoney[cc] = {
        source: 'live',
        operators: (ops || []).map((o) => ({
          slug: o.slug || o.code || o.name,
          name: o.name,
          code: o.code,
          min: o.min,
          max: o.max,
        })),
      };
      for (const o of ops || []) {
        if (typeof o.min === 'number') {
          report.smallestCandidates.push({
            country: cc,
            method: 'mobile_money',
            currency: ({
              KE: 'KES', GH: 'GHS', CI: 'XOF', CM: 'XAF', EG: 'EGP', TZ: 'TZS',
            })[cc],
            operator: o.slug || o.code || o.name,
            minMajor: o.min,
            maxMajor: o.max,
          });
        }
      }
    } catch (err) {
      report.mobileMoney[cc] = { source: 'error', error: err.message };
    }
  }

  for (const cc of BANK_COUNTRIES) {
    try {
      const banks = await listKoraBanks(cc);
      report.banks[cc] = {
        source: 'live',
        count: Array.isArray(banks) ? banks.length : 0,
        sample: (banks || []).slice(0, 3).map((b) => ({
          name: b.name || b.bank_name,
          code: b.code || b.bank_code || b.slug,
        })),
        note: 'Kora List Banks does not return per-bank min/max; use docs/bulk min or disburse-time validation',
      };
    } catch (err) {
      report.banks[cc] = { source: 'error', error: err.message };
    }
  }

  report.smallestCandidates.sort((a, b) => a.minMajor - b.minMajor);
  report.recommendedSmallestMobile = report.smallestCandidates[0] || null;

  // Bank corridors: document known bulk mins as upper-bound guidance only;
  // single-payout mins are not published per bank — prefer MM for smallest controlled test.
  report.bankCorridorNotes = {
    NG: { currency: 'NGN', method: 'bank', publishedBulkMinMajor: 1000, accountFormat: '10-digit NUBAN', fields: ['bankCode', 'accountNumber', 'accountHolderName'] },
    KE: { currency: 'KES', method: 'bank', publishedBulkMinMajor: null, accountFormat: '5-17 digits', fields: ['bankCode', 'accountNumber', 'accountHolderName'] },
    ZA: { currency: 'ZAR', method: 'bank', publishedBulkMinMajor: 50, accountFormat: '6-11 digits', fields: ['bankCode', 'accountNumber', 'accountHolderName', 'branchCode?'] },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
