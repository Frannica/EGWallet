import re, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    lines_list = f.read().split('\n')

def find_start(all_lines, lang):
    for i, l in enumerate(all_lines):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1

en_s=find_start(lines_list,'en'); fr_s=find_start(lines_list,'fr')
es_s=find_start(lines_list,'es'); pt_s=find_start(lines_list,'pt')
ar_s=find_start(lines_list,'ar')

def get_keys(s, e):
    d={}
    for i in range(s, e):
        m = re.match(r"\s*'(deposit\.[^']+)':\s*'(.+)',?\s*$", lines_list[i])
        if m: d[m.group(1)] = m.group(2)
    return d

en_k=get_keys(en_s,fr_s)
es_k=get_keys(es_s,pt_s)
pt_k=get_keys(pt_s,ar_s)

missing_es = sorted(set(en_k)-set(es_k))
missing_pt = sorted(set(en_k)-set(pt_k))
print(f"EN={len(en_k)} ES={len(es_k)} PT={len(pt_k)}")
print(f"Missing from ES: {missing_es}")
print(f"Missing from PT: {missing_pt}")
