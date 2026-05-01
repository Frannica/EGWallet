"""
Fix remaining misplaced ES deposit keys - simplified (no emoji in prints).
"""
import re, sys, os

# Fix Windows terminal encoding
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    lines_list = f.read().split('\n')

def find_start(all_lines, lang):
    for i, l in enumerate(all_lines):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1

en_s = find_start(lines_list, 'en')
fr_s = find_start(lines_list, 'fr')
es_s = find_start(lines_list, 'es')
pt_s = find_start(lines_list, 'pt')
ar_s = find_start(lines_list, 'ar')

# Get all EN deposit keys
en_keys = {}
for i in range(en_s, fr_s):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?\s*$", lines_list[i])
    if m:
        en_keys[m.group(1)] = m.group(2)

# Get all ES deposit keys
es_keys = {}
for i in range(es_s, pt_s):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?\s*$", lines_list[i])
    if m:
        es_keys[m.group(1)] = m.group(2)

missing_from_es = sorted(set(en_keys.keys()) - set(es_keys.keys()))
print(f"Missing from ES: {len(missing_from_es)}")

# Get all PT deposit entries
pt_entries = {}
for i in range(pt_s, ar_s):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?\s*$", lines_list[i])
    if m:
        k, v = m.group(1), m.group(2)
        if k not in pt_entries:
            pt_entries[k] = []
        pt_entries[k].append((i, v))

es_to_add = {}
lines_to_remove = set()

PT_PATTERN = re.compile(r'ao|cao|oes|voce|ê|ô|â|ç', re.IGNORECASE)

for key in missing_from_es:
    if key not in pt_entries:
        print(f"  NOT IN PT: {key}")
        continue
    entries = pt_entries[key]
    if len(entries) == 2:
        (i1, v1), (i2, v2) = entries
        is_pt1 = bool(PT_PATTERN.search(v1))
        is_pt2 = bool(PT_PATTERN.search(v2))
        if is_pt1 and not is_pt2:
            es_to_add[key] = v2
            lines_to_remove.add(i2)
        elif is_pt2 and not is_pt1:
            es_to_add[key] = v1
            lines_to_remove.add(i1)
        else:
            # Both ambiguous - second entry is usually the ES one (added by fix_es script)
            es_to_add[key] = v2
            lines_to_remove.add(i2)
    elif len(entries) == 1:
        idx, val = entries[0]
        is_pt = bool(PT_PATTERN.search(val))
        if not is_pt:
            es_to_add[key] = val
            lines_to_remove.add(idx)

print(f"Found {len(es_to_add)} ES keys to rescue from PT")

# Find ES insertion point (before wallet.serverError)
es_insert_idx = None
for i in range(es_s, pt_s):
    if "'wallet.serverError'" in lines_list[i]:
        es_insert_idx = i
        break

print(f"ES insert point: line {es_insert_idx}")

# Build new content
insert_block = [f"  '{k}': '{v}'," for k, v in sorted(es_to_add.items())]
new_lines = []
for i, line in enumerate(lines_list):
    if i in lines_to_remove:
        continue
    if i == es_insert_idx:
        new_lines.extend(insert_block)
    new_lines.append(line)

with open('src/i18n/translations.ts', 'w', encoding='utf-8') as f:
    f.write('\n'.join(new_lines))

print(f"Done. Added {len(insert_block)} keys to ES, removed {len(lines_to_remove)} from PT.")

# Verify
with open('src/i18n/translations.ts', encoding='utf-8') as f:
    fl = f.read().split('\n')
def find2(lang):
    for i,l in enumerate(fl):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1
def count_dep(s, e):
    return sum(1 for l in fl[s:e] if re.match(r"\s*'deposit\.", l))
en2=find2('en'); fr2=find2('fr'); es2=find2('es'); pt2=find2('pt'); ar2=find2('ar')
print(f"EN={count_dep(en2,fr2)} FR={count_dep(fr2,es2)} ES={count_dep(es2,pt2)} PT={count_dep(pt2,ar2)}")
