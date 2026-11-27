// 帧耗时分析：分别测量 render(t) 与 screenshot 的耗时，并在关闭某类特效后对比。
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire('/root/.nvm/versions/node/v22.13.1/lib/node_modules/');
const { chromium } = require('playwright-core');
const url = pathToFileURL(fileURLToPath(new URL('../scene/index.html', import.meta.url))).href;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(url);
await page.evaluate(() => window.READY);

async function bench(label, times, opts = {}) {
  const t0 = Date.now();
  let tr = 0;
  for (const t of times) {
    const a = Date.now();
    await page.evaluate(t => window.render(t), t);
    tr += Date.now() - a;
    await page.screenshot({ type: opts.type || 'png', ...(opts.type === 'jpeg' ? { quality: 95 } : {}) });
  }
  const total = Date.now() - t0;
  console.log(`${label.padEnd(30)} ${(total / times.length).toFixed(0)} ms/帧（render ${(tr / times.length).toFixed(0)} ms）`);
}
const span = (a, n) => Array.from({ length: n }, (_, i) => a + i / 60);
await bench('片头 (t=1)', span(1, 12));
await bench('窗口 (t=12)', span(12, 12));
await bench('提醒镜头 (t=20)', span(20, 12));
await bench('手机 (t=40)', span(40, 12));
await bench('窗口 jpeg', span(12, 12), { type: 'jpeg' });
await page.addStyleTag({ content: '* { backdrop-filter: none !important; }' });
await bench('窗口 去 backdrop-filter', span(12, 12));
await page.addStyleTag({ content: '#grain { display: none !important; } #vig { display: none !important; }' });
await bench('窗口 再去 grain/vig', span(12, 12));
await page.addStyleTag({ content: '#bg { display: none !important; }' });
await bench('窗口 再去背景', span(12, 12));
await browser.close();
