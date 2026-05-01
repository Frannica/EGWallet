const fs = require('fs');
const lines = fs.readFileSync('src/i18n/translations.ts','utf8').split('\n');
const anchors = [
  "common.done",
  "deposit.tooSmall",
  "employer.payrollComplete",
  "payRequest.couldNotProcess",
  "qr.cancel",
  "request.cancelRequestTitle",
  "send.backendUnavailable",
  "settings.biometricEnabled'"
];
anchors.forEach(key => {
  const hits = [];
  lines.forEach((l,i) => { if (l.includes(key)) hits.push((i+1)+': '+l.trim()) });
  console.log('-- '+key+' --');
  hits.forEach(h => console.log(h));
});
