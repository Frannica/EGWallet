# Fix premature }; on dispute.hint lines and missing }; after wallet.serverError
import re

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    content = f.read()

original = content

# Step 1: Remove }; that is incorrectly appended right after the last quote on dispute.hint lines
# Pattern: ',}; followed by newline then a comment line
content = re.sub(r"('dispute\.hint':\s*'[^']*'),};\s*\n(\s*//)", r"\1,\n\2", content)

# Step 2: For each language, wallet.serverError is the last key but missing };
# Pattern: wallet.serverError line followed directly by blank line + const XX: or export
content = re.sub(
    r"('wallet\.serverError':\s*'[^']*',)\n\n(const [a-z]+:|export const translations)",
    r"\1\n};\n\n\2",
    content
)

changes = content != original
if changes:
    with open('src/i18n/translations.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Fixed successfully.")
else:
    print("No changes made - patterns not found.")

# Verify: count dispute.hint occurrences with }; still present
remaining = re.findall(r"'dispute\.hint':[^;]*',};", content)
if remaining:
    print("WARNING: " + str(len(remaining)) + " dispute.hint lines still have }: ")
    for r in remaining:
        print(" ", r[:80])
else:
    print("OK: No dispute.hint lines have }; anymore.")

# Verify: wallet.serverError lines not followed by };
bad = re.findall(r"'wallet\.serverError':\s*'[^']*',\n(?!\};)", content)
if bad:
    print("WARNING: " + str(len(bad)) + " wallet.serverError lines still missing }: ")
    for b in bad:
        print(" ", b[:80])
else:
    print("OK: All wallet.serverError lines are followed by };")
