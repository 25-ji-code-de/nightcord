// 并行逐帧渲染：render(t) 是纯函数，所以每帧只依赖 t，多个页面并行结果一致。
// 用法：node render/frames.mjs [起始帧] [结束帧(不含)] [并行数]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire('/root/.nvm/versions/node/v22.13.1/lib/node_modules/');
const { chromium } = require('playwright-core');
const outDir = fileURLToPath(new URL('../frames/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const sceneUrl = pathToFileURL(fileURLToPath(new URL('../scene/index.html', import.meta.url))).href;

const FPS = 60, DURATION = 58.4; // 与 scene/data.js 的 DUR 一致
const total = Math.round(FPS * DURATION);
const start = Number(process.argv[2] ?? 0);
const end = Math.min(total, Number(process.argv[3] ?? total));
const workers = Number(process.argv[4] ?? 12);

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files', '--force-color-profile=srgb', '--font-render-hinting=none'] });
let next = start, done = 0;
const t0 = Date.now();

async function worker() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { console.error('pageerror', e.message); process.exit(1); });
  await page.goto(sceneUrl);
  await page.evaluate(() => window.READY);
  while (true) {
    const i = next++;
    if (i >= end) break;
    await page.evaluate(t => window.render(t), i / FPS);
    await page.screenshot({ path: `${outDir}f${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 96 });
    if (++done % 120 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${end - start} 帧，${rate.toFixed(1)} 帧/秒，预计剩余 ${(((end - start) - done) / rate).toFixed(0)} 秒`);
    }
  }
  await page.close();
}
await Promise.all(Array.from({ length: workers }, worker));
await browser.close();
console.log(`完成：${end - start} 帧，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
