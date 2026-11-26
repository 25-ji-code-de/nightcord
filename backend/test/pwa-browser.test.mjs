/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

test('PWA installs its shell, exposes accessible settings and reloads offline on desktop and mobile', { timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://local').pathname;
    if (path === '/boot.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(''); return; }
    if (path === '/version.json') { response.setHeader('Content-Type', 'application/json'); response.end('{"v":"test"}'); return; }
    try {
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const screenshots = resolve(root, 'backend/dist/pwa-screenshots'); await mkdir(screenshots, { recursive: true });
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => !!await caches.match('/css/pwa.css'));
  assert.equal(cached, true);
  await page.locator('#navigation-settings').click();
  await page.getByRole('tab', { name: '应用与推送通知', exact: true }).click();
  assert.equal(await page.locator('#settings-pwa').isVisible(), true);
  assert.equal(await page.locator('#pwa-push-enable').isDisabled(), true);
  await page.screenshot({ path: resolve(screenshots, 'desktop.png') });
  await page.evaluate(() => { document.documentElement.dataset.roundedCorners = 'off'; });
  assert.equal(await page.locator('#pwa-update').evaluate(button => getComputedStyle(button).borderRadius), '0px');
  await page.evaluate(() => { document.documentElement.dataset.roundedCorners = 'on'; });
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt');
    event.prompt = async () => {}; event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: '安装应用', exact: true }).click();
  assert.match(await page.locator('#pwa-status').textContent(), /安装已启动/);
  await context.setOffline(true);
  await page.locator('.pwa-offline').waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#navigation-settings').click();
  await page.getByRole('tab', { name: '应用与推送通知', exact: true }).click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  assert.match(await page.locator('#pwa-status').textContent(), /当前处于离线状态/);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.settings-sidebar').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#settings-pwa').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#pwa-update').evaluate(button => button.getBoundingClientRect().height >= 44), true);
  await page.locator('#pwa-update').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshots, 'mobile.png') });
  assert.deepEqual(errors, []);
});
