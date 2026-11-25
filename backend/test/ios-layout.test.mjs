/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, webkit, devices } from 'playwright';

test('iOS layout preserves preferences and keeps phone controls within the visible safe area', { timeout: 180_000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html')));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const useWebkit = process.env.NIGHTCORD_TEST_BROWSER === 'webkit';
    browser = await (useWebkit ? webkit : chromium).launch(useWebkit ? {} : { executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', reducedMotion: 'reduce' });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (url.origin === origin) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    const setup = () => page.evaluate(() => {
      window.iosUI = new UIManager(new EventBus());
      iosUI.setupChatRoom(() => {}, () => {});
      iosUI.addChatMessage('K', '今晚也一起完成作业吧。');
      iosUI.addChatMessage('Amia', '嗯，先把这一段写完。');
    });
    const openSettings = async () => {
      if (await page.locator('.sidebar-toggle').isVisible() && !await page.locator('#navigation-settings').isVisible()) await page.locator('.sidebar-toggle').click();
      await page.locator('#navigation-settings').click();
    };
    const toggle = page.getByRole('switch', { name: 'iPhone / iOS 适配', exact: true });
    const rounded = page.getByRole('switch', { name: '圆角', exact: true });
    const closeSettings = async () => {
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await page.locator('#appearance-settings').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.navigation-scrim').isVisible(), false, 'closing settings must not need a second tap to dismiss a drawer scrim');
      assert.equal(await page.locator('.main').evaluate(node => node.inert), false);
    };
    const bounds = selector => page.locator(selector).evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    const radius = selector => page.locator(selector).evaluate(node => getComputedStyle(node).borderTopRightRadius);
    await page.goto(origin);
    await setup();
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('先把这一段写完'));
    await page.locator('#messageInput').fill('还没发送的草稿');
    const headerColor = await page.locator('.chat-header').evaluate(node => getComputedStyle(node).backgroundColor);
    const themeColor = await page.locator('meta[name="theme-color"]').getAttribute('content');
    const messages = await page.locator('#messages').textContent();
    await openSettings();
    assert.equal(await toggle.isChecked(), true, 'iPhone starts with iOS layout enabled');
    assert.equal(await page.evaluate(() => localStorage.getItem('nightcord-ios-layout')), null, 'automatic defaults do not overwrite a user preference');
    await toggle.uncheck();
    await toggle.check();
    assert.equal(await page.evaluate(() => localStorage.getItem('nightcord-ios-layout')), 'on');
    assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit=cover/);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.input-box')).borderTopRightRadius === '24px');
    assert.equal(await radius('#appearance-settings'), '28px');
    assert.equal(await page.locator('.palette-color-options input').count(), 3);
    assert.equal(await page.locator('.palette-color-options .palette-option-body').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true);
    assert.equal(await page.locator('#messageInput').inputValue(), '还没发送的草稿');
    assert.equal(await page.locator('#messages').textContent(), messages);
    await rounded.uncheck();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.input-box')).borderTopRightRadius === '0px');
    assert.equal(await radius('.input-box'), '0px');
    await rounded.check();
    await toggle.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#pwa-storage').evaluate(node => node === document.activeElement), true);
    await page.locator('#pwa-update').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.settings-close').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#pwa-update').evaluate(node => node === document.activeElement), true);
    const second = await context.newPage();
    await second.goto(origin);
    assert.equal(await second.locator('html').getAttribute('data-ios-layout'), 'on');
    await toggle.uncheck();
    await second.waitForFunction(() => document.documentElement.dataset.iosLayout === 'off');
    await second.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await second.locator('html').getAttribute('data-ios-layout'), 'off', 'an explicit opt-out survives reload on iOS');
    assert.doesNotMatch(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit/);
    await toggle.check();
    await second.close();
    await closeSettings();
    assert.equal(await page.locator('.chat-header').evaluate(node => getComputedStyle(node).backgroundColor), headerColor);
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), themeColor);
    assert.equal(await page.locator('.chat-header').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }), true, 'the header must not be covered by a dimming layer');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await setup();
    assert.equal(await page.locator('html').getAttribute('data-ios-layout'), 'on');

    // Desktop emulators expose zero hardware insets; inject realistic device insets.
    for (const viewport of [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      const landscape = viewport.width > viewport.height;
      const safe = landscape ? { top: 0, right: 47, bottom: 21, left: 47 } : { top: 47, right: 0, bottom: 34, left: 0 };
      await page.evaluate(safe => {
        for (const [edge, value] of Object.entries(safe)) document.documentElement.style.setProperty(`--nc-ios-safe-${edge}`, `${value}px`);
      }, safe);
      // The iOS block applies its padding from a media query, while the plain
      // .chat-root height rule satisfies the same height before that block lands.
      // Wait for the safe-area padding itself, or measurements read stale layout.
      await page.waitForFunction(([height, top]) => {
        const root = document.querySelector('.chat-root');
        return Math.abs(root.getBoundingClientRect().height - height) < 2
          && Math.abs(parseFloat(getComputedStyle(root).paddingTop) - top) < 1;
      }, [viewport.height, safe.top]);
      assert.equal((await bounds('.chat-root')).overflow, false);
      assert.ok((await bounds('.chat-header')).top >= safe.top);
      const composer = await bounds('.input-box');
      assert.ok(composer.left >= safe.left + 20 && composer.right <= viewport.width - safe.right - 20);
      assert.ok(Math.abs(composer.bottom - (viewport.height - Math.max(0, safe.bottom - 4))) <= 1, 'the composer moves another four pixels lower');
      assert.ok(composer.height <= 56, 'the empty composer stays a compact single row');
      assert.equal(composer.overflow, false);
      assert.ok(await page.locator('#messageInput').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
      for (const button of await page.locator('.input-btn').all()) {
        const rect = await button.boundingBox();
        assert.ok(rect.width >= 44 && rect.height >= 44);
        assert.ok(rect.y + rect.height <= viewport.height - safe.bottom + 1, 'touch targets remain above the home indicator');
      }
      await openSettings();
      const dialog = await bounds('#appearance-settings');
      assert.ok(dialog.top >= Math.max(16, safe.top) && dialog.bottom <= viewport.height - Math.max(16, safe.bottom) + 1);
      assert.ok(dialog.left >= Math.max(16, safe.left) && dialog.right <= viewport.width - Math.max(16, safe.right));
      assert.equal(dialog.overflow, false);
      assert.equal(await page.locator('.navigation-scrim').isVisible(), false);
      assert.equal(await toggle.isChecked(), true);
      await toggle.scrollIntoViewIfNeeded();
      const toggleBounds = await bounds('#ios-layout-toggle');
      const footerBounds = await bounds('.settings-footer');
      assert.ok(toggleBounds.bottom <= footerBounds.top + 1);
      assert.ok((await bounds('.settings-close')).top >= safe.top);
      if (process.env.NIGHTCORD_IOS_SCREENSHOTS && viewport.width === 390) {
        await mkdir(resolve(root, '.qa-artifacts/ios-layout'), { recursive: true });
        await page.screenshot({ path: resolve(root, '.qa-artifacts/ios-layout/settings.png') });
      }
      await closeSettings();
      assert.equal(await page.locator('.main').evaluate(node => node.inert), false);
      if (process.env.NIGHTCORD_IOS_SCREENSHOTS && viewport.width === 390) await page.screenshot({ path: resolve(root, '.qa-artifacts/ios-layout/chat.png') });
    }

    // Large text grows the grouped rows without hiding switches or dismiss controls.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '34px'; });
    await openSettings();
    await toggle.scrollIntoViewIfNeeded();
    assert.equal((await bounds('#appearance-settings')).overflow, false);
    assert.ok((await bounds('#ios-layout-toggle')).bottom <= (await bounds('.settings-footer')).top + 1);
    assert.ok((await page.locator('.settings-toggle-track').first().boundingBox()).width >= 44);
    await closeSettings();
    await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });

    // Safari rubber band/toolbar movement must not translate or resize the app.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport, { height: { configurable: true, value: 700 }, offsetTop: { configurable: true, value: 80 } });
      window.visualViewport.dispatchEvent(new Event('scroll'));
      window.visualViewport.dispatchEvent(new Event('resize'));
      window.scrollTo(0, 120);
    });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal((await bounds('.chat-root')).top, 0);
    assert.equal((await bounds('.chat-root')).height, 844);
    assert.equal(await page.evaluate(() => window.scrollY), 0);

    // Keyboard resizing is limited to editing, without following viewport panning.
    const headerBeforeKeyboard = await bounds('.chat-header');
    const messagesBeforeKeyboard = await bounds('#messages');
    await page.locator('#messageInput').focus();
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport, { height: { configurable: true, value: 420 }, offsetTop: { configurable: true, value: 12 } });
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.querySelector('.chat-root').getBoundingClientRect().height === 420);
    assert.equal((await bounds('.chat-root')).top, 0);
    assert.equal((await bounds('.input-box')).bottom, 418);
    assert.deepEqual(await bounds('.chat-header'), headerBeforeKeyboard, 'keyboard opening does not move or resize navigation');
    assert.ok((await bounds('#messages')).height < messagesBeforeKeyboard.height);
    await page.locator('#messageInput').evaluate(node => node.blur());
    await page.waitForFunction(() => document.querySelector('.chat-root').getBoundingClientRect().height === 844);
    await openSettings();
    await toggle.uncheck();
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--nc-ios-viewport-height')), '');
    await closeSettings();
    await page.evaluate(() => {
      localStorage.setItem('nightcord-ios-layout', 'invalid');
      delete window.visualViewport.height;
      delete window.visualViewport.offsetTop;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('html').getAttribute('data-ios-layout'), 'on', 'invalid preferences fall back to the device default');
    await page.evaluate(() => localStorage.removeItem('nightcord-ios-layout'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('html').getAttribute('data-ios-layout'), 'on');

    const blocked = await context.newPage();
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
    await blocked.goto(origin);
    await blocked.evaluate(() => new UIManager(new EventBus()).setupChatRoom(() => {}, () => {}));
    await blocked.locator('.sidebar-toggle').click();
    await blocked.locator('#navigation-settings').click();
    assert.equal(await blocked.locator('html').getAttribute('data-ios-layout'), 'on');
    await blocked.getByRole('switch', { name: 'iPhone / iOS 适配', exact: true }).uncheck();
    assert.equal(await blocked.locator('html').getAttribute('data-ios-layout'), 'off');
    assert.match(await blocked.locator('#palette-status').textContent(), /无法保存/);

    for (const profile of [
      { name: 'iPad desktop mode', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5, expected: 'on' },
      { name: 'Mac', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0, expected: 'off' },
      { name: 'Windows touch', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 10, expected: 'off' },
      { name: 'Android', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5, expected: 'off' },
    ]) {
      const devicePage = await context.newPage();
      await devicePage.addInitScript(profile => {
        for (const key of ['userAgent', 'platform', 'maxTouchPoints']) Object.defineProperty(navigator, key, { configurable: true, get: () => profile[key] });
        localStorage.removeItem('nightcord-ios-layout');
      }, profile);
      await devicePage.goto(origin);
      assert.equal(await devicePage.locator('html').getAttribute('data-ios-layout'), profile.expected, profile.name);
      await devicePage.evaluate(() => new UIManager(new EventBus()).setupChatRoom(() => {}, () => {}));
      await devicePage.locator('.sidebar-toggle').click();
      await devicePage.locator('#navigation-settings').click();
      const switchWidth = await devicePage.locator('.settings-toggle-track').first().evaluate(node => node.getBoundingClientRect().width);
      assert.equal(switchWidth, 44, `${profile.name}: switches keep the shared Nightcord style`);
      await devicePage.locator('.settings-close').click();
      await devicePage.locator('#appearance-settings').waitFor({ state: 'detached' });
      assert.equal(await devicePage.locator('.navigation-scrim').isVisible(), false, `${profile.name}: shared scrim cleanup`);
      for (const button of await devicePage.locator('.input-btn').all()) {
        const rect = await button.boundingBox();
        assert.ok(rect.width >= 44 && rect.height >= 44, `${profile.name}: shared touch targets`);
      }
      assert.ok(await devicePage.locator('#messageInput').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
      await devicePage.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
  }
});
