"""由 icons/nightcord-wordmark.svg 逐字母拆出路径，写成 wordmark.js，用于书写式入场。"""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
svg = (root / 'icons' / 'nightcord-wordmark.svg').read_text(encoding='utf-8')
items = []
for pid, attrs in re.findall(r'<path id="([^"]+)"([^>]*?)/>', svg):
    transform = re.search(r'transform="([^"]+)"', attrs).group(1)
    d = re.search(r' d="([^"]+)"', attrs).group(1)
    items.append({'id': pid, 'transform': transform, 'd': ' '.join(d.split())})

js = '// 由 icons/nightcord-wordmark.svg 逐字母拆出（gen_wordmark.py 生成）。\nconst WORDMARK = ' + json.dumps(items, ensure_ascii=False, indent=1) + ';\n'
(Path(__file__).parent / 'wordmark.js').write_text(js, encoding='utf-8')
print(len(items), [i['id'] for i in items])
