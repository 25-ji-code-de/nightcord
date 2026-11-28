// 并行逐帧渲染：render(t) 是纯函数，所以每帧只依赖 t，多个页面并行结果一致。
// 用法：node render/frames.mjs [起始帧] [结束帧(不含)] [并行数]
// DEMO_PROFILE=preview（默认）或 final；使用 PNG 无损中间帧，分别存放。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, executablePath } from './browser.mjs';
import { getProfile, VIEWPORT, FPS, DURATION, TOTAL_FRAMES } from './config.mjs';

const profile = getProfile();
const outDir = profile.framesDir;
const start = Number(process.argv[2] ?? 0);
const end = Number(process.argv[3] ?? TOTAL_FRAMES);
const workers = Number(process.argv[4] ?? process.env.DEMO_WORKERS ?? profile.workers);
if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > TOTAL_FRAMES) {
  throw new Error(`帧范围必须满足 0 <= 起始帧 < 结束帧 <= ${TOTAL_FRAMES}。`);
}
if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error('并行数必须为 1–32 的整数。');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--allow-file-access-from-files', '--force-color-profile=srgb', '--font-render-hinting=none'] });
let next = start, done = 0;
const t0 = Date.now();
console.log(`${profile.name}：${profile.width}×${profile.height} / ${FPS} fps / PNG，${workers} 个并行页面`);

async function worker() {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: profile.scale });
  let pageError;
  page.on('pageerror', error => { pageError = error; });
  await page.goto(profile.sceneUrl);
  await page.evaluate(() => window.READY);
  if (pageError) throw pageError;
  while (true) {
    const i = next++;
    if (i >= end) break;
    await page.evaluate(t => window.render(t), i / FPS);
    await page.screenshot({ path: join(outDir, `f${String(i).padStart(5, '0')}.png`), type: 'png', scale: 'device' });
    if (pageError) throw pageError;
    if (++done % 120 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${end - start} 帧，${rate.toFixed(1)} 帧/秒，预计剩余 ${(((end - start) - done) / rate).toFixed(0)} 秒`);
    }
  }
  await page.close();
}
try {
  await Promise.all(Array.from({ length: Math.min(workers, end - start) }, worker));
} finally {
  await browser.close();
}
writeFileSync(join(outDir, 'render.json'), JSON.stringify({
  profile: profile.name, width: profile.width, height: profile.height, fps: FPS, duration: DURATION, total: TOTAL_FRAMES, format: 'png',
}, null, 2) + '\n');
console.log(`完成：${end - start} 帧，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
