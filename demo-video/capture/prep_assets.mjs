// 从截图裁出视频合成用的素材（登录卡片、提醒卡片），圆角外透明。用 ffmpeg，不依赖 Python。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { getProfile } from '../render/config.mjs';

const profile = getProfile();
const shots = profile.shotsDir, assets = profile.assetsDir;
const scale = profile.captureScale / 2; // 下方坐标取自原始 2x 截图；4x 素材等比裁切。
mkdirSync(assets, { recursive: true });

// 圆角遮罩：geq 计算每个像素到最近圆角圆心的距离，超出半径处 alpha 为 0。
function crop(src, out, [x, y, w, h], r) {
  [x, y, w, h, r] = [x, y, w, h, r].map(value => value * scale);
  const a = `if(lte(hypot(max(0,max(${r}-X,X-(W-1-${r}))),max(0,max(${r}-Y,Y-(H-1-${r})))),${r}),255,0)`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', shots + src,
    '-vf', `crop=${w}:${h}:${x}:${y},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${a}'`, assets + out]);
  console.log('  ✓', out, `${w}x${h}`);
}

for (const name of ['chooser', 'chooser-typed', 'chooser-typed-1']) crop(`${name}.png`, `card-${name}.png`, [962, 357, 956, 1088], 44);
// 站内提醒卡片：位置用 capture/diffbox.mjs 比对 notify.png 与 notify-clean.png 测得（2x 像素）。
crop('notify.png', 'toast.png', [1535, 1478, 482, 110], 55);
