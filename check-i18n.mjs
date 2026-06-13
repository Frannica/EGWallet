#!/usr/bin/env node
/**
 * Translation completeness guard.
 * Run with: node check-i18n.mjs
 *
 * Checks that every key present in the English section exists in ALL other languages.
 * Validates UTF-8 integrity (no replacement characters).
 * Exits with code 1 if any keys are missing (suitable for CI pre-build hooks).
 */

import { readFileSync } from 'fs';

const FILE = 'src/i18n/translations.ts';
const LANGUAGES = ['en', 'fr', 'es', 'pt', 'ar', 'zh', 'ja'];

const content = readFileSync(FILE, 'utf-8');
const lines = content.split('\n');

// UTF-8 integrity: reject replacement chars and common mojibake from bad encoding
if (content.includes('\uFFFD')) {
  console.error(`ERROR: ${FILE} contains Unicode replacement characters (U+FFFD). Fix encoding before building.`);
  process.exit(1);
}
const mojibakePatterns = [
  /\u00C3[\u0080-\u00BF]/, // UTF-8 read as Latin-1
  /\u00E2\u0080[\u0094-\u0099]/, // em/en dash mojibake
];
for (const re of mojibakePatterns) {
  if (re.test(content)) {
    console.error(`ERROR: ${FILE} contains suspected UTF-8 mojibake. Normalize encoding before building.`);
    process.exit(1);
  }
}

/**
 * Find the start line index of `const <lang>: TranslationMap = {`
 */
function findSection(lang) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `const ${lang}: TranslationMap = {`) return i;
  }
  return -1;
}

/**
 * Extract all translation keys from a language section.
 * Handles single-quoted and double-quoted keys.
 */
function extractKeys(start, end) {
  const keys = new Set();
  const KEY_RE = /^\s*['"]([^'"]+)['"]\s*:/;
  for (let i = start; i < end; i++) {
    const m = lines[i].match(KEY_RE);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Build section boundaries
const sections = {};
for (const lang of LANGUAGES) {
  sections[lang] = findSection(lang);
  if (sections[lang] === -1) {
    console.error(`ERROR: Could not find section for language '${lang}' in ${FILE}`);
    process.exit(1);
  }
}
sections['_end'] = lines.length;

function getSectionEnd(lang) {
  const idx = LANGUAGES.indexOf(lang);
  const nextLang = idx + 1 < LANGUAGES.length ? LANGUAGES[idx + 1] : '_end';
  return sections[nextLang];
}

// Extract all keys per language
const langKeys = {};
for (const lang of LANGUAGES) {
  langKeys[lang] = extractKeys(sections[lang], getSectionEnd(lang));
}

const enKeys = langKeys['en'];
console.log(`EN has ${enKeys.size} keys\n`);

let failed = false;
for (const lang of LANGUAGES.slice(1)) {
  const keys = langKeys[lang];
  const missing = [...enKeys].filter(k => !keys.has(k)).sort();
  const extra = [...keys].filter(k => !enKeys.has(k)).sort();

  if (missing.length === 0 && extra.length === 0) {
    console.log(`${lang.toUpperCase()}: OK (${keys.size} keys)`);
  } else {
    failed = true;
    if (missing.length > 0) {
      console.error(`${lang.toUpperCase()}: MISSING ${missing.length} keys:`);
      for (const k of missing) console.error(`  - ${k}`);
    }
    if (extra.length > 0) {
      console.warn(`${lang.toUpperCase()}: EXTRA ${extra.length} keys (not in EN):`);
      for (const k of extra) console.warn(`  + ${k}`);
    }
  }
}

console.log('');
if (failed) {
  console.error('Translation check FAILED. Fix missing keys before building.');
  process.exit(1);
} else {
  console.log('All translation keys are complete across all languages.');
  process.exit(0);
}
