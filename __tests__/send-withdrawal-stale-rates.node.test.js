'use strict';

const fs = require('fs');
const path = require('path');

/** Mirrors SendScreen calculatePreview + confirm guard after the withdrawal fix. */
function computeIsCrossCurrency({ activeTab, senderCurrency, receiverCurrency }) {
  const effectiveToCurrency = receiverCurrency || senderCurrency;
  return activeTab === 'transfer' && effectiveToCurrency !== senderCurrency;
}

function shouldBlockStaleFxConfirm({ activeTab, isCrossCurrency, ratesStale }) {
  return activeTab === 'transfer' && isCrossCurrency && !!ratesStale;
}

module.exports = function runWithdrawalStaleFxTests(check) {
  check(
    '[Withdraw] same-currency withdrawal ignores leftover receiverCurrency',
    !computeIsCrossCurrency({
      activeTab: 'withdraw',
      senderCurrency: 'XAF',
      receiverCurrency: 'USD',
    }),
  );

  check(
    '[Withdraw] stale FX quote does not block same-currency withdrawal confirm',
    !shouldBlockStaleFxConfirm({
      activeTab: 'withdraw',
      isCrossCurrency: computeIsCrossCurrency({
        activeTab: 'withdraw',
        senderCurrency: 'XAF',
        receiverCurrency: 'USD',
      }),
      ratesStale: true,
    }),
  );

  check(
    '[Transfer] cross-currency transfer still blocks on stale FX quote',
    shouldBlockStaleFxConfirm({
      activeTab: 'transfer',
      isCrossCurrency: computeIsCrossCurrency({
        activeTab: 'transfer',
        senderCurrency: 'XAF',
        receiverCurrency: 'USD',
      }),
      ratesStale: true,
    }),
  );

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'screens', 'SendScreen.tsx'),
    'utf8',
  );
  check(
    '[Withdraw] SendScreen FX fetch scoped to transfer tab',
    /if \(activeTab !== 'transfer'\) return;/.test(source),
  );
  check(
    '[Withdraw] SendScreen isCrossCurrency scoped to transfer tab',
    /const isCrossCurrency = activeTab === 'transfer' && effectiveToCurrency !== currency;/.test(source),
  );
};
