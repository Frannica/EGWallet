"""
Second pass: fix remaining misplaced ES deposit keys.
Uses looser matching since the strict indicator list missed some.
"""
import re

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    content = f.read()

lines_list = content.split('\n')

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

print(f"Sections: en={en_s} fr={fr_s} es={es_s} pt={pt_s} ar={ar_s}")

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
print(f"Still missing from ES: {len(missing_from_es)}")
for k in missing_from_es:
    print(f"  {k}")

# For each missing key, look in PT section for ANY entry with that key
# In PT, if there are 2 entries, one is Portuguese and one is Spanish
# We pick the Spanish one by comparing to Portuguese patterns
pt_entries = {}  # key -> list of (line_idx, value)
for i in range(pt_s, ar_s):
    m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?\s*$", lines_list[i])
    if m:
        k, v = m.group(1), m.group(2)
        if k not in pt_entries:
            pt_entries[k] = []
        pt_entries[k].append((i, v))

print(f"\nPT entries for missing ES keys:")
es_to_add = {}
lines_to_remove_from_pt = set()

for key in missing_from_es:
    if key in pt_entries:
        entries = pt_entries[key]
        print(f"\n  '{key}':")
        for idx, val in entries:
            print(f"    line {idx}: '{val}'")
        
        if len(entries) == 2:
            # One is Portuguese, one is Spanish - identify by Portuguese markers
            (i1, v1), (i2, v2) = entries
            is_pt1 = bool(re.search(r'ão|ção|ões|você|ê|ô|â|ú[^s]|ç', v1))
            is_pt2 = bool(re.search(r'ão|ção|ões|você|ê|ô|â|ú[^s]|ç', v2))
            
            if is_pt1 and not is_pt2:
                # v2 is Spanish (not Portuguese-looking)
                es_to_add[key] = v2
                lines_to_remove_from_pt.add(i2)
                print(f"    -> Use v2 as ES: '{v2}'")
            elif is_pt2 and not is_pt1:
                # v1 is Spanish
                es_to_add[key] = v1
                lines_to_remove_from_pt.add(i1)
                print(f"    -> Use v1 as ES: '{v1}'")
            else:
                # Ambiguous - use the second one (likely the fix_es.py added one)
                es_to_add[key] = v2
                lines_to_remove_from_pt.add(i2)
                print(f"    -> Ambiguous, using v2: '{v2}'")
        elif len(entries) == 1:
            # Single entry - check if it's Spanish or Portuguese
            idx, val = entries[0]
            is_pt = bool(re.search(r'ão|ção|ões|você|ê|ô|â|ç', val))
            if not is_pt:
                # Likely Spanish - use it for ES and check if we need to add PT translation
                es_to_add[key] = val
                lines_to_remove_from_pt.add(idx)
                print(f"    -> Single entry, using as ES: '{val}'")
            else:
                print(f"    -> Single Portuguese entry, no Spanish found - will need manual translation")
    else:
        print(f"\n  '{key}': NOT IN PT EITHER - need to add Spanish translation")

print(f"\nES keys to add: {len(es_to_add)}")
print(f"PT lines to remove: {len(lines_to_remove_from_pt)}")

if not es_to_add:
    print("Nothing to do.")
    exit(0)

# Find insertion point: just before wallet.serverError in ES
es_insert_idx = None
for i in range(es_s, pt_s):
    if "'wallet.serverError'" in lines_list[i]:
        es_insert_idx = i
        break

print(f"ES insertion point (before wallet.serverError): line {es_insert_idx}")

# Build new content
insert_block = [f"  '{k}': '{v}'," for k, v in sorted(es_to_add.items())]
new_lines = []
for i, line in enumerate(lines_list):
    if i in lines_to_remove_from_pt:
        continue  # skip this line
    if i == es_insert_idx:
        new_lines.extend(insert_block)
    new_lines.append(line)

with open('src/i18n/translations.ts', 'w', encoding='utf-8') as f:
    f.write('\n'.join(new_lines))

print(f"Done! Added {len(insert_block)} keys to ES.")

# Final verification
with open('src/i18n/translations.ts', encoding='utf-8') as f:
    fc = f.read()
fl = fc.split('\n')
es2 = find_start(fl, 'es')
pt2 = find_start(fl, 'pt')
ar2 = find_start(fl, 'ar')
en2 = find_start(fl, 'en')
fr2 = find_start(fl, 'fr')

def count_dep(all_lines, s, e):
    return sum(1 for l in all_lines[s:e] if re.match(r"\s*'deposit\.", l))

print(f"\nFinal counts:")
print(f"EN: {count_dep(fl, en2, fr2)} deposit keys")
print(f"ES: {count_dep(fl, es2, pt2)} deposit keys")
print(f"PT: {count_dep(fl, pt2, ar2)} deposit keys")
