'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const {
  createDynamicQrPostgres,
  validateDynamicQrString,
  signDynamicQr,
  parseDynamicQrString,
} = require('../../db/dynamicQrPostgres');
const { commitQrPayPostgres } = require('../../db/qrPayPostgres');

const SECRET = 'test-dynamic-qr-hmac-secret';

function requireDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
}

async function ensureQrColumns() {
  await pool.query(`
    ALTER TABLE qr_codes
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS wallet_id TEXT,
      ADD COLUMN IF NOT EXISTS amount BIGINT,
      ADD COLUMN IF NOT EXISTS currency TEXT,
      ADD COLUMN IF NOT EXISTS hmac_signature TEXT,
      ADD COLUMN IF NOT EXISTS nonce TEXT,
      ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS used_by UUID,
      ADD COLUMN IF NOT EXISTS transaction_id UUID
  `);
}

async function seedUserWallet({ userId, walletId, currency, amount }) {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at)
     VALUES ($1,$2,'x','US','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@dynqr.test`]
  );
  await pool.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd)
     VALUES ($1,$2,NOW(),250000) ON CONFLICT (id) DO NOTHING`,
    [walletId, userId]
  );
  await pool.query(
    `INSERT INTO wallet_balances (wallet_id, currency, amount)
     VALUES ($1,$2,$3)
     ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
    [walletId, currency, amount]
  );
}

async function cleanup(ids) {
  await pool.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await pool.query('DELETE FROM ledger WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  if (ids.requests?.length) {
    await pool.query(
      `UPDATE payment_requests SET transaction_id = NULL, settled_by_transaction_id = NULL
        WHERE id = ANY($1::uuid[])`,
      [ids.requests]
    );
    await pool.query('DELETE FROM qr_codes WHERE id = ANY($1::uuid[])', [ids.requests]);
    await pool.query('DELETE FROM payment_requests WHERE id = ANY($1::uuid[])', [ids.requests]);
  }
  await pool.query(
    'DELETE FROM transactions WHERE from_wallet_id = ANY($1::text[]) OR to_wallet_id = ANY($1::text[])',
    [ids.wallets]
  );
  await pool.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await pool.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

test('dynamic QR: create in Postgres, pay succeeds, duplicate scan rejected', async () => {
  requireDb();
  await ensureQrColumns();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [],
    transactions: [uuidv4(), uuidv4()],
  };
  try {
    await seedUserWallet({ userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 5000 });
    await seedUserWallet({ userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const created = await createDynamicQrPostgres({
      user: { id: ids.users[1], email: `${ids.users[1]}@dynqr.test`, passwordHash: 'x', region: 'US', createdAt: Date.now() },
      wallet: { id: ids.wallets[1], userId: ids.users[1], createdAt: Date.now(), maxLimitUSD: 250000 },
      amount: 750,
      currency: 'USD',
      memo: 'dyn test',
      expiryMinutes: 15,
      hmacSecret: SECRET,
    });
    ids.requests.push(created.requestId);

    const ok = await validateDynamicQrString(created.qrString, SECRET);
    assert.equal(ok.ok, true);

    const pay1 = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 750,
      tx: {
        id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1],
        amount: 750, currency: 'USD', receivedAmount: 750, receivedCurrency: 'USD',
        wasConverted: false, memo: 'dyn test', type: 'qr_payment', status: 'completed', timestamp: Date.now(),
      },
      clientKey: `dyn-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true, tx: ids.transactions[0] },
      requestId: created.requestId,
      recipientUserId: ids.users[1],
    });
    assert.equal(pay1.replay, false);
    assert.equal(!!pay1.alreadyProcessed, false);

    const pay2 = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 750,
      tx: {
        id: ids.transactions[1], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1],
        amount: 750, currency: 'USD', receivedAmount: 750, receivedCurrency: 'USD',
        wasConverted: false, memo: 'dyn test', type: 'qr_payment', status: 'completed', timestamp: Date.now(),
      },
      clientKey: `dyn-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      requestId: created.requestId,
      recipientUserId: ids.users[1],
    });
    assert.equal(pay2.alreadyProcessed, true);

    const bal = await pool.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2',
      [ids.wallets[0], 'USD']
    );
    assert.equal(Number(bal.rows[0].amount), 4250);
    const qr = await pool.query('SELECT status, used_at FROM qr_codes WHERE id=$1', [created.requestId]);
    assert.equal(qr.rows[0].status, 'used');
    assert.ok(qr.rows[0].used_at);
  } finally {
    await cleanup(ids);
  }
});

test('dynamic QR: expired and tampered rejected; failure leaves balances unchanged', async () => {
  requireDb();
  await ensureQrColumns();
  const ids = {
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    requests: [],
    transactions: [uuidv4()],
  };
  try {
    await seedUserWallet({ userId: ids.users[0], walletId: ids.wallets[0], currency: 'USD', amount: 3000 });
    await seedUserWallet({ userId: ids.users[1], walletId: ids.wallets[1], currency: 'USD', amount: 0 });

    const created = await createDynamicQrPostgres({
      user: { id: ids.users[1], email: `${ids.users[1]}@dynqr.test`, passwordHash: 'x', region: 'US', createdAt: Date.now() },
      wallet: { id: ids.wallets[1], userId: ids.users[1], createdAt: Date.now(), maxLimitUSD: 250000 },
      amount: 500,
      currency: 'USD',
      memo: '',
      expiryMinutes: 15,
      hmacSecret: SECRET,
    });
    ids.requests.push(created.requestId);

    const parsed = parseDynamicQrString(created.qrString);
    const tampered = created.qrString.replace(`a=${parsed.amount}`, 'a=99999');
    const tamperCheck = await validateDynamicQrString(tampered, SECRET);
    assert.equal(tamperCheck.ok, false);
    assert.equal(tamperCheck.code, 'TAMPERED');

    await pool.query(
      `UPDATE qr_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [created.requestId]
    );
    const expiredVal = await validateDynamicQrString(created.qrString, SECRET);
    assert.equal(expiredVal.ok, false);
    assert.equal(expiredVal.code, 'EXPIRED');

    const expiredPay = await commitQrPayPostgres({
      fromWalletId: ids.wallets[0],
      toWalletId: ids.wallets[1],
      currency: 'USD',
      amount: 500,
      tx: {
        id: ids.transactions[0], fromWalletId: ids.wallets[0], toWalletId: ids.wallets[1],
        amount: 500, currency: 'USD', receivedAmount: 500, receivedCurrency: 'USD',
        wasConverted: false, memo: '', type: 'qr_payment', status: 'completed', timestamp: Date.now(),
      },
      clientKey: `dyn-exp-${uuidv4()}`,
      userId: ids.users[0],
      responseBody: { ok: true },
      requestId: created.requestId,
      recipientUserId: ids.users[1],
    });
    assert.equal(expiredPay.expired, true);

    const bal = await pool.query(
      'SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2',
      [ids.wallets[0], 'USD']
    );
    assert.equal(Number(bal.rows[0].amount), 3000);
  } finally {
    await cleanup(ids);
  }
});

test('dynamic QR: sign helper is deterministic', () => {
  const fields = {
    requestId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    walletId: '33333333-3333-4333-8333-333333333333',
    amount: 100,
    currency: 'USD',
    memo: 'x',
    expiry: 1700000000000,
    nonce: 'abc',
  };
  assert.equal(signDynamicQr(SECRET, fields), signDynamicQr(SECRET, fields));
  assert.notEqual(signDynamicQr(SECRET, fields), signDynamicQr(SECRET, { ...fields, amount: 101 }));
});
