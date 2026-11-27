// 抽取若干时刻的静帧，用来检查布局。用法：node render/preview.mjs 1.5 7.8 13.9 ...
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire('/root/.nvm/versions/node/v22.13.1/lib/node_modules/');
const { chromium } = require('playwright-core');
const here = fileURLToPath(new URL('.', import.meta.url));
const out = fileURLToPath(new URL('../build/preview/', import.meta.url));
mkdirSync(out, { recursive: true });

const times = process.argv.slice(2).map(Number);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files', '--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('console', m => console.log('  [console]', m.text()));
page.on('pageerror', e => console.log('  [pageerror]', e.message));
await page.goto(pathToFileURL(fileURLToPath(new URL('../scene/index.html', import.meta.url))).href);
await page.evaluate(() => window.READY);
for (const t of times) {
  await page.evaluate(t => window.render(t), t);
  await page.screenshot({ path: `${out}t${t.toFixed(2).padStart(6, '0')}.png` });
  console.log('  ✓', t);
}
await browser.close();
