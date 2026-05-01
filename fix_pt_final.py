"""
Final fix: add back deposit.confirmDeposit and deposit.fullName to PT section.
Also handles double-quoted values in verification.
"""
import re, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    lines_list = f.read().split('\n')

def find_start(all_lines, lang):
    for i, l in enumerate(all_lines):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1

pt_s = find_start(lines_list, 'pt')
ar_s = find_start(lines_list, 'ar')

# Find wallet.serverError in PT as insertion point
pt_insert = None
for i in range(pt_s, ar_s):
    if "'wallet.serverError'" in lines_list[i]:
        pt_insert = i
        break

print(f"PT insert point (before wallet.serverError): line {pt_insert}")

# The two missing PT keys (Portuguese translations)
to_add = [
    "  'deposit.confirmDeposit': 'Confirmar e depositar',",
    "  'deposit.fullName': 'Nome completo',",
]

new_lines = []
for i, line in enumerate(lines_list):
    if i == pt_insert:
        new_lines.extend(to_add)
    new_lines.append(line)

with open('src/i18n/translations.ts', 'w', encoding='utf-8') as f:
    f.write('\n'.join(new_lines))

print(f"Added {len(to_add)} keys to PT.")

# Final comprehensive verification - handles both single and double quoted values
with open('src/i18n/translations.ts', encoding='utf-8') as f:
    fl = f.read().split('\n')

lang_order = ['en','fr','es','pt','ar','zh','ja']
boundaries = {}
for lang in lang_order:
    boundaries[lang] = find_start(fl, lang)
boundaries['_end'] = len(fl)

# Match both 'value' and "value"
KEY_RE = re.compile(r"""\s*'(deposit\.[^']+)':\s*(?:'[^']*'|"[^"]*"),?\s*$""")

def count_keys(s, e):
    d = {}
    for i in range(s, e):
        m = KEY_RE.match(fl[i])
        if m:
            d[m.group(1)] = fl[i]
    return d

print("\nFinal deposit key counts:")
lang_keys = {}
for idx, lang in enumerate(lang_order):
    next_lang = lang_order[idx+1] if idx+1 < len(lang_order) else '_end'
    s = boundaries[lang]
    e = boundaries[next_lang] if next_lang != '_end' else boundaries['_end']
    lang_keys[lang] = count_keys(s, e)
    print(f"  {lang.upper()}: {len(lang_keys[lang])}")

en_keys = set(lang_keys['en'].keys())
print(f"\nEN has {len(en_keys)} deposit keys")
all_ok = True
for lang in lang_order[1:]:
    missing = sorted(en_keys - set(lang_keys[lang].keys()))
    if missing:
        print(f"  {lang.upper()} missing {len(missing)}: {missing}")
        all_ok = False
    else:
        print(f"  {lang.upper()}: complete")

if all_ok:
    print("\nAll languages have complete deposit key coverage!")
