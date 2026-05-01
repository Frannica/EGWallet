"""Fix all unescaped apostrophes in FR/ES/PT sections using Python string replacement."""
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    content = f.read()

# Check what's actually at the problem lines
lines = content.split('\n')
for i in range(1828, 1840):
    print(f'L{i+1}: {repr(lines[i][:120])}')
