"""
Comprehensive search for 'Text strings must be rendered within Text component' pattern.
Looks for string values rendered directly inside View/TouchableOpacity/LinearGradient
instead of inside Text components.

Key patterns:
1. {someStringVar} where it's on its own line, context has View but not Text
2. Template literals or string expressions in View context  
3. Short inline JSX where strings might escape text wrapping
"""
import os, re

SCAN_DIR = 'src'

def get_lines_context(lines, idx, before=5, after=2):
    start = max(0, idx - before)
    end = min(len(lines), idx + after)
    return lines[start:end]

results = []

for root, dirs, files in os.walk(SCAN_DIR):
    dirs[:] = [d for d in dirs if d != 'node_modules']
    for f in files:
        if not f.endswith(('.tsx', '.jsx')):
            continue
        path = os.path.join(root, f)
        lines = open(path, encoding='utf-8', errors='replace').readlines()
        
        for i, raw_line in enumerate(lines):
            stripped = raw_line.strip()
            if not stripped or stripped.startswith(('//','*','/*','import ','type ','interface ','const ','let ','var ','export ')):
                continue
            
            # Pattern A: line is { expr } alone (not inside a Text)
            # Check that this is in JSX context (has < > nearby) and not inside Text
            if re.match(r'^\{[^}]+\}$', stripped):
                ctx = get_lines_context(lines, i, before=8, after=1)
                ctx_str = ''.join(ctx)
                
                # Skip if there's a Text component open recently
                if re.search(r'<(?:Text|Button|TextInput)', ctx_str):
                    continue
                # Skip if it's inside a .map() or other array operation context
                if re.search(r'\)\s*=>\s*\($', ''.join(lines[max(0,i-3):i])):
                    continue
                # Skip {children}
                if stripped == '{children}':
                    continue
                # Skip JSX element expressions like {scamTipsModal}
                # These are React elements assigned to vars, not strings
                # Only flag if the var ends in common string patterns
                var_name = re.match(r'^\{([^}]+)\}$', stripped).group(1).strip()
                if any(v in var_name.lower() for v in ['error', 'msg', 'message', 'label', 'title', 'text', 'name', 'email', 'value', 'desc']):
                    has_nearby_view = any('<View' in l or '<LinearGradient' in l or '<TouchableOpacity' in l or '<ScrollView' in l for l in ctx)
                    has_text = any('<Text' in l for l in ctx)
                    if has_nearby_view and not has_text:
                        results.append((path, i+1, f'SUSPECT_VAR', stripped, ctx[-3:]))

# Print results
print(f'Found {len(results)} suspect locations:')
for path, lineno, kind, code, ctx in results:
    print(f'\n  {path}:{lineno} [{kind}]: {code}')
    for c in ctx:
        print(f'    | {c.rstrip()}')

if not results:
    print('No suspect locations found.')
