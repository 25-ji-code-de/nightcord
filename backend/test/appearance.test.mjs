/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

test('appearance settings independently apply palettes and member styles, preserving chat state and preferences', { timeout: 60_000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html');
      const path = resolve(root, '.' + decodeURIComponent(pathname));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) {
        return route.fulfill({ contentType: 'text/javascript', body: '' });
      }
      if (url.origin === origin) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    async function load(options = {}) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      if (options.blockStorage) await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
      });
      await page.goto(origin);
      await page.evaluate(() => {
        window.appearanceUI = new UIManager(new EventBus());
        appearanceUI.setupChatRoom(() => {}, () => {});
        appearanceUI.setCurrentRoom(`appearance-test-${crypto.randomUUID()}`);
        appearanceUI.addChatMessage('K', 'A message that must survive palette changes.');
        appearanceUI.addChatMessage('Amia', '[file:https://example.com/demo.zip|demo.zip|1024]');
        appearanceUI.addUserToRoster('Text member', { id: 'guest:text', displayName: 'Text member', authenticated: false });
        appearanceUI.addUserToRoster('Voice member', { id: 'guest:voice', displayName: 'Voice member', authenticated: false });
        appearanceUI.eventBus.emit('voice:state', { snapshot: { revision: 1, members: [{ memberId: 'voice:member', user: { id: 'guest:voice', displayName: 'Voice member', authenticated: false }, microphone: true }] } });
      });
      await page.locator('.sekai-file-card').waitFor();
      return page;
    }
    const page = await load();
    const dialog = page.locator('#appearance-settings');
    const grayPurple = page.getByRole('radio', { name: '灰紫', exact: true });
    const indigo = page.getByRole('radio', { name: '靛蓝', exact: true });
    const current = page.getByRole('radio', { name: '新版', exact: true });
    const classic = page.getByRole('radio', { name: '旧版', exact: true });
    const colors = () => page.evaluate(() => ['.navigation-rail', '.sidebar', '.main', '.input-box', '.chat-header']
      .map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
    const geometry = () => page.evaluate(() => ['.navigation-rail', '.sidebar', '.main', '.input-box']
      .map(selector => {
        const node = document.querySelector(selector);
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return [rect.x, rect.y, rect.width, rect.height, style.fontFamily, style.borderRadius];
      }));
    const before = await geometry();
    assert.equal(await page.locator('.navigation-links > button').count(), 9);
    assert.equal(await page.locator('#navigation-chat svg').evaluate(node => node.getBoundingClientRect().width), 28);
    const beforeMessages = await page.locator('#messages').textContent();
    await page.locator('#messageInput').fill('Unsent appearance draft');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await grayPurple.isChecked(), true);
    assert.equal(await classic.isChecked(), true);
    assert.equal(await grayPurple.evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await indigo.isChecked(), true);
    assert.deepEqual(await colors(), ['rgb(21, 22, 41)', 'rgb(46, 47, 91)', 'rgb(61, 64, 112)', 'rgb(51, 54, 91)', 'rgb(61, 64, 112)']);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sekai-file-card')).backgroundColor === 'rgb(81, 86, 135)');
    assert.deepEqual(await geometry(), before, 'changing palette must not change layout, fonts or radii');
    assert.equal(await page.locator('#messages').textContent(), beforeMessages);
    assert.equal(await page.locator('#messageInput').inputValue(), 'Unsent appearance draft');
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#3d4070');
    assert.equal(await page.evaluate(() => localStorage.getItem('nightcord-palette')), 'indigo');
    // The preview colors stay distinct even after the application theme changes.
    assert.deepEqual(await dialog.locator('.palette-preview').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor)), ['rgb(80, 71, 106)', 'rgb(61, 64, 112)']);
    const textRow = page.locator('#online-users .voice-user');
    const voiceRow = page.locator('#voice-users .voice-user');
    assert.equal(await textRow.locator('.member-video').isVisible(), false);
    assert.equal(await textRow.locator('.member-microphone').isVisible(), false);
    assert.equal(await voiceRow.locator('.member-microphone').isVisible(), true);
    assert.equal(await textRow.locator('.avatar').evaluate(node => node.getBoundingClientRect().width), 28);
    await current.check();
    assert.equal(await textRow.locator('.avatar').evaluate(node => node.getBoundingClientRect().width), 32);
    await page.evaluate(() => {
      window.originalMemberRow = document.querySelector('#online-users .voice-user');
      window.originalMemberAvatar = originalMemberRow.querySelector('.avatar');
    });
    await classic.check();
    assert.equal(await page.locator('html').getAttribute('data-member-list'), 'classic');
    assert.equal(await page.locator('#online-users-label').isVisible(), false);
    assert.equal(await page.locator('#voice-users-label .section-label-chevron').isVisible(), true);
    assert.equal(await page.locator('.channel-add').isVisible(), false);
    assert.equal(await textRow.locator('.avatar').evaluate(node => node.getBoundingClientRect().width), 28);
    assert.equal(await voiceRow.locator('.member-microphone').isVisible(), true);
    assert.equal(await textRow.locator('.member-video').isVisible(), false);
    assert.equal(await textRow.locator('.member-microphone').isVisible(), false);
    assert.deepEqual(await geometry(), before, 'member styles affect the panel contents only');
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'indigo');
    assert.equal(await page.locator('#messageInput').inputValue(), 'Unsent appearance draft');
    assert.equal(await page.locator('#messages').textContent(), beforeMessages);
    assert.equal(await page.evaluate(() => originalMemberRow === document.querySelector('#online-users .voice-user') && originalMemberAvatar === originalMemberRow.querySelector('.avatar')), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('nightcord-member-list')), 'classic');
    await current.check();
    assert.equal(await page.locator('#online-users-label').isVisible(), true);
    assert.equal(await page.locator('#voice-users-label .section-label-chevron').isVisible(), false);
    assert.equal(await textRow.locator('.avatar').evaluate(node => node.getBoundingClientRect().width), 32);
    await classic.check();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#navigation-settings').evaluate(node => node === document.activeElement), true);

    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'indigo');
    assert.equal(await page.locator('html').getAttribute('data-member-list'), 'classic');
    assert.deepEqual(await colors(), ['rgb(21, 22, 41)', 'rgb(46, 47, 91)', 'rgb(61, 64, 112)', 'rgb(51, 54, 91)', 'rgb(61, 64, 112)']);
    const second = await load();
    await second.locator('#navigation-settings').click();
    assert.equal(await second.getByRole('radio', { name: '靛蓝', exact: true }).isChecked(), true);
    assert.equal(await second.getByRole('radio', { name: '旧版', exact: true }).isChecked(), true);
    await page.locator('#navigation-settings').click();
    await grayPurple.check();
    assert.equal(await page.locator('html').getAttribute('data-member-list'), 'classic');
    assert.deepEqual(await colors(), ['rgb(43, 38, 51)', 'rgb(63, 53, 91)', 'rgb(80, 71, 106)', 'rgb(63, 53, 91)', 'rgba(78, 72, 104, 0.8)']);
    await second.waitForFunction(() => document.documentElement.dataset.palette === 'gray-purple');
    assert.equal(await second.getByRole('radio', { name: '灰紫', exact: true }).isChecked(), true);
    await current.check();
    await second.waitForFunction(() => document.documentElement.dataset.memberList === 'current');
    assert.equal(await second.getByRole('radio', { name: '新版', exact: true }).isChecked(), true);
    assert.equal(await second.locator('html').getAttribute('data-palette'), 'gray-purple');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await second.close();

    await page.evaluate(() => {
      window.appearanceUI = new UIManager(new EventBus());
      appearanceUI.setupChatRoom(() => {}, () => {});
    });
    for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 667, height: 375 }]) {
      await page.setViewportSize(viewport);
      await page.locator('.sidebar-toggle').click();
      await page.locator('#navigation-settings').click();
      const bounds = await dialog.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, overflow: node.scrollWidth > node.clientWidth };
      });
      assert.ok(bounds.left >= 15 && bounds.right <= viewport.width - 15);
      assert.ok(bounds.top >= 15 && bounds.bottom <= viewport.height - 15);
      assert.equal(bounds.overflow, false);
      await indigo.check();
      assert.equal(await page.locator('.input-area').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(61, 64, 112)');
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
      }
      // Closing settings returns to the mobile drawer, then Escape closes it.
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#navigation-settings').evaluate(node => document.activeElement === node), true);
      assert.equal(await page.locator('.main').evaluate(node => node.inert), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.main').evaluate(node => node.inert), false);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#navigation-settings').click();
    assert.ok(await dialog.locator('.palette-option-body').first().evaluate(node => parseFloat(getComputedStyle(node).transitionDuration) <= .001));
    // Clicking empty panel space keeps it open; the backdrop closes it.
    await dialog.locator('.settings-header').click({ position: { x: 150, y: 20 } });
    assert.equal(await dialog.isVisible(), true);
    await page.mouse.click(2, 2);
    await dialog.waitFor({ state: 'detached' });
    await page.evaluate(() => {
      localStorage.setItem('nightcord-palette', 'unknown-palette');
      localStorage.setItem('nightcord-member-list', 'unknown-style');
    });
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'gray-purple');
    assert.equal(await page.locator('html').getAttribute('data-member-list'), 'classic');

    const blocked = await load({ blockStorage: true });
    assert.equal(await blocked.locator('html').getAttribute('data-member-list'), 'classic');
    await blocked.locator('#navigation-settings').click();
    await blocked.getByRole('radio', { name: '靛蓝', exact: true }).check();
    assert.equal(await blocked.locator('html').getAttribute('data-palette'), 'indigo');
    assert.match(await blocked.locator('#palette-status').textContent(), /无法保存/);
    await blocked.getByRole('radio', { name: '新版', exact: true }).check();
    assert.equal(await blocked.locator('html').getAttribute('data-member-list'), 'current');
    assert.equal(await blocked.locator('html').getAttribute('data-palette'), 'indigo');
    assert.match(await blocked.locator('#palette-status').textContent(), /无法保存/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
