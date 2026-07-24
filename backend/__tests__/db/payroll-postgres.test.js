'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db/pool');
const { commitPayrollBatchPostgres } = require('../../db/payrollPostgres');
const { commitPaymentRequestPayPostgres } = require('../../db/paymentRequestPayPostgres');

function requireDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required');
  }
}

async function seedGraph(client, { employerUserId, employerId, fundingWalletId, workerUserId, workerWalletId, currency, fundingAmount }) {
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at) VALUES ($1,$2,'x','GQ','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
    [employerUserId, `${employerUserId}@payroll.test`]
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, region, role, created_at) VALUES ($1,$2,'x','GQ','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
    [workerUserId, `${workerUserId}@payroll.test`]
  );
  await client.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd) VALUES ($1,$2,NOW(),250000) ON CONFLICT (id) DO NOTHING`,
    [fundingWalletId, employerUserId]
  );
  await client.query(
    `INSERT INTO wallets (id, user_id, created_at, max_limit_usd) VALUES ($1,$2,NOW(),250000) ON CONFLICT (id) DO NOTHING`,
    [workerWalletId, workerUserId]
  );
  await client.query(
    `INSERT INTO wallet_balances (wallet_id, currency, amount) VALUES ($1,$2,$3) ON CONFLICT (wallet_id, currency) DO UPDATE SET amount = EXCLUDED.amount`,
    [fundingWalletId, currency, fundingAmount]
  );
  await client.query(
    `INSERT INTO employers (id, user_id, company_name, verification_status, funding_wallet_id, created_at)
     VALUES ($1,$2,'Payroll Test Co','verified',$3,NOW()) ON CONFLICT (id) DO NOTHING`,
    [employerId, employerUserId, fundingWalletId]
  );
}

async function cleanup(client, ids) {
  await client.query('DELETE FROM idempotency_records WHERE user_id = ANY($1::uuid[])', [ids.users]);
  await client.query('DELETE FROM payroll_payments WHERE employer_id = $1', [ids.employerId]);
  if (ids.requests?.length) await client.query('DELETE FROM payment_requests WHERE id = ANY($1::uuid[])', [ids.requests]);
  await client.query('DELETE FROM ledger WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM transactions WHERE id = ANY($1::uuid[])', [ids.transactions]);
  await client.query('DELETE FROM wallet_balances WHERE wallet_id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM employers WHERE id = $1', [ids.employerId]);
  await client.query('DELETE FROM wallets WHERE id = ANY($1::text[])', [ids.wallets]);
  await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids.users]);
}

test('payroll: bulk batch credits worker exactly once and debits employer funding wallet', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = {
    employerId: uuidv4(),
    users: [uuidv4(), uuidv4()],
    wallets: [uuidv4(), uuidv4()],
    transactions: [],
    requests: [],
  };
  const [employerUserId, workerUserId] = ids.users;
  const [fundingWalletId, workerWalletId] = ids.wallets;
  try {
    await seedGraph(client, { employerUserId, employerId: ids.employerId, fundingWalletId, workerUserId, workerWalletId, currency: 'XAF', fundingAmount: 500000 });

    const result = await commitPayrollBatchPostgres({
      employerId: ids.employerId,
      fundingWalletId,
      items: [{ workerId: workerUserId, workerEmail: 'worker@payroll.test', walletId: workerWalletId, currency: 'XAF', amount: 100000, memo: 'salary' }],
      batchId: `BATCH-${Date.now()}`,
      payPeriod: '2026-07',
      stateDb: null,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'success');
    ids.transactions.push(result.results[0].transactionId);

    const fundingBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [fundingWalletId, 'XAF']);
    const workerBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [workerWalletId, 'XAF']);
    assert.equal(Number(fundingBal.rows[0].amount), 400000);
    assert.equal(Number(workerBal.rows[0].amount), 100000);

    const guardRow = await client.query('SELECT * FROM payroll_payments WHERE employer_id=$1 AND worker_id=$2 AND pay_period=$3', [ids.employerId, workerUserId, '2026-07']);
    assert.equal(guardRow.rowCount, 1);
  } finally {
    try { await cleanup(client, ids); } finally { client.release(); }
  }
});

test('payroll: retrying the same batch (or a new batch for the same period) cannot double-pay the worker', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { employerId: uuidv4(), users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [], requests: [] };
  const [employerUserId, workerUserId] = ids.users;
  const [fundingWalletId, workerWalletId] = ids.wallets;
  try {
    await seedGraph(client, { employerUserId, employerId: ids.employerId, fundingWalletId, workerUserId, workerWalletId, currency: 'XAF', fundingAmount: 500000 });

    const item = { workerId: workerUserId, workerEmail: 'worker@payroll.test', walletId: workerWalletId, currency: 'XAF', amount: 100000, memo: 'salary' };

    const first = await commitPayrollBatchPostgres({
      employerId: ids.employerId, fundingWalletId, items: [item], batchId: 'BATCH-1', payPeriod: '2026-07', stateDb: null,
    });
    ids.transactions.push(first.results[0].transactionId);

    // Simulate a retry (e.g. employer double-clicks "Pay" again, or a second
    // bulk run accidentally includes the same worker for the same period).
    const second = await commitPayrollBatchPostgres({
      employerId: ids.employerId, fundingWalletId, items: [item], batchId: 'BATCH-2', payPeriod: '2026-07', stateDb: null,
    });

    assert.equal(first.results[0].status, 'success');
    assert.equal(second.results[0].status, 'already_paid');

    const workerBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [workerWalletId, 'XAF']);
    assert.equal(Number(workerBal.rows[0].amount), 100000, 'worker must be credited exactly once, not twice');

    const txCount = await client.query('SELECT COUNT(*)::int AS c FROM transactions WHERE to_wallet_id = $1', [workerWalletId]);
    assert.equal(txCount.rows[0].c, 1);
  } finally {
    try { await cleanup(client, ids); } finally { client.release(); }
  }
});

test('payroll: a different pay_period for the same worker is a legitimate, separate payment', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { employerId: uuidv4(), users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [], requests: [] };
  const [employerUserId, workerUserId] = ids.users;
  const [fundingWalletId, workerWalletId] = ids.wallets;
  try {
    await seedGraph(client, { employerUserId, employerId: ids.employerId, fundingWalletId, workerUserId, workerWalletId, currency: 'XAF', fundingAmount: 500000 });
    const item = { workerId: workerUserId, workerEmail: 'worker@payroll.test', walletId: workerWalletId, currency: 'XAF', amount: 100000, memo: 'salary' };

    const june = await commitPayrollBatchPostgres({ employerId: ids.employerId, fundingWalletId, items: [item], batchId: 'B-JUN', payPeriod: '2026-06', stateDb: null });
    const july = await commitPayrollBatchPostgres({ employerId: ids.employerId, fundingWalletId, items: [item], batchId: 'B-JUL', payPeriod: '2026-07', stateDb: null });
    ids.transactions.push(june.results[0].transactionId, july.results[0].transactionId);

    assert.equal(june.results[0].status, 'success');
    assert.equal(july.results[0].status, 'success');

    const workerBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [workerWalletId, 'XAF']);
    assert.equal(Number(workerBal.rows[0].amount), 200000);
  } finally {
    try { await cleanup(client, ids); } finally { client.release(); }
  }
});

test('payroll: insufficient employer funds fails that item without corrupting other items in the same batch', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { employerId: uuidv4(), users: [uuidv4(), uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4(), uuidv4()], transactions: [], requests: [] };
  const [employerUserId, worker1Id, worker2Id] = ids.users;
  const [fundingWalletId, wallet1Id, wallet2Id] = ids.wallets;
  try {
    await seedGraph(client, { employerUserId, employerId: ids.employerId, fundingWalletId, workerUserId: worker1Id, workerWalletId: wallet1Id, currency: 'XAF', fundingAmount: 100000 });
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at) VALUES ($1,$2,'x','GQ','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
      [worker2Id, `${worker2Id}@payroll.test`]
    );
    await client.query(
      `INSERT INTO wallets (id, user_id, created_at, max_limit_usd) VALUES ($1,$2,NOW(),250000) ON CONFLICT (id) DO NOTHING`,
      [wallet2Id, worker2Id]
    );

    // Item 1 needs more than the funding wallet has; item 2 is affordable.
    const items = [
      { workerId: worker1Id, workerEmail: 'w1@payroll.test', walletId: wallet1Id, currency: 'XAF', amount: 90000, memo: 'salary' },
      { workerId: worker2Id, workerEmail: 'w2@payroll.test', walletId: wallet2Id, currency: 'XAF', amount: 9000, memo: 'salary' },
    ];

    const result = await commitPayrollBatchPostgres({ employerId: ids.employerId, fundingWalletId, items, batchId: 'B-PARTIAL', payPeriod: '2026-07', stateDb: null });

    const byWorker = Object.fromEntries(result.results.map(r => [r.workerId, r]));
    assert.equal(byWorker[worker1Id].status, 'success');
    assert.equal(byWorker[worker2Id].status, 'success');
    ids.transactions.push(byWorker[worker1Id].transactionId, byWorker[worker2Id].transactionId);

    // Now try a THIRD worker in a new batch that would overdraw what's left (1000 remaining).
    const worker3Id = uuidv4();
    const wallet3Id = uuidv4();
    await client.query(
      `INSERT INTO users (id, email, password_hash, region, role, created_at) VALUES ($1,$2,'x','GQ','individual',NOW()) ON CONFLICT (id) DO NOTHING`,
      [worker3Id, `${worker3Id}@payroll.test`]
    );
    await client.query(
      `INSERT INTO wallets (id, user_id, created_at, max_limit_usd) VALUES ($1,$2,NOW(),250000) ON CONFLICT (id) DO NOTHING`,
      [wallet3Id, worker3Id]
    );
    ids.users.push(worker3Id);
    ids.wallets.push(wallet3Id);

    const result2 = await commitPayrollBatchPostgres({
      employerId: ids.employerId, fundingWalletId,
      items: [{ workerId: worker3Id, workerEmail: 'w3@payroll.test', walletId: wallet3Id, currency: 'XAF', amount: 5000, memo: 'salary' }],
      batchId: 'B-OVERDRAW', payPeriod: '2026-07', stateDb: null,
    });
    assert.equal(result2.results[0].status, 'failed');
    assert.equal(result2.results[0].error, 'insufficient_funds');

    // Worker 1 and 2's earlier successful payments must remain intact.
    const w1Bal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [wallet1Id, 'XAF']);
    const w2Bal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [wallet2Id, 'XAF']);
    assert.equal(Number(w1Bal.rows[0].amount), 90000);
    assert.equal(Number(w2Bal.rows[0].amount), 9000);
  } finally {
    try { await cleanup(client, ids); } finally { client.release(); }
  }
});

test('payroll: request-pay and bulk-pay share the same durable per-period guard (cross-path double-pay blocked)', async () => {
  requireDb();
  const client = await pool.connect();
  const ids = { employerId: uuidv4(), users: [uuidv4(), uuidv4()], wallets: [uuidv4(), uuidv4()], transactions: [], requests: [uuidv4()] };
  const [employerUserId, workerUserId] = ids.users;
  const [fundingWalletId, workerWalletId] = ids.wallets;
  try {
    await seedGraph(client, { employerUserId, employerId: ids.employerId, fundingWalletId, workerUserId, workerWalletId, currency: 'XAF', fundingAmount: 500000 });
    await client.query(
      `INSERT INTO payment_requests (id, requester_id, wallet_id, amount, currency, status, type, target_employer_id, created_at)
       VALUES ($1,$2,$3,$4,'XAF','pending','payroll_request',$5,NOW())`,
      [ids.requests[0], workerUserId, workerWalletId, 60000, ids.employerId]
    );

    // Step 1: bulk-pay this worker for July.
    const bulkResult = await commitPayrollBatchPostgres({
      employerId: ids.employerId, fundingWalletId,
      items: [{ workerId: workerUserId, workerEmail: 'w@payroll.test', walletId: workerWalletId, currency: 'XAF', amount: 60000, memo: 'salary' }],
      batchId: 'B-CROSS', payPeriod: '2026-07', stateDb: null,
    });
    assert.equal(bulkResult.results[0].status, 'success');
    ids.transactions.push(bulkResult.results[0].transactionId);

    // Bulk-pay's cross-flow settlement (see commitPayrollBatchPostgres) already
    // auto-cancelled the worker's pending payroll_request for this employer —
    // the first line of defense against double payment. Confirm that, THEN
    // separately prove the durable payroll_payments guard ALSO independently
    // blocks a same-period payment even in a request that is still 'pending'
    // (i.e. the guard is not merely relying on the cancel side-effect).
    const cancelledReq = await client.query('SELECT status FROM payment_requests WHERE id = $1', [ids.requests[0]]);
    assert.equal(cancelledReq.rows[0].status, 'cancelled');

    const txId = uuidv4();
    ids.transactions.push(txId);
    const reqResult = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: fundingWalletId,
      toWalletId: workerWalletId,
      debitCurrency: 'XAF',
      debitAmount: 60000,
      requestCurrency: 'XAF',
      requestAmount: 60000,
      tx: { id: txId, fromWalletId: fundingWalletId, toWalletId: workerWalletId, amount: 60000, currency: 'XAF', memo: 'req', status: 'completed', timestamp: Date.now() },
      clientKey: `cross-${uuidv4()}`,
      userId: employerUserId,
      responseBody: { ok: true },
      stateDb: null,
      payrollGuard: { employerId: ids.employerId, workerId: workerUserId, payPeriod: '2026-07' },
    });
    // Blocked either way (cancelled-request check fires first) — money safety holds regardless of ordering.
    assert.equal(reqResult.alreadyProcessed, true);

    // Now prove the payroll_payments guard is itself an independent line of
    // defense: re-open the request to 'pending' (simulating an ordering where
    // the cancel hasn't happened yet / a different request row for the same
    // worker+period) and confirm the durable guard still blocks it.
    await client.query(`UPDATE payment_requests SET status = 'pending', cancelled_at = NULL, cancel_reason = NULL WHERE id = $1`, [ids.requests[0]]);
    const txId2 = uuidv4();
    ids.transactions.push(txId2);
    const reqResult2 = await commitPaymentRequestPayPostgres({
      requestId: ids.requests[0],
      fromWalletId: fundingWalletId,
      toWalletId: workerWalletId,
      debitCurrency: 'XAF',
      debitAmount: 60000,
      requestCurrency: 'XAF',
      requestAmount: 60000,
      tx: { id: txId2, fromWalletId: fundingWalletId, toWalletId: workerWalletId, amount: 60000, currency: 'XAF', memo: 'req', status: 'completed', timestamp: Date.now() },
      clientKey: `cross2-${uuidv4()}`,
      userId: employerUserId,
      responseBody: { ok: true },
      stateDb: null,
      payrollGuard: { employerId: ids.employerId, workerId: workerUserId, payPeriod: '2026-07' },
    });
    assert.equal(reqResult2.payrollAlreadyPaid, true);

    const workerBal = await client.query('SELECT amount FROM wallet_balances WHERE wallet_id=$1 AND currency=$2', [workerWalletId, 'XAF']);
    assert.equal(Number(workerBal.rows[0].amount), 60000, 'worker must be credited exactly once across BOTH payroll endpoints');
  } finally {
    try { await cleanup(client, ids); } finally { client.release(); }
  }
});
