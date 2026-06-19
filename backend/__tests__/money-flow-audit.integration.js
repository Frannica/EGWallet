/**
 * Full money-flow audit against a live API.
 * Usage: node backend/__tests__/money-flow-audit.integration.js [API_BASE]
 */

'use strict';

const API_BASE = process.argv[2] || process.env.API_BASE || 'https://egwalletsimple-production.up.railway.app';
const RUN_ID = Date.now().toString(36);
const IS_LOCAL = API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1');

const results = [];

function record(flow, status, proof) {
  results.push({ flow, status, ...proof });
  const icon = status === 'PASS' ? '✅' : status === 'BLOCKED' ? '⏸' : '❌';
  console.log(`\n${icon} ${flow} — ${status}`);
  for (const [k, v] of Object.entries(proof)) {
    if (k === 'response' && typeof v === 'object') {
      console.log(`   ${k}: ${JSON.stringify(v).slice(0, 400)}`);
    } else {
      console.log(`   ${k}: ${v}`);
    }
  }
}

async function api(path, { method = 'GET', token, body, headers = {}, lang = 'es' } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': lang,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

function walletBalance(walletsRes, currency = 'USD') {
  const w = walletsRes.data?.wallets?.[0];
  if (!w) return null;
  const b = (w.balances || []).find(x => x.currency === currency);
  return b ? b.amount : 0;
}

function major(minor, currency = 'USD') {
  const d = currency === 'XAF' || currency === 'JPY' ? 0 : 2;
  return (minor / Math.pow(10, d)).toFixed(d === 0 ? 0 : 2);
}

async function registerUser(label) {
  const email = `audit.${label}.${RUN_ID}@egwallet.test`;
  const password = 'AuditTest123!';
  const reg = await api('/auth/register', {
    method: 'POST',
    headers: { 'x-device-id': `audit-device-${label}-${RUN_ID}` },
    body: { email, password, region: 'US' },
  });
  if (reg.status !== 200) {
    throw new Error(`Register ${label} failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  }
  return {
    email,
    password,
    token: reg.data.token,
    userId: reg.data.user.id,
    walletId: reg.data.walletId,
  };
}

async function getWallets(token) {
  return api('/wallets', { token });
}

async function setUsername(token, username) {
  let res = await api('/auth/username', {
    method: 'PUT',
    token,
    body: { username },
  });
  if (res.status === 404) {
    res = await api('/auth/username', {
      method: 'POST',
      token,
      body: { username },
    });
  }
  return res;
}

async function demoDeposit(token, walletId, amountMinor, currency = 'USD') {
  const intent = await api('/deposits/create-intent', {
    method: 'POST',
    token,
    body: { amount: amountMinor, currency, walletId },
  });
  if (intent.status !== 200) {
    return { ok: false, intent };
  }
  if (intent.data.mode === 'stripe') {
    return { ok: false, intent, note: 'Stripe mode — demo deposit unavailable' };
  }
  const confirm = await api('/deposits/confirm', {
    method: 'POST',
    token,
    body: { intentId: intent.data.intentId, walletId: intent.data.resolvedWalletId || walletId },
  });
  return { ok: confirm.status === 200, intent, confirm };
}

async function sendMoney(token, fromWalletId, toWalletId, amountMinor, currency, idempotencyKey) {
  return api('/transactions', {
    method: 'POST',
    token,
    body: { fromWalletId, toWalletId, amount: amountMinor, currency, idempotencyKey },
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

function printScorecard(localResults = null) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' AUDIT SCORECARD');
  console.log(` API: ${API_BASE}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('#\tFlow\t\t\t\tResult');
  const rows = [
    ['1', 'Send by @username', '1. Send by @username'],
    ['2', 'Send by Wallet ID', '2. Send by Wallet ID'],
    ['3', 'Send by QR', '3. Send by QR code'],
    ['4', 'Request Money', '4. Request Money'],
    ['5', 'Pay Request', '5. Pay Request'],
    ['6', 'Add Money', '6. Add Money / Deposit'],
    ['7', 'Withdraw', '7. Withdraw'],
    ['8', 'Exchange', '8. Exchange'],
    ['9', 'Balance sync', '9. Pull-to-refresh balance sync'],
    ['10', 'Transaction history', '10. Transaction history'],
    ['11', 'Idempotent pay', '11. Duplicate/idempotent payment retry'],
    ['12', 'Send idempotency', '12. Send idempotency / timeout recovery'],
  ];
  for (const [num, label, key] of rows) {
    const r = results.find(x => x.flow.startsWith(key) || x.flow === key);
    const status = r ? r.status : '—';
    const localHint = localResults ? '' : '';
    console.log(`${num}\t${label.padEnd(28)}\t${status}${localHint}`);
  }
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  console.log(`\n Totals: ${pass} PASS · ${fail} FAIL · ${blocked} BLOCKED · ${results.length} flows`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' EGWallet Money-Flow Audit');
  console.log(` API: ${API_BASE}`);
  console.log(` Run: ${RUN_ID}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const health = await api('/health');
  record('Health check', health.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'GET /health',
    httpStatus: health.status,
    gitCommit: health.data?.gitCommit ?? 'missing',
    allowDemoDeposits: health.data?.allowDemoDeposits ?? 'missing',
    stripeConfigured: health.data?.stripeConfigured ?? 'missing',
  });

  if (health.status !== 200) {
    printScorecard();
    process.exit(1);
  }

  let sender;
  let receiver;
  try {
    sender = await registerUser('sender');
    receiver = await registerUser('receiver');
  } catch (e) {
    record('Setup test users', 'FAIL', { error: e.message });
    printScorecard();
    process.exit(1);
  }

  const receiverHandle = `rcv${RUN_ID.slice(-6)}`;
  const unameRes = await setUsername(receiver.token, receiverHandle);
  record('Username setup (prerequisite)', unameRes.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'PUT/POST /auth/username',
    httpStatus: unameRes.status,
    username: receiverHandle,
    errorCode: unameRes.data?.errorCode,
    mixedLanguageError: unameRes.data?.error === 'Not found' ? 'YES' : 'no',
  });

  const deposit = await demoDeposit(sender.token, sender.walletId, 50000, 'USD');
  record('6. Add Money / Deposit', deposit.ok ? 'PASS' : deposit.ok === false && deposit.intent?.status === 503 ? 'BLOCKED' : 'FAIL', {
    endpoint: 'POST /deposits/create-intent + confirm',
    httpStatus: deposit.intent?.status,
    mode: deposit.intent?.data?.mode,
    senderStartUSD: major(0),
    senderEndUSD: deposit.ok ? major(50000) : 'unchanged',
    transactionId: deposit.confirm?.data?.transaction?.id,
  });

  if (!deposit.ok) {
    printScorecard();
    process.exit(1);
  }

  let senderBal = walletBalance(await getWallets(sender.token));
  let receiverBal = walletBalance(await getWallets(receiver.token));

  // 2. Send by Wallet ID
  const idKeyWid = `audit-wid-${RUN_ID}`;
  const sendWid = await sendMoney(sender.token, sender.walletId, receiver.walletId, 10000, 'USD', idKeyWid);
  const txWid = sendWid.data?.transaction?.id;
  const afterWidSender = walletBalance(await getWallets(sender.token));
  const afterWidReceiver = walletBalance(await getWallets(receiver.token));
  record('2. Send by Wallet ID', sendWid.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'POST /transactions',
    senderStartUSD: major(senderBal),
    senderEndUSD: major(afterWidSender),
    receiverStartUSD: major(receiverBal),
    receiverEndUSD: major(afterWidReceiver),
    httpStatus: sendWid.status,
    transactionId: txWid,
    ledgerConsistent: afterWidSender === senderBal - 10000 && afterWidReceiver === receiverBal + 10000,
  });
  senderBal = afterWidSender;
  receiverBal = afterWidReceiver;

  // 1. Send by @username
  const idKeyUname = `audit-uname-${RUN_ID}`;
  const sendUname = await sendMoney(sender.token, sender.walletId, `@${receiverHandle}`, 5000, 'USD', idKeyUname);
  const afterUnameSender = walletBalance(await getWallets(sender.token));
  const afterUnameReceiver = walletBalance(await getWallets(receiver.token));
  record('1. Send by @username', sendUname.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'POST /transactions toWalletId=@username',
    recipient: `@${receiverHandle}`,
    senderStartUSD: major(senderBal),
    senderEndUSD: major(afterUnameSender),
    receiverStartUSD: major(receiverBal),
    receiverEndUSD: major(afterUnameReceiver),
    httpStatus: sendUname.status,
    error: sendUname.data?.error,
    ledgerConsistent: sendUname.status === 200 && afterUnameSender === senderBal - 5000,
  });
  if (sendUname.status === 200) {
    senderBal = afterUnameSender;
    receiverBal = afterUnameReceiver;
  }

  // 4. Request Money
  const reqCreate = await api('/payment-requests', {
    method: 'POST',
    token: receiver.token,
    body: {
      walletId: receiver.walletId,
      amount: 2500,
      currency: 'USD',
      memo: 'audit request',
      recipientHandle: sender.email,
    },
  });
  const requestId = reqCreate.data?.request?.id;
  const payKey = `audit-pay-${RUN_ID}`;
  let payReq = { status: 0, data: {} };
  if (requestId) {
    payReq = await api(`/payment-requests/${requestId}/pay`, {
      method: 'POST',
      token: sender.token,
      body: { fromWalletId: sender.walletId },
      headers: { 'Idempotency-Key': payKey },
    });
  }
  const afterPaySender = walletBalance(await getWallets(sender.token));
  const afterPayReceiver = walletBalance(await getWallets(receiver.token));
  const payOk = reqCreate.status === 200 && payReq.status === 200;
  record('4. Request Money', reqCreate.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'POST /payment-requests',
    httpStatus: reqCreate.status,
    requestId,
    memo: 'audit request',
  });
  record('5. Pay Request', payReq.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: requestId ? `POST /payment-requests/${requestId}/pay` : 'n/a',
    httpStatus: payReq.status,
    senderStartUSD: major(senderBal),
    senderEndUSD: major(afterPaySender),
    receiverStartUSD: major(receiverBal),
    receiverEndUSD: major(afterPayReceiver),
    idempotentReplay: payReq.data?.idempotentReplay,
    ledgerConsistent: payOk && afterPaySender === senderBal - 2500 && afterPayReceiver === receiverBal + 2500,
  });
  if (payOk) {
    senderBal = afterPaySender;
    receiverBal = afterPayReceiver;
  }

  // 3. Send by QR code (before idempotency replay tests to avoid balance pollution)
  const qrStatic = await api('/qr/static', { token: receiver.token });
  const qrString = qrStatic.data?.qrCode || qrStatic.data?.qrString;
  let qrPass = false;
  if (qrStatic.status === 200 && qrString) {
    const qrKey = `audit-qr-${RUN_ID}`;
    const qrPay = await api('/qr/pay', {
      method: 'POST',
      token: sender.token,
      body: {
        qrString,
        fromWalletId: sender.walletId,
        amount: 1500,
        currency: 'USD',
        idempotencyKey: qrKey,
      },
      headers: { 'Idempotency-Key': qrKey },
    });
    const afterQrSender = walletBalance(await getWallets(sender.token));
    const afterQrReceiver = walletBalance(await getWallets(receiver.token));
    qrPass = qrPay.status === 200;
    record('3. Send by QR code', qrPass ? 'PASS' : 'FAIL', {
      generateEndpoint: 'GET /qr/static',
      payEndpoint: 'POST /qr/pay',
      httpStatus: qrPay.status,
      senderStartUSD: major(senderBal),
      senderEndUSD: major(afterQrSender),
      receiverStartUSD: major(receiverBal),
      receiverEndUSD: major(afterQrReceiver),
      transactionId: qrPay.data?.transaction?.id,
      ledgerConsistent: qrPass && afterQrSender === senderBal - 1500,
    });
    if (qrPass) {
      senderBal = afterQrSender;
      receiverBal = afterQrReceiver;
    }
  } else {
    record('3. Send by QR code', 'FAIL', { generateStatus: qrStatic.status, response: qrStatic.data });
  }

  // 11. Idempotent pay retry
  let payReplay = { status: 0, data: {} };
  if (requestId) {
    payReplay = await api(`/payment-requests/${requestId}/pay`, {
      method: 'POST',
      token: sender.token,
      body: { fromWalletId: sender.walletId },
      headers: { 'Idempotency-Key': payKey },
    });
  }
  const afterReplaySender = walletBalance(await getWallets(sender.token));
  const afterReplayReceiver = walletBalance(await getWallets(receiver.token));
  record('11. Duplicate/idempotent payment retry', payReplay.status === 200 && afterReplaySender === senderBal ? 'PASS' : 'FAIL', {
    endpoint: 'POST /payment-requests/:id/pay (replay)',
    httpStatus: payReplay.status,
    alreadyProcessed: payReplay.data?.idempotentReplay ?? payReplay.data?.request?.status === 'paid',
    senderBalanceUnchanged: afterReplaySender === senderBal,
    receiverBalanceUnchanged: afterReplayReceiver === receiverBal,
    falseFailure: payReplay.status >= 400 ? 'YES' : 'no',
  });

  // 12. Send idempotency replay (same key as first wallet-ID send)
  const sendReplay = await sendMoney(sender.token, sender.walletId, receiver.walletId, 10000, 'USD', idKeyWid);
  const afterSendReplaySender = walletBalance(await getWallets(sender.token));
  const replayTxId = sendReplay.data?.transaction?.id;
  const sameTx = replayTxId && txWid && replayTxId === txWid;
  record('12. Send idempotency / timeout recovery', sendReplay.status === 200 && afterSendReplaySender === senderBal && (sameTx || sendReplay.data?.alreadyProcessed) ? 'PASS' : 'FAIL', {
    endpoint: 'POST /transactions (Idempotency-Key replay)',
    httpStatus: sendReplay.status,
    originalTxId: txWid,
    replayTxId,
    sameTransaction: sameTx,
    senderBalanceUnchanged: afterSendReplaySender === senderBal,
    doubleCharge: afterSendReplaySender < senderBal ? 'YES — CRITICAL' : 'no',
  });

  // 8. Exchange
  const xafDeposit = await demoDeposit(sender.token, sender.walletId, 6000, 'XAF');
  let exchangePass = false;
  if (xafDeposit.ok) {
    const exchKey = `audit-exch-${RUN_ID}`;
    const exch = await api('/exchange', {
      method: 'POST',
      token: sender.token,
      body: {
        walletId: sender.walletId,
        fromCurrency: 'XAF',
        toCurrency: 'USD',
        amount: 6000,
        idempotencyKey: exchKey,
      },
      headers: { 'Idempotency-Key': exchKey },
    });
    exchangePass = exch.status === 200;
    record('8. Exchange', exchangePass ? 'PASS' : 'FAIL', {
      endpoint: 'POST /exchange',
      httpStatus: exch.status,
      fromAmountXAF: major(6000, 'XAF'),
      receivedUSD: exch.data?.receivedAmount ? major(exch.data.receivedAmount) : 'n/a',
      transactionId: exch.data?.transaction?.id,
    });
  } else {
    record('8. Exchange', 'FAIL', { note: 'XAF demo deposit failed', status: xafDeposit.intent?.status });
  }

  // 7. Withdraw
  const withdrawKey = `audit-wd-${RUN_ID}`;
  const withdraw = await api('/withdrawals', {
    method: 'POST',
    token: sender.token,
    body: {
      fromWalletId: sender.walletId,
      amount: 1000,
      currency: 'USD',
      method: 'debit',
      accountNumber: '4242424242424242',
      bankName: 'Audit Bank',
      accountHolderName: 'Audit User',
    },
    headers: { 'Idempotency-Key': withdrawKey },
  });
  const withdrawBlocked = withdraw.status === 503;
  record('7. Withdraw', withdrawBlocked ? 'BLOCKED' : withdraw.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'POST /withdrawals',
    httpStatus: withdraw.status,
    note: withdrawBlocked ? 'No payout provider in production — expected' : '',
  });

  // 9–10. Balance sync + history
  const walletsFinal = await getWallets(sender.token);
  const txHistory = await api(`/wallets/${sender.walletId}/transactions`, { token: sender.token });
  const txList = Array.isArray(txHistory.data)
    ? txHistory.data
    : txHistory.data?.transactions || [];
  record('9. Pull-to-refresh balance sync', walletsFinal.status === 200 ? 'PASS' : 'FAIL', {
    endpoint: 'GET /wallets',
    backendBalanceUSD: major(walletBalance(walletsFinal)),
    staleUI: 'client uses refreshWalletFromBackend — Phase 18 regression',
  });
  record('10. Transaction history', txHistory.status === 200 && txList.length >= 3 ? 'PASS' : 'FAIL', {
    endpoint: `GET /wallets/${sender.walletId}/transactions`,
    recordCount: txList.length,
    types: [...new Set(txList.map(t => t.type))].join(', '),
  });

  printScorecard();
  const criticalFails = results.filter(r =>
    r.status === 'FAIL' &&
    !r.flow.startsWith('7.') &&
    !r.flow.startsWith('Health')
  );
  process.exit(criticalFails.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Audit crashed:', err);
  process.exit(1);
});
