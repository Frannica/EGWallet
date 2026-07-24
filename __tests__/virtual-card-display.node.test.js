'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const CARD_SCREEN = path.join(__dirname, '..', 'src', 'screens', 'CardScreen.tsx');
const DISPLAY_UTIL = path.join(__dirname, '..', 'src', 'utils', 'virtualCardDisplay.ts');

function loadTsModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filePath,
  });

  const m = new Module(filePath, module);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(transpiled.outputText, filePath);
  return m.exports;
}

/** Mirror of backend/index.js sanitizeCard — keep in sync with production API. */
function sanitizeCard(card) {
  if (!card) return card;
  const { cvv, cardNumber, ...rest } = card;
  const last4 = rest.last4 || (cardNumber ? cardNumber.slice(-4) : '****');
  return { ...rest, last4, maskedNumber: `****${last4}` };
}

function sampleDbCard(overrides = {}) {
  return {
    id: 'card-1',
    userId: 'user-1',
    walletId: 'wallet-1',
    last4: '4242',
    expiryMonth: '12',
    expiryYear: '28',
    currency: 'USD',
    label: 'Virtual Card',
    status: 'active',
    createdAt: Date.now(),
    ...overrides,
  };
}

function assertNoThrow(label, fn) {
  try {
    fn();
    return { ok: true, label };
  } catch (e) {
    return { ok: false, label, error: e };
  }
}

module.exports = function runVirtualCardDisplayTests(check) {
  const { formatMaskedCardNumber, formatCardExpiry } = loadTsModule(DISPLAY_UTIL);
  const cardScreenSource = fs.readFileSync(CARD_SCREEN, 'utf8');

  // ── Production API shape (sanitized list response) ───────────────────────
  const dbCard = sampleDbCard();
  const apiListCard = sanitizeCard(dbCard);

  check(
    'sanitizeCard removes cardNumber (matches GET /virtual-cards)',
    apiListCard.cardNumber === undefined && apiListCard.last4 === '4242',
  );

  const sanitizedRender = assertNoThrow('render list with sanitized API card', () => {
    formatMaskedCardNumber(apiListCard);
  });
  check(
    'formatMaskedCardNumber does not throw on sanitized API card',
    sanitizedRender.ok,
  );
  check(
    'formatMaskedCardNumber shows last4 from sanitized API card',
    formatMaskedCardNumber(apiListCard) === '**** **** **** 4242',
  );

  // ── Legacy / create-response shapes ────────────────────────────────────
  check(
    'create response with full cardNumber still works',
    formatMaskedCardNumber({ cardNumber: '4111111111114242' }) === '**** **** **** 4242',
  );
  check(
    'last4-only card works',
    formatMaskedCardNumber({ last4: '9999' }) === '**** **** **** 9999',
  );
  check(
    'maskedNumber-only card works',
    formatMaskedCardNumber({ maskedNumber: '****1234' }) === '**** **** **** 1234',
  );
  check(
    'completely empty card fields fall back safely',
    formatMaskedCardNumber({}) === '**** **** **** ****',
  );
  check(
    'undefined string input falls back safely',
    formatMaskedCardNumber('') === '**** **** **** ****',
  );

  // ── Simulated full list render (old crash path) ────────────────────────
  const cards = [
    sanitizeCard(sampleDbCard({ id: 'a', last4: '1111' })),
    sanitizeCard(sampleDbCard({ id: 'b', last4: '2222', status: 'frozen' })),
    sanitizeCard({
      ...sampleDbCard({ id: 'c' }),
      cardNumber: '4000000000000002',
      cvv: '123',
    }),
  ];

  let listRenderFailed = false;
  for (const card of cards) {
    const result = assertNoThrow(`list card ${card.id}`, () => formatMaskedCardNumber(card));
    if (!result.ok) listRenderFailed = true;
  }
  check('simulated card list render never throws', !listRenderFailed);

  // ── Detail view expiry fallback ────────────────────────────────────────
  check(
    'formatCardExpiry handles missing fields',
    formatCardExpiry(undefined, undefined) === '--/--',
  );
  check(
    'formatCardExpiry formats normal expiry',
    formatCardExpiry('06', '29') === '06/29',
  );

  // ── Source audit: CardScreen must use shared helper, not raw .slice ─────
  check(
    'CardScreen imports formatMaskedCardNumber utility',
    /from ['"]\.\.\/utils\/virtualCardDisplay['"]/.test(cardScreenSource),
  );
  check(
    'CardScreen does not call maskCardNumber(card.cardNumber)',
    !/maskCardNumber\s*\(\s*card\.cardNumber\s*\)/.test(cardScreenSource),
  );
  check(
    'CardScreen does not call maskCardNumber(selectedCard.cardNumber)',
    !/maskCardNumber\s*\(\s*selectedCard\.cardNumber\s*\)/.test(cardScreenSource),
  );
  check(
    'CardScreen does not define inline number.slice(-4) PAN masking',
    !/number\.slice\(-4\)/.test(cardScreenSource),
  );
};
