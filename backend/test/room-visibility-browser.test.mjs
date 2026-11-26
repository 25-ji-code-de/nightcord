/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('room visibility controls update peers, survive reload and isolate rooms on desktop and mobile', { timeout: 90_000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  let runtime, browser;
  const errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    runtime = createRuntime({}, { origin });
    const apiBase = String(await runtime.ready).replace(/\/$/, ''), wsBase = apiBase.replace(/^http/, 'ws');
    browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (url.origin === origin || url.origin === apiBase) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    async function load(page, account) {
      await page.goto(origin);
      await page.evaluate(({ apiBase, wsBase, account }) => {
        window.bus = new EventBus(); window.ui = new UIManager(bus);
        window.manager = new NightcordManager({ eventBus: bus, getAccessToken: async () => account ? 'local-test-token' : null,
          fetch: (url, options) => fetch(String(url).replace('https://chat.nightcord.de5.net', apiBase), options) });
        manager.wsManager.protocol.url = room => `${wsBase}/api/room/${room}/websocket`;
        bus.on('room:visibility:set', ({ visibility }) => manager.setVisibility(visibility));
        window.join = room => { ui.setCurrentRoom(room); manager.joinRoom(room); };
        ui.setupChatRoom(text => manager.sendMessage(text), () => {});
        manager.setUser('Observer'); join('visibility-browser');
      }, { apiBase, wsBase, account });
      await page.waitForFunction(() => manager.wsManager.ready && ui.roomVisibility?.available);
    }
    async function pageFor(account) {
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await load(page, account); return page;
    }
    async function settings(page) {
      await page.locator('#navigation-settings').click();
      await page.getByRole('tab', { name: '成员动态与关注', exact: true }).click();
    }
    const observer = await pageFor(false), account = await pageFor(true), tab = await pageFor(true);
    const selector = '[data-user-id="sekai:stable-subject"]';
    await observer.locator(`#online-users ${selector}`).waitFor();
    await settings(account); await settings(tab);
    await account.getByRole('radio', { name: '显示为离线', exact: true }).check();
    await observer.locator(`#offline-users ${selector}`).waitFor();
    assert.equal(await observer.locator(`#online-users ${selector}`).count(), 0);
    await tab.waitForFunction(() => document.querySelector('input[name="nightcord-room-visibility"][value="offline"]').checked);
    await tab.getByRole('radio', { name: '从列表隐藏', exact: true }).check();
    await observer.waitForFunction(() => !document.querySelector('[data-user-id="sekai:stable-subject"]'));
    await account.waitForFunction(() => ui.roomVisibility.visibility === 'hidden');
    assert.equal(await account.locator('#online-users ' + selector).count(), 0);
    await account.evaluate(() => manager.sendMessage('Hidden member can still chat'));
    await observer.getByText('Hidden member can still chat', { exact: true }).waitFor();
    assert.equal(await observer.locator(`#online-users ${selector}`).count(), 0, 'messages do not restore presence');
    await account.evaluate(() => join('visibility-browser-other'));
    await account.waitForFunction(() => ui.roomVisibility.available && ui.roomVisibility.visibility === 'online');
    assert.equal(await account.getByRole('radio', { name: '正常显示', exact: true }).isChecked(), true);
    // Joining has its existing IP budget; allow it to replenish before testing reloads.
    await new Promise(resolve => setTimeout(resolve, 5500));
    await load(account, true);
    assert.equal(await account.evaluate(() => ui.roomVisibility.visibility), 'hidden');
    assert.equal(await account.locator(`#online-users ${selector}`).count(), 0, 'session restoration does not insert self');
    await settings(account);
    const output = join(root, 'promo', 'room-visibility'); await mkdir(output, { recursive: true });
    await account.screenshot({ path: join(output, 'room-visibility-desktop.png') });
    await account.setViewportSize({ width: 375, height: 812 });
    await account.locator('.room-visibility').scrollIntoViewIfNeeded();
    assert.equal(await account.getByRole('radio', { name: '从列表隐藏', exact: true }).isVisible(), true);
    assert.equal(await account.locator('#appearance-settings').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await account.screenshot({ path: join(output, 'room-visibility-mobile.png') });
    await account.setViewportSize({ width: 812, height: 375 });
    await account.locator('.room-visibility').scrollIntoViewIfNeeded();
    assert.equal(await account.locator('#appearance-settings').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const normal = account.getByRole('radio', { name: '正常显示', exact: true });
    await normal.focus(); await account.keyboard.press('Space');
    await observer.locator(`#online-users ${selector}`).waitFor();
    await account.evaluate(() => manager.leave());
    assert.equal(await normal.isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await runtime?.dispose(); await new Promise(resolve => server.close(resolve));
  }
});
