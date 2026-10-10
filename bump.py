# Bumps the ?v= cache-busting version on every module, the stylesheet and the entry script in index.html.
# Run before pushing so browsers fetch the new files instead of mixing old and new.
import re
from pathlib import Path

p = Path(__file__).with_name('index.html')
s = p.read_text(encoding='utf-8')
v = int(re.search(r'\?v=(\d+)', s).group(1)) + 1
p.write_text(re.sub(r'\?v=\d+', f'?v={v}', s), encoding='utf-8')
print('version', v)
