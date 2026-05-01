import re, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    lines = f.read().split('\n')

def find_start(lang):
    for i, l in enumerate(lines):
        if l.strip() == f'const {lang}: TranslationMap = {{':
            return i
    return -1

# Check every non-EN language section for lines with unescaped apostrophes in values
lang_order = ['en','fr','es','pt','ar','zh','ja']
bounds = {lang: find_start(lang) for lang in lang_order}
bounds['_end'] = len(lines)

issues = []
for idx, lang in enumerate(lang_order[1:], 1):  # skip EN
    start = bounds[lang]
    end = bounds[lang_order[idx+1]] if idx+1 < len(lang_order) else bounds['_end']
    for i in range(start, end):
        line = lines[i]
        # Match key: 'some.key': '...'
        # Find the value portion after the first ': '
        m = re.match(r"  '([^']+)':\s*(.+)$", line)
        if not m:
            continue
        rest = m.group(2).strip()
        # rest should start and end with quote
        if not rest.startswith("'"):
            continue
        # Remove the opening quote, then find unescaped quotes in value
        inner = rest[1:]  # everything after opening quote
        # Count unescaped single quotes - should be exactly 1 (the closing one)
        count = len(re.findall(r"(?<!\\)'", inner))
        if count > 1:
            issues.append((lang, i+1, line[:120]))

if issues:
    for lang, lineno, l in issues:
        print(f'[{lang}] L{lineno}: {l}')
else:
    print('No unescaped apostrophe issues found!')

print(f'\nTotal: {len(issues)}')
