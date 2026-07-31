'use strict';
/**
 * Renders legal/*.md into admin-dashboard/public HTML pages for Netlify + Railway.
 * Usage: node scripts/render-legal-html.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEGAL = path.join(ROOT, 'legal');
const OUT_DIR = path.join(ROOT, 'backend', 'admin-dashboard', 'public');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineFormat(text) {
  let t = escapeHtml(text);
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  return t;
}

function mdToBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim() === '---') {
      i += 1;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({ type: 'h1', text: line.slice(2).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', text: line.slice(3).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', text: line.slice(4).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith('|') && lines[i + 1] && /^\|[\s|:-]+$/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (line.trim().startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    const paras = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      lines[i].trim() !== '---' &&
      !lines[i].startsWith('#') &&
      !lines[i].trim().startsWith('- ') &&
      !lines[i].startsWith('|')
    ) {
      paras.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'p', text: paras.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return blocks;
}

function blocksToHtml(blocks) {
  const out = [];
  let cardOpen = false;
  const closeCard = () => {
    if (cardOpen) {
      out.push('      </div>');
      cardOpen = false;
    }
  };
  for (const b of blocks) {
    if (b.type === 'h1') {
      closeCard();
      out.push(`      <h1>${inlineFormat(b.text)}</h1>`);
      continue;
    }
    if (b.type === 'h2') {
      closeCard();
      out.push('      <div class="card">');
      out.push(`        <h2>${inlineFormat(b.text)}</h2>`);
      cardOpen = true;
      continue;
    }
    if (b.type === 'h3') {
      if (!cardOpen) {
        out.push('      <div class="card">');
        cardOpen = true;
      }
      out.push(`        <h3>${inlineFormat(b.text)}</h3>`);
      continue;
    }
    if (!cardOpen) {
      out.push('      <div class="card">');
      cardOpen = true;
    }
    if (b.type === 'p') {
      const cls = /NOT a bank|not currently supported|unavailable/i.test(b.text)
        ? ' class="disclaimer"'
        : '';
      out.push(`        <p${cls}>${inlineFormat(b.text)}</p>`);
    } else if (b.type === 'ul') {
      out.push('        <ul>');
      for (const item of b.items) {
        out.push(`          <li>${inlineFormat(item)}</li>`);
      }
      out.push('        </ul>');
    } else if (b.type === 'table') {
      out.push('        <div class="table-wrap"><table>');
      out.push('          <thead><tr>');
      for (const h of b.header) out.push(`            <th>${inlineFormat(h)}</th>`);
      out.push('          </tr></thead><tbody>');
      for (const row of b.rows) {
        out.push('          <tr>');
        for (const c of row) out.push(`            <td>${inlineFormat(c)}</td>`);
        out.push('          </tr>');
      }
      out.push('          </tbody></table></div>');
    }
  }
  closeCard();
  return out.join('\n');
}

function wrapPage({ title, updatedLine, bodyHtml, backHref }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} — EGWallet</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        background: #f5f6fa;
        color: #1a1a2e;
        min-height: 100vh;
      }
      header {
        background: #1a1a2e;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 24px;
        height: 52px;
      }
      header a { color: #fff; text-decoration: none; font-size: 16px; font-weight: 600; }
      header a.back { font-size: 13px; font-weight: 400; opacity: 0.75; }
      header a.back:hover { opacity: 1; }
      main { max-width: 760px; margin: 40px auto; padding: 0 24px 60px; }
      h1 { font-size: 26px; font-weight: 700; margin-bottom: 6px; }
      .updated { font-size: 12px; color: #888; margin-bottom: 32px; }
      .card {
        background: #fff;
        border: 1px solid #e4e7ec;
        border-radius: 10px;
        padding: 28px 32px;
        margin-bottom: 16px;
      }
      h2 { font-size: 15px; font-weight: 700; margin-bottom: 10px; color: #1a1a2e; }
      h3 { font-size: 14px; font-weight: 600; margin-top: 16px; margin-bottom: 8px; color: #1a1a2e; }
      p { line-height: 1.7; color: #444; margin-bottom: 12px; }
      ul { padding-left: 20px; margin-bottom: 12px; color: #444; line-height: 1.7; }
      li { margin-bottom: 6px; }
      p:last-child, ul:last-child { margin-bottom: 0; }
      .disclaimer {
        background: #fff8e1;
        border-left: 4px solid #f59e0b;
        padding: 12px 16px;
        border-radius: 4px;
        margin-bottom: 12px;
        font-weight: 600;
        color: #92400e;
      }
      .table-wrap { overflow-x: auto; margin: 12px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border: 1px solid #e4e7ec; padding: 8px 10px; text-align: left; vertical-align: top; }
      th { background: #f8fafc; font-weight: 600; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      footer { text-align: center; padding: 24px; font-size: 12px; color: #999; }
    </style>
  </head>
  <body>
    <header>
      <a href="${escapeHtml(backHref)}">EGWallet</a>
      <a href="${escapeHtml(backHref)}" class="back">← Back</a>
    </header>
    <main>
${bodyHtml}
      <p class="updated">${escapeHtml(updatedLine)}</p>
    </main>
    <footer>© 2026 EGWallet. All rights reserved.</footer>
  </body>
</html>
`;
}

function extractUpdated(md) {
  const m = md.match(/\*\*Last Updated:\*\*\s*(.+)/i);
  const e = md.match(/\*\*Effective Date:\*\*\s*(.+)/i);
  const last = m ? m[1].trim() : 'July 31, 2026';
  const eff = e ? e[1].trim() : 'July 23, 2026';
  return `Last updated: ${last} | Effective Date: ${eff}`;
}

function renderOne(mdName, outRel, title) {
  const mdPath = path.join(LEGAL, mdName);
  const md = fs.readFileSync(mdPath, 'utf8');
  // Drop leading H1 from body; page title already set
  const blocks = mdToBlocks(md).filter((b) => b.type !== 'h1');
  // Prepend title h1 for page
  const body = `      <h1>${escapeHtml(title)}</h1>\n      <p class="updated">${escapeHtml(extractUpdated(md))}</p>\n`
    + blocksToHtml(blocks);
  // Remove duplicate updated at end from wrap — customize wrap
  const html = wrapPage({
    title,
    updatedLine: 'Canonical source: legal/' + mdName,
    bodyHtml: body.replace(/\n {6}<p class="updated">[\s\S]*?<\/p>\n/, '\n'),
    backHref: 'https://www.egwalletfinance.com',
  });
  // Fix: wrapPage adds another updated — simplify by writing custom
  const finalHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="egwallet-legal-source" content="legal/${escapeHtml(mdName)}" />
    <meta name="egwallet-legal-updated" content="${escapeHtml(extractUpdated(md))}" />
    <title>${escapeHtml(title)} — EGWallet</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; background: #f5f6fa; color: #1a1a2e; min-height: 100vh; }
      header { background: #1a1a2e; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; height: 52px; }
      header a { color: #fff; text-decoration: none; font-size: 16px; font-weight: 600; }
      header a.back { font-size: 13px; font-weight: 400; opacity: 0.75; }
      main { max-width: 760px; margin: 40px auto; padding: 0 24px 60px; }
      h1 { font-size: 26px; font-weight: 700; margin-bottom: 6px; }
      .updated { font-size: 12px; color: #888; margin-bottom: 32px; }
      .card { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 28px 32px; margin-bottom: 16px; }
      h2 { font-size: 15px; font-weight: 700; margin-bottom: 10px; color: #1a1a2e; }
      h3 { font-size: 14px; font-weight: 600; margin-top: 16px; margin-bottom: 8px; color: #1a1a2e; }
      p { line-height: 1.7; color: #444; margin-bottom: 12px; }
      ul { padding-left: 20px; margin-bottom: 12px; color: #444; line-height: 1.7; }
      li { margin-bottom: 6px; }
      p:last-child, ul:last-child { margin-bottom: 0; }
      .disclaimer { background: #fff8e1; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; margin-bottom: 12px; font-weight: 600; color: #92400e; }
      .table-wrap { overflow-x: auto; margin: 12px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border: 1px solid #e4e7ec; padding: 8px 10px; text-align: left; vertical-align: top; }
      th { background: #f8fafc; font-weight: 600; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      footer { text-align: center; padding: 24px; font-size: 12px; color: #999; }
    </style>
  </head>
  <body>
    <header>
      <a href="https://www.egwalletfinance.com">EGWallet</a>
      <a href="https://www.egwalletfinance.com" class="back">← Back</a>
    </header>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p class="updated">${escapeHtml(extractUpdated(md))}</p>
${blocksToHtml(blocks)}
    </main>
    <footer>© 2026 EGWallet. All rights reserved. Source: legal/${escapeHtml(mdName)}</footer>
  </body>
</html>
`;
  const outPath = path.join(OUT_DIR, outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, finalHtml, 'utf8');
  console.log('Wrote', path.relative(ROOT, outPath), `(${finalHtml.length} bytes)`);
}

renderOne('TERMS_OF_SERVICE.md', path.join('terms', 'index.html'), 'Terms of Service');
renderOne('PRIVACY_POLICY.md', path.join('privacy-policy', 'index.html'), 'Privacy Policy');
console.log('OK');
