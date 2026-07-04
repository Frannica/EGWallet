'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const depositScreen = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'DepositScreen.tsx'),
  'utf8',
);
const flightPath = path.join(__dirname, '..', 'src', 'stripe', 'paymentSheetSingleFlight.ts');
const flightSource = fs.readFileSync(flightPath, 'utf8');
const stripeSdkSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'stripe', 'stripeSdk.ts'),
  'utf8',
);

function loadFlightModule() {
  const transpiled = ts.transpileModule(flightSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: flightPath,
  });
  const Module = require('module');
  const m = new Module(flightPath, module);
  m._compile(transpiled.outputText, flightPath);
  return m.exports;
}

test('DepositScreen must not re-present when stripe hook identity changes', () => {
  assert.doesNotMatch(depositScreen, /\[clientSecret,\s*stripe\]/);
  assert.match(depositScreen, /runDepositPaymentSheetOnce\(/);
  assert.match(depositScreen, /startedForSecretRef/);
});

test('runCardOnlyPaymentSheetOnce opens only one sheet for concurrent callers', async () => {
  const { runCardOnlyPaymentSheetOnce, _resetPaymentSheetInFlightForTests } = loadFlightModule();
  _resetPaymentSheetInFlightForTests();

  let initCount = 0;
  let presentCount = 0;
  const stripe = {
    initPaymentSheet: async () => {
      initCount += 1;
      await new Promise(r => setTimeout(r, 20));
      return {};
    },
    presentPaymentSheet: async () => {
      presentCount += 1;
      await new Promise(r => setTimeout(r, 20));
      return {};
    },
  };

  const secret = 'pi_test_secret';
  const [a, b, c] = await Promise.all([
    runCardOnlyPaymentSheetOnce(stripe, secret, {}),
    runCardOnlyPaymentSheetOnce(stripe, secret, {}),
    runCardOnlyPaymentSheetOnce(stripe, secret, {}),
  ]);

  assert.equal(initCount, 1);
  assert.equal(presentCount, 1);
  assert.deepEqual(a, { status: 'success' });
  assert.deepEqual(b, { status: 'success' });
  assert.deepEqual(c, { status: 'success' });
});

module.exports = function paymentSheetSingleFlight(check) {
  check(
    '[Deposit] PaymentSheet effect depends on clientSecret only (not stripe hook)',
    !/\[clientSecret,\s*stripe\]/.test(depositScreen) &&
    depositScreen.includes('runDepositPaymentSheetOnce('),
  );
  check(
    '[Deposit] Single-flight guard in paymentSheetSingleFlight.ts',
    flightSource.includes('paymentSheetInFlight') &&
    flightSource.includes('runCardOnlyPaymentSheetOnce'),
  );
  check(
    '[Deposit] stripeSdk wraps single-flight for card-only params',
    stripeSdkSource.includes('runDepositPaymentSheetOnce'),
  );
};
