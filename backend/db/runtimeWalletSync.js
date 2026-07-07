'use strict';

function msToDate(ms) {
  return new Date(Number(ms || Date.now()));
}

async function upsertRuntimeWalletMetadata(client, wallet) {
  if (!wallet || !wallet.id || !wallet.userId) return;
  await client.query(
    `INSERT INTO wallets (id, user_id, type, employer_id, max_limit_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      wallet.id,
      wallet.userId,
      wallet.type || null,
      wallet.employerId || null,
      wallet.maxLimitUSD === undefined ? null : Number(wallet.maxLimitUSD),
      msToDate(wallet.createdAt),
    ]
  );
}

module.exports = {
  msToDate,
  upsertRuntimeWalletMetadata,
};
