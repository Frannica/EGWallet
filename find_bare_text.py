"""
Finds lines in TSX/JSX files where a non-empty string literal appears to be
rendered directly in JSX without being wrapped in a <Text> component.
Strategy: look for lines that are JUST a quoted string (no JSX tags on same line),
which would mean they're bare text content in the component tree.
"""
import os, re

results = []

for root, dirs, files in os.walk('src'):
    dirs[:] = [d for d in dirs if d != 'node_modules']
    for f in files:
        if not f.endswith(('.tsx', '.jsx')):
            continue
        path = os.path.join(root, f)
        with open(path, encoding='utf-8', errors='replace') as fh:
            lines = fh.readlines()

        for i, raw in enumerate(lines, 1):
            stripped = raw.strip()
            # Skip blank lines, comments, imports
            if not stripped:
                continue
            if stripped.startswith(('import ', 'export ', '//', '*', '/*', 'const ', 'let ', 'var ', 'type ', 'interface ', 'return', 'case ', 'default:', 'break', 'throw', 'if (', 'if(', 'for ', 'while ', 'switch ', 'try ', 'catch ', 'function ', 'async ')):
                continue

            # Most telling pattern:
            # A line that is EXACTLY a string literal (e.g. the content of a JSX element)
            # like:   Some text here
            # or      'some text'
            # directly inside a View instead of Text

            # Pattern: line inside JSX that looks like a sentence (text content)
            # These appear as: "          Some words here" lines
            # The issue: these are NOT inside a <Text> tag

            # Look specifically for lines that are ONLY a string literal with no JSX syntax
            if re.match(r'^[A-Z][a-z A-Za-z\.,\'\-\!\?:]{8,}$', stripped):
                # These look like text content lines
                # Check the surrounding context (prev lines) to see if inside Text or View
                # Look at the 5 lines before
                context_before = [lines[j].strip() for j in range(max(0, i-6), i-1)]
                is_in_text = any('<Text' in l for l in context_before)
                is_in_view = any('<View' in l and '<Text' not in l for l in context_before)
                
                # Also check it's in a JSX return context
                is_in_return = any('return' in l or 'return(' in l for l in context_before[:10])
                
                if not is_in_text and is_in_view:
                    results.append((path, i, 'BARE_TEXT', stripped[:100]))

            # Also: JSX comment markers that somehow got written as regular text?
            # No - let's focus on explicit patterns

print(f'Found {len(results)} suspicious locations:\n')
for path, lineno, kind, txt in results:
    print(f'  {path}:{lineno}: {txt}')

if not results:
    print('No bare text patterns found via this approach.')
    print()
    print('Trying another approach: looking for {expr} where expr evaluates to string...')
    print()
    # Look for {apiError} or {error} outside Text
    for root2, dirs2, files2 in os.walk('src'):
        dirs2[:] = [d for d in dirs2 if d != 'node_modules']
        for f2 in files2:
            if not f2.endswith(('.tsx', '.jsx')):
                continue
            path2 = os.path.join(root2, f2)
            with open(path2, encoding='utf-8', errors='replace') as fh2:
                content2 = fh2.read()
            # Look for apiError rendered directly
            matches = [(m.start(), m.group()) for m in re.finditer(r'\{apiError\}|\{error\b[^}]*\}|\{err\b[^}]*\}', content2)]
            for pos, match in matches:
                lineno2 = content2[:pos].count('\n') + 1
                line2 = content2.split('\n')[lineno2-1].strip()
                print(f'  {path2}:{lineno2}: {line2[:100]}')
