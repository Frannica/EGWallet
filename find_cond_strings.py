import os, re

results = []

for root, dirs, files in os.walk('src'):
    dirs[:] = [d for d in dirs if d != 'node_modules']
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
            
            # Pattern 1: {someVar && 'string literal'} - renders string directly in JSX
            if re.search(r'\{[^}]+&&\s*[\'"]', stripped):
                results.append((path, i, 'COND_STR', stripped[:120]))
            
            # Pattern 2: {someVar && `template literal`}
            if re.search(r'\{[^}]+&&\s*`', stripped):
                results.append((path, i, 'COND_TMPL', stripped[:120]))

for path, i, kind, txt in results:
    print(f'{path}:{i} [{kind}] {txt}')

if not results:
    print('No cond-string patterns found.')
