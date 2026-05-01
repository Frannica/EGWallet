import re, glob

files = glob.glob('src/**/*.tsx', recursive=True) + glob.glob('src/**/*.jsx', recursive=True)

results = []

for fpath in files:
    with open(fpath, encoding='utf-8') as f:
        lines = f.readlines()
    
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # Look for JSX string literal expressions: {'...'} or {"..."} with non-empty content
        matches = re.findall(r"\{['\"]([^'\"{}]+)['\"]\}", stripped)
        if matches:
            for m in matches:
                m = m.strip()
                # Skip hex colors, rgba, 'hidden', 'none', CSS values, etc.
                skip = ['#', 'rgba', 'flex', 'row', 'column', 'center', 'absolute', 'relative',
                        'hidden', 'none', 'auto', 'bold', 'normal', 'italic', 'wrap', 'nowrap',
                        'solid', 'dotted', 'baseline', 'stretch', 'padding', 'margin']
                if any(m.lower().startswith(s) for s in skip):
                    continue
                if not m or len(m) < 2:
                    continue
                # Skip pure numbers
                if re.match(r'^[\d.,]+$', m):
                    continue
                results.append((fpath, i, m, stripped[:120]))

print(f'Total potentially bare JSX string literals: {len(results)}')
for fpath, lineno, match, ctx in results[:50]:
    print(f'{fpath}:{lineno} [{match}]: {ctx}')
