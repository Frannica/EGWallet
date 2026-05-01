import re, os

# Read translations.ts and find all defined keys in the 'en' section
with open('src/i18n/translations.ts', encoding='utf-8') as f:
    content = f.read()

# Find 'en' section - just extract all keys
en_keys = set()
lines = content.split('\n')
in_en = False
for line in lines:
    stripped = line.strip()
    if stripped == 'const en: TranslationMap = {':
        in_en = True
        continue
    if in_en and stripped == '};':
        in_en = False
        break
    if in_en:
        m = re.match(r"'([^']+)':", stripped)
        if m:
            en_keys.add(m.group(1))

print(f'Found {len(en_keys)} EN keys in translations')

# Find all t() calls in the 3 modified files
files_to_check = [
    ('DepositScreen.tsx', 'src/screens/DepositScreen.tsx'),
    ('SendScreen.tsx', 'src/screens/SendScreen.tsx'),
    ('SettingsScreen.tsx', 'src/screens/SettingsScreen.tsx'),
]

for fname, fpath in files_to_check:
    with open(fpath, encoding='utf-8') as f:
        fc = f.read()
    pattern = re.compile(r"t\('([^']+)'\)")
    used = pattern.findall(fc)
    missing = [k for k in used if k not in en_keys]
    if missing:
        print(f'\nMISSING KEYS in {fname}:')
        for k in missing:
            print(f'  - {k}')
    else:
        print(f'{fname}: all {len(used)} keys OK')
