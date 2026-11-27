// 找出两张同尺寸截图的差异区域（外接矩形，2x 像素）。用法：node capture/diffbox.mjs a.png b.png
import { execFileSync } from 'node:child_process';

const [a, b] = process.argv.slice(2);
const W = 2880, H = 1800;
const raw = f => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
const A = raw(a), B = raw(b);
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (Math.abs(A[y * W + x] - B[y * W + x]) > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
}
console.log(JSON.stringify({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }));
