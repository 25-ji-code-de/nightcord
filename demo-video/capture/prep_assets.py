"""从截图裁出视频合成用的素材（登录卡片、通知卡片），并打印打字区的实测位置。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
shots, assets = root / 'shots', root / 'assets'
assets.mkdir(exist_ok=True)


def rounded(im, radius):
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=radius, fill=255)
    im = im.convert('RGBA')
    im.putalpha(mask)
    return im


card_box = (962, 357, 1918, 1445)
for name in ('chooser', 'chooser-typed', 'chooser-typed-1'):
    rounded(Image.open(shots / f'{name}.png').crop(card_box), 44).save(assets / f'card-{name}.png')

rounded(Image.open(shots / 'notify.png').crop((2091, 144, 2846, 407)), 30).save(assets / 'toast.png')

chat = Image.open(shots / 'chat.png').convert('RGB')
a = np.array(chat).astype(int)
bg = a[1704, 1296]
print('input bg', bg.tolist())
band = a[1660:1750, 740:1400]
mask = np.abs(band - bg).sum(axis=2) > 40
ys, xs = np.where(mask)
print('placeholder bbox (2x px): x', xs.min() + 740, xs.max() + 740, 'y', ys.min() + 1660, ys.max() + 1660)
