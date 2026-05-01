import re, glob

# Look for {expr || 'string'} or {expr || "string"} in JSX context
# which can render a string directly in a non-Text component

files = glob.glob('src/**/*.tsx', recursive=True)

for fpath in files:
    with open(fpath, encoding='utf-8') as f:
        lines = f.readlines()
    
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # Look for {expr || 'string'} or {expr || "string"} in JSX
        # Skip JSX attribute context (has = before {)
        # Skip function calls and variable declarations
        if re.search(r'\|\|\s*[\'"][^\'\"]+[\'"]', stripped):
            # Check if it looks like JSX expression
            if '{' in stripped and (stripped.startswith('{') or stripped.startswith('<') or re.search(r'>\s*\{', stripped)):
                print(f'{fpath}:{i}: {stripped[:120]}')
