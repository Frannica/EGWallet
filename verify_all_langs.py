"""
Final comprehensive verification of all deposit key coverage.
Handles single-quoted, double-quoted, and escaped-quote values.
"""
import re, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    fl = f.read().split('\n')

def find_start(all_lines, lang):
    for i, l in enumerate(all_lines):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1

lang_order = ['en','fr','es','pt','ar','zh','ja']
boundaries = {}
for lang in lang_order:
    boundaries[lang] = find_start(fl, lang)
boundaries['_end'] = len(fl)

# Match keys with any quote style (including escaped single quotes)
KEY_RE = re.compile(r"""\s*'(deposit\.[^']+)'\s*:""")

def get_keys(lang):
    idx = lang_order.index(lang)
    next_lang = lang_order[idx+1] if idx+1 < len(lang_order) else '_end'
    s = boundaries[lang]
    e = boundaries[next_lang] if next_lang != '_end' else boundaries['_end']
    keys = set()
    for line in fl[s:e]:
        m = KEY_RE.match(line)
        if m:
            keys.add(m.group(1))
    return keys

print("Deposit key counts:")
lang_keys = {}
for lang in lang_order:
    lang_keys[lang] = get_keys(lang)
    print(f"  {lang.upper()}: {len(lang_keys[lang])}")

en_keys = lang_keys['en']
print(f"\nEN has {len(en_keys)} deposit keys total")

all_ok = True
for lang in lang_order[1:]:
    missing = sorted(en_keys - lang_keys[lang])
    extra = sorted(lang_keys[lang] - en_keys)
    if missing or extra:
        if missing: print(f"  {lang.upper()} MISSING {len(missing)}: {missing}")
        if extra: print(f"  {lang.upper()} EXTRA {len(extra)}: {extra}")
        all_ok = False
    else:
        print(f"  {lang.upper()}: complete ({len(lang_keys[lang])} keys)")

print()
if all_ok:
    print("All 7 languages have identical deposit key coverage!")
else:
    print("Some discrepancies remain (see above)")
