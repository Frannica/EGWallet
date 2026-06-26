'use strict';

function printHumanReport(report) {
  if (report.passed) {
    console.log('[db:parity] PASS');
    console.log(`[db:parity] checks run: ${report.checkCount}`);
    return;
  }

  console.error('[db:parity] FAIL');
  console.error(`[db:parity] mismatches: ${report.mismatches.length}`);
  for (const mismatch of report.mismatches) {
    console.error(
      `[db:parity] ${mismatch.check} key=${mismatch.key} expected=${JSON.stringify(mismatch.expected)} actual=${JSON.stringify(mismatch.actual)}`
    );
  }
}

module.exports = {
  printHumanReport,
};
