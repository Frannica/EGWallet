// ── Unit test: verify preview endpoint math exactly as backend computes it ────
// Mirrors the logic in backend/index.js POST /payment-requests/:id/preview

const ZERO_DECIMAL = new Set(['JPY','KRW','VND','IDR','XOF','XAF','CLP','HUF',
  'PYG','UGX','RWF','GNF','MGA','KMF','DJF','BIF']);

const minorToMajor = (amt, cur) => ZERO_DECIMAL.has(cur) ? amt : amt / 100;
const majorToMinor = (amt, cur) => ZERO_DECIMAL.has(cur) ? Math.round(amt) : Math.round(amt * 100);

// Simulate live rates (realistic values from Railway)
const rates = { USD: 1, EUR: 0.92, XAF: 655, GBP: 0.79, JPY: 155 };

function simulatePreview(reqAmount, reqCurrency, senderBalances) {
  const exactBalance = senderBalances.find(b => b.currency === reqCurrency);
  if (exactBalance && exactBalance.amount >= reqAmount) {
    return { wasConverted: false, debitAmount: reqAmount, debitCurrency: reqCurrency,
             creditAmount: reqAmount, creditCurrency: reqCurrency, fxFeeAmount: 0, fxFeeRate: 0 };
  }

  // Cross-currency: pick richest balance
  const richest = senderBalances.reduce((best, b) => {
    const valUSD = minorToMajor(b.amount, b.currency) / (rates[b.currency] || 1);
    const bestUSD = best ? minorToMajor(best.amount, best.currency) / (rates[best.currency] || 1) : 0;
    return valUSD > bestUSD ? b : best;
  }, null);

  if (!richest) return { error: 'Insufficient funds' };

  const reqMajor = minorToMajor(reqAmount, reqCurrency);
  const reqUSD   = reqMajor / (rates[reqCurrency] || 1);
  const debitMajor = reqUSD * (rates[richest.currency] || 1);
  const baseDebit  = majorToMinor(debitMajor, richest.currency);
  const fxFeeRate  = 0.0115;
  const fxFeeAmount = Math.round(baseDebit * fxFeeRate);
  const debitAmount = baseDebit + fxFeeAmount;

  return { wasConverted: true, debitAmount, debitCurrency: richest.currency,
           creditAmount: reqAmount, creditCurrency: reqCurrency, fxFeeAmount, fxFeeRate };
}

let pass = 0; let fail = 0;
function assert(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'} ${label}`);
  if (!ok) { console.log('  Expected:', expected); console.log('  Got:     ', got); fail++; }
  else pass++;
}
function assertFeeRate(label, result) {
  if (!result.wasConverted) { assert(label + ' fxFeeRate=0', result.fxFeeRate, 0); return; }
  const base = result.debitAmount - result.fxFeeAmount;
  const expectedFee = Math.round(base * 0.0115);
  const diff = Math.abs(expectedFee - result.fxFeeAmount);
  const ok = diff <= 1;
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'} ${label} | base=${base} * 1.15% = ${expectedFee} | got=${result.fxFeeAmount} | diff=${diff}`);
  ok ? pass++ : fail++;
}

// ── Test 1: Same-currency, sufficient funds → no conversion ──────────────────
{
  const r = simulatePreview(500, 'USD', [{ currency:'USD', amount:10000 }]);
  assert('T1 wasConverted=false', r.wasConverted, false);
  assert('T1 debitAmount=reqAmount', r.debitAmount, 500);
  assert('T1 fxFeeAmount=0', r.fxFeeAmount, 0);
}

// ── Test 2: Same-currency, insufficient funds → cross-currency path ───────────
{
  const r = simulatePreview(50000, 'USD', [{ currency:'USD', amount:100 }, { currency:'XAF', amount:50000000 }]);
  assert('T2 wasConverted=true', r.wasConverted, true);
  assert('T2 debitCurrency=XAF', r.debitCurrency, 'XAF');
  assertFeeRate('T2 fee@1.15%', r);
  // Verify receiver gets exact amount
  assert('T2 creditAmount=reqAmount', r.creditAmount, 50000);
  assert('T2 creditCurrency=USD', r.creditCurrency, 'USD');
}

// ── Test 3: No USD, only XAF → pays USD request with XAF ─────────────────────
{
  // User has 50,000 XAF (~$76). Request is for $5 (500 minor).
  const r = simulatePreview(500, 'USD', [{ currency:'XAF', amount:50000 }]);
  assert('T3 wasConverted=true', r.wasConverted, true);
  assert('T3 debitCurrency=XAF', r.debitCurrency, 'XAF');
  // $5 at 655 XAF/USD = 3275 XAF base
  const expectedBase = majorToMinor(5 * 655, 'XAF'); // = 3275
  const expectedFee  = Math.round(expectedBase * 0.0115);
  assert('T3 debitAmount=base+fee', r.debitAmount, expectedBase + expectedFee);
  assertFeeRate('T3 fee@1.15%', r);
  console.log(`    T3 detail: $5 USD → ${expectedBase} XAF base + ${expectedFee} XAF fee = ${expectedBase+expectedFee} XAF total`);
}

// ── Test 4: JPY (zero decimal) paying EUR request ─────────────────────────────
{
  // User has 100,000 JPY (~$645). Request is €10 (1000 minor cents EUR).
  const r = simulatePreview(1000, 'EUR', [{ currency:'JPY', amount:100000 }]);
  assert('T4 wasConverted=true', r.wasConverted, true);
  assert('T4 debitCurrency=JPY', r.debitCurrency, 'JPY');
  assertFeeRate('T4 fee@1.15%', r);
  // €10 / 0.92 = $10.87 USD → * 155 JPY/USD = 1684 JPY base
  const reqMajor = minorToMajor(1000, 'EUR'); // 10.0
  const reqUSD = reqMajor / rates['EUR'];
  const debitMajor = reqUSD * rates['JPY'];
  const base = majorToMinor(debitMajor, 'JPY');
  const fee  = Math.round(base * 0.0115);
  assert('T4 debitAmount correct', r.debitAmount, base + fee);
  console.log(`    T4 detail: €10 EUR → ${base} JPY base + ${fee} JPY fee = ${base+fee} JPY total`);
}

// ── Test 5: 0 balance everywhere → Insufficient funds ─────────────────────────
{
  const r = simulatePreview(500, 'USD', [{ currency:'USD', amount:0 }]);
  assert('T5 error=Insufficient funds', r.error, 'Insufficient funds');
}

// ── Test 6: creditAmount always = reqAmount regardless of conversion ───────────
{
  const scenarios = [
    [500, 'USD', [{ currency:'XAF', amount:50000 }]],
    [10000, 'EUR', [{ currency:'GBP', amount:500000 }]],
    [50000, 'JPY', [{ currency:'USD', amount:100000 }]],
  ];
  scenarios.forEach(([amt, cur, bal], i) => {
    const r = simulatePreview(amt, cur, bal);
    assert(`T6.${i+1} creditAmount=reqAmount (receiver gets exact)`, r.creditAmount, amt);
    assert(`T6.${i+1} creditCurrency=reqCurrency`, r.creditCurrency, cur);
  });
}

console.log(`\n═══════════════════════════════`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail === 0) console.log('ALL UNIT TESTS PASS ✓');
else console.log('FAILURES DETECTED ✗');
