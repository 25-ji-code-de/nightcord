// 抽取若干时刻的静帧，用来检查布局。用法：node render/preview.mjs 1.5 7.8 13.9 ...
import { mkdirSync } from 'node:fs';
import { getProfile, VIEWPORT } from './config.mjs';
import { chromium, executablePath } from './browser.mjs';

const profile = getProfile();
const out = `${profile.buildDir}stills/`;
mkdirSync(out, { recursive: true });

const times = process.argv.slice(2).map(Number);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--allow-file-access-from-files', '--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: profile.scale });
page.on('console', m => console.log('  [console]', m.text()));
page.on('pageerror', e => console.log('  [pageerror]', e.message));
await page.goto(profile.sceneUrl);
await page.evaluate(() => window.READY);
for (const t of times) {
  await page.evaluate(t => window.render(t), t);
  await page.screenshot({ path: `${out}t${t.toFixed(2).padStart(6, '0')}.png`, scale: 'device' });
  console.log('  ✓', t);
}
await browser.close();
