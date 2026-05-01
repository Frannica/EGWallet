"""
Find React Native 'Text strings must be rendered within a <Text> component' bugs.
Looks for string variables rendered directly in JSX outside of <Text> tags.
"""
import os, re

src_dir = 'src'
issues = []

# Patterns that cause this error in React Native:
# 1. {someStringVar} directly in a View (common with apiError, error, message, etc.)
# 2. {condition && 'some string'} in a View
# 3. bare {someVar} where someVar might be string

STRING_VAR_NAMES = [
    r'\bapiError\b', r'\berror\b', r'\berrorMsg\b', r'\bmessage\b',
    r'\bstatusMsg\b', r'\blabel\b', r'\btext\b', r'\bvalue\b',
    r'\bsubtitle\b', r'\bdescription\b', r'\bhint\b', r'\bwarning\b',
]

for root, dirs, files in os.walk(src_dir):
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
    for f in files:
        if not f.endswith(('.tsx', '.jsx')):
            continue
        path = os.path.join(root, f)
        with open(path, encoding='utf-8', errors='replace') as fh:
            content = fh.read()
        lines = content.split('\n')
        
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith('//') or stripped.startswith('*'):
                continue
            
            # Pattern: { varName } alone on a line in JSX (not inside a Text component)
            # but we can't know if it's inside Text without full parsing
            # So look for common string variable names in JSX expression slots
            for pat in STRING_VAR_NAMES:
                if re.search(r'\{' + pat.replace(r'\b', '') + r'\s*\}', stripped):
                    # Check it's not inside a Text tag on same line
                    if '<Text' not in stripped and '</Text>' not in stripped:
                        # Check it's not a prop assignment
                        if not re.search(r'[a-zA-Z]+=\{', stripped[:stripped.index('{')]):
                            issues.append((path, i, stripped[:120]))
                            break

            # Pattern: { someVar && 'string literal' }
            m = re.search(r'\{[^}]+&&\s*[\'"`][^\'"`]{2,}[\'"`]\s*\}', stripped)
            if m and '<Text' not in stripped:
                issues.append((path, i, f'[COND-STR] {stripped[:120]}'))

            # Pattern: bare string literal in JSX (between > and <)
            # e.g.  >some text<  but not inside a Text
            m2 = re.search(r'^\s*[A-Z][a-zA-Z\s]{5,}$', stripped)
            if m2 and not stripped.startswith(('import', 'const', 'let', 'var', 'type', 'interface', 'export', '//', '*', 'return', 'case')):
                pass  # Too noisy

print(f'Found {len(issues)} potential issues:\n')
seen = set()
for p, ln, txt in issues:
    key = (p, ln)
    if key not in seen:
        seen.add(key)
        print(f'  {p}:{ln}: {txt}')

if not issues:
    print('No obvious bare-string-in-JSX patterns found.')
    print()
    print('The bug might be in a component rendering a state variable.')
    print('Check: apiError, error, message rendered directly in View without wrapping in <Text>')
