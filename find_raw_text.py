import re, glob

files = glob.glob('src/**/*.tsx', recursive=True) + glob.glob('src/**/*.jsx', recursive=True)

results = []

for fpath in files:
    with open(fpath, encoding='utf-8') as f:
        content = f.read()
        lines = content.split('\n')
    
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        
        # Pattern 1: Raw text content after JSX closing tag >
        # E.g.: >  Some Text  < (between > and <)
        # This would be a literal text node in JSX
        raw_text = re.findall(r'>([^{<>\n]+)<', stripped)
        for rt in raw_text:
            rt = rt.strip()
            if rt and not rt.startswith('//') and not re.match(r'^[\s/=*\-|.,;:(){}]+$', rt):
                # Skip if it's inside a Text tag (check surrounding context)
                # Count Text occurrences in context
                results.append((fpath, i, 'RAW_TEXT', rt[:60], stripped[:100]))
        
        # Pattern 2: String literal in JSX expression that's clearly a text node
        # E.g.: {'Some string'} NOT inside a Text tag

# Print results grouped by file
print(f'=== Files with potential raw text in JSX ===\n')
seen_files = {}
for fpath, lineno, kind, match, ctx in results:
    if fpath not in seen_files:
        seen_files[fpath] = []
    seen_files[fpath].append((lineno, kind, match, ctx))

for fpath, items in seen_files.items():
    print(f'\n--- {fpath} ---')
    for lineno, kind, match, ctx in items[:15]:
        print(f'  L{lineno} [{kind}]: "{match}" in: {ctx}')
