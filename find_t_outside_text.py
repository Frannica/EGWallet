"""
Find t() calls that appear to be direct children of non-Text components.
Strategy: For each t() call, look at the PRECEDING non-closed JSX tag to determine context.
"""
import re, glob

files = [
    'src/screens/DepositScreen.tsx',
    'src/screens/SendScreen.tsx',
    'src/screens/SettingsScreen.tsx',
    'src/screens/WalletScreen.tsx',
    'src/screens/AuthScreen.tsx',
]

TEXT_TAGS = {'Text', 'TextInput'}  # Tags where t() is OK
NON_TEXT_TAGS = {'View', 'ScrollView', 'KeyboardAvoidingView', 'LinearGradient', 
                 'TouchableOpacity', 'Modal', 'Animated.View', 'Pressable',
                 'SafeAreaView', 'StatusBar'}

for fpath in files:
    try:
        with open(fpath, encoding='utf-8') as f:
            lines = f.readlines()
    except:
        continue
    
    # Find all t() calls and check if they might be outside Text
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # Look for lines that contain t('...') as a JSX expression (not inside a JSX attribute)
        # These would be patterns like: {t('something')} or { t('something') }
        if not re.search(r'\{.*t\(', stripped):
            continue
        # Skip lines inside JSX attributes (contains = before the {)
        if '=' in stripped.split('{')[0]:
            continue
        # Skip return statements and other non-JSX lines
        if stripped.startswith('return') or stripped.startswith('const') or stripped.startswith('let') or stripped.startswith('var'):
            continue
        # Skip lines that are clearly inside Text (contain <Text> or style= before t())
        if '<Text' in stripped:
            continue
        # Look backward to find the opening tag of the parent
        parent_tag = None
        for j in range(i-1, max(0, i-15), -1):
            prev = lines[j-1].strip()
            # Look for opening tags
            m = re.search(r'<([A-Z][A-Za-z.]*)', prev)
            if m:
                parent_tag = m.group(1)
                break
            m2 = re.search(r'<([a-z][A-Za-z.]*)', prev)  
            if m2 and m2.group(1) not in ('svg', 'path', 'circle', 'g'):
                parent_tag = m2.group(1)
                break
        
        if parent_tag and parent_tag in NON_TEXT_TAGS:
            print(f'{fpath}:{i}: [parent={parent_tag}] {stripped[:100]}')
