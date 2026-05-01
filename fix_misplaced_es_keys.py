"""
Fix misplaced Spanish deposit keys in translations.ts:
- ES section is missing ~39 deposit keys
- PT section has those Spanish translations mixed in as duplicates
- This script: removes Spanish keys from PT, inserts them into ES
"""
import re

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    content = f.read()

# Find section boundaries (line indices, 0-based)
lines = content.split('\n')
def find_section_start(lang_const):
    for i, line in enumerate(lines):
        if line.strip() == f'const {lang_const}: TranslationMap = {{':
            return i
    return -1

en_start = find_section_start('en')  # Should be near 0 or wherever
fr_start = find_section_start('fr')
es_start = find_section_start('es')
pt_start = find_section_start('pt')
ar_start = find_section_start('ar')

print(f"Section starts: en={en_start}, fr={fr_start}, es={es_start}, pt={pt_start}, ar={ar_start}")

# Extract all deposit keys from EN section
en_deposit_keys = {}
for i in range(en_start, fr_start):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?$", lines[i])
    if m:
        en_deposit_keys[m.group(1)] = m.group(2)

print(f"EN deposit keys: {len(en_deposit_keys)}")

# Extract all deposit keys from ES section
es_deposit_keys = {}
for i in range(es_start, pt_start):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?$", lines[i])
    if m:
        es_deposit_keys[m.group(1)] = m.group(2)

print(f"ES deposit keys currently: {len(es_deposit_keys)}")

# Find deposit keys present in PT section - check which are Spanish (should be in ES)
pt_deposit_keys_all = {}
pt_deposit_key_lines = {}  # key -> line index in the overall file
for i in range(pt_start, ar_start):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?$", lines[i])
    if m:
        key = m.group(1)
        val = m.group(2)
        if key in pt_deposit_keys_all:
            # Duplicate - check which is Spanish vs Portuguese
            pt_deposit_keys_all[key].append((i, val))
        else:
            pt_deposit_keys_all[key] = [(i, val)]
        if key not in pt_deposit_key_lines:
            pt_deposit_key_lines[key] = []
        pt_deposit_key_lines[key].append(i)

# Find keys that appear twice in PT (first likely Portuguese, second likely Spanish or vice versa)
duplicates_in_pt = {k: v for k, v in pt_deposit_keys_all.items() if len(v) > 1}
print(f"\nDuplicate deposit keys in PT: {len(duplicates_in_pt)}")

# Keys missing from ES
missing_from_es = set(en_deposit_keys.keys()) - set(es_deposit_keys.keys())
print(f"Keys missing from ES: {len(missing_from_es)}")
print("Missing keys:", sorted(missing_from_es)[:5], "...")

# Find Spanish translations: look in PT for duplicate entries where one value matches Spanish patterns
# Strategy: for missing ES keys, find them in PT duplicates
# The "Spanish" entry in PT is likely the one that contains Spanish words
spanish_indicators = ['Agregar', 'Ingresa', 'Selecciona', 'Cancelar', 'Confirmar', 'Método',
                      'moneda', 'monto', 'cuenta', 'tarjeta', 'toca', 'gratuito', 'ruta',
                      'Nombre', 'Número', 'Fecha', 'guardados', 'Nuevo', 'bancaria',
                      'Débito', 'Crédito', 'titular', 'completo', 'completar']

# For each duplicate in PT, identify which entry is Spanish
es_keys_to_add = {}  # key -> (spanish_value, line_index_to_remove)
lines_to_remove = set()  # line indices in PT to remove (the Spanish duplicates)

for key, entries in duplicates_in_pt.items():
    for (idx, val) in entries:
        is_spanish = any(ind in val for ind in spanish_indicators)
        if is_spanish and key in missing_from_es:
            es_keys_to_add[key] = val
            lines_to_remove.add(idx)
            print(f"  Found misplaced ES key at line {idx}: '{key}': '{val[:50]}'")

# Also check non-duplicate PT entries that might be Spanish (for missing ES keys)
for key in missing_from_es:
    if key not in es_keys_to_add and key in pt_deposit_keys_all:
        entries = pt_deposit_keys_all[key]
        for (idx, val) in entries:
            is_spanish = any(ind in val for ind in spanish_indicators)
            # Also check: Portuguese tends to use ã, ç, ô, â vs Spanish uses ñ, ó, á
            is_portuguese = 'ão' in val or 'ção' in val or 'ões' in val or 'você' in val.lower()
            if is_spanish and not is_portuguese:
                es_keys_to_add[key] = val
                lines_to_remove.add(idx)
                print(f"  Found solo misplaced ES key at line {idx}: '{key}': '{val[:50]}'")

print(f"\nES keys to add from PT: {len(es_keys_to_add)}")
print(f"PT lines to remove: {len(lines_to_remove)}")

# Find where to insert in ES section: just before 'wallet.serverError' in ES
es_wallet_error_idx = None
for i in range(es_start, pt_start):
    if "'wallet.serverError'" in lines[i]:
        es_wallet_error_idx = i
        break

print(f"ES wallet.serverError line index: {es_wallet_error_idx}")

# Build the lines to insert before wallet.serverError in ES
insert_lines = []
for key in sorted(es_keys_to_add.keys()):
    val = es_keys_to_add[key]
    insert_lines.append(f"  '{key}': '{val}',")

# Rebuild content: remove PT Spanish duplicates and insert into ES
new_lines = []
for i, line in enumerate(lines):
    if i in lines_to_remove:
        # Skip this line (Spanish duplicate in PT section)
        continue
    if i == es_wallet_error_idx:
        # Insert the rescued Spanish keys before wallet.serverError
        for il in insert_lines:
            new_lines.append(il)
    new_lines.append(line)

new_content = '\n'.join(new_lines)

# Write back
with open('src/i18n/translations.ts', 'w', encoding='utf-8') as f:
    f.write(new_content)
print(f"\nDone. Added {len(insert_lines)} keys to ES, removed {len(lines_to_remove)} lines from PT.")

# Verify
with open('src/i18n/translations.ts', encoding='utf-8') as f:
    verify = f.read()
verify_lines = verify.split('\n')

# Recount
def count_deposit_in_range(all_lines, start, end):
    return sum(1 for l in all_lines[start:end] if re.match(r"\s*'deposit\.", l))

# Re-find section starts after modification
def find_start(all_lines, lang):
    for i, l in enumerate(all_lines):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1

vl = verify.split('\n')
v_es = find_start(vl, 'es')
v_pt = find_start(vl, 'pt')
v_ar = find_start(vl, 'ar')
v_en = find_start(vl, 'en')
v_fr = find_start(vl, 'fr')
print(f"\nAfter fix:")
print(f"EN deposit keys: {count_deposit_in_range(vl, v_en, v_fr)}")
print(f"ES deposit keys: {count_deposit_in_range(vl, v_es, v_pt)}")
print(f"PT deposit keys: {count_deposit_in_range(vl, v_pt, v_ar)}")
