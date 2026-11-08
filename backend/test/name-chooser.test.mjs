/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('name chooser composition, keyboard navigation and responsive layout', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const root = new URL('../../', import.meta.url);
  const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const scripts = await Promise.all([
    'purify.js', 'sekai-escape.js', 'event-bus.js', 'ai-config.js', 'storage-manager.js',
    'file-upload-service.js', 'sekai-renderer.js', 'ui-autocomplete.js', 'user-profile.js', 'ui-manager.js',
  ].map(file => readFile(new URL(file, root), 'utf8')));

  async function fixture(t, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
    t.after(() => context.close());
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://nightcord-chooser.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      const contentType = url.pathname.endsWith('.css') ? 'text/css' : 'image/svg+xml';
      return route.fulfill({ contentType, body: await readFile(new URL('.' + url.pathname, root)) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto('http://nightcord-chooser.test/?test');
    for (const content of scripts) await page.addScriptTag({ content });
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus());
      window.submitted = [];
      ui.setupNameChooser(name => submitted.push(name));
    });
    return page;
  }

  await t.test('IME confirmation keeps the dialog open and errors are accessible', async t => {
    const page = await fixture(t);
    const input = page.getByRole('textbox', { name: '昵称' });
    await page.getByRole('button', { name: '进入 Nightcord' }).click();
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#name-error').textContent(), '请输入昵称');
    assert.equal(await page.locator('.name-chooser-content').evaluate(el => el.getAnimations().length), 0);
    await input.fill('测试昵称');
    assert.equal(await input.getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('#name-error').textContent(), '');
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent('keydown', { key: 'Enter', ...options });
      assert.deepEqual(await page.evaluate(() => submitted), []);
      assert.equal(await page.getByRole('dialog').isVisible(), true);
    }
    await input.press('Enter');
    assert.deepEqual(await page.evaluate(() => submitted), ['测试昵称']);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('.chat-root').evaluate(el => el.inert), false);
  });

  await t.test('Tab stays inside; Escape cancels renaming and restores focus', async t => {
    const page = await fixture(t);
    const input = page.locator('#name-input');
    await input.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sekai-pass-login');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'name-input');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    await input.fill('访客');
    await input.press('Enter');
    await page.locator('#attachmentBtn').focus();
    await page.evaluate(() => ui.showNameChooser({ mode: 'change', currentName: '访客' }, name => submitted.push(name)));
    assert.equal(await page.getByRole('dialog', { name: '修改昵称' }).isVisible(), true);
    assert.equal(await page.locator('.chat-root').evaluate(el => el.inert), true);
    await page.locator('#chooser-close').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'name-input');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'attachmentBtn');
    assert.deepEqual(await page.evaluate(() => submitted), ['访客']);
  });

  await t.test('small and landscape viewports retain all controls and reduced motion', async t => {
    const page = await fixture(t, { width: 375, height: 667 });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'name-chooser', 'opening on mobile must not summon the keyboard');
    for (const viewport of [
      { width: 320, height: 568 }, { width: 375, height: 667 },
      { width: 667, height: 375 }, { width: 844, height: 390 }, { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await page.locator('.name-chooser-content').evaluate(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: el.scrollWidth > el.clientWidth, animation: getComputedStyle(el).animationName };
      });
      assert.ok(bounds.left >= 15 && bounds.right <= bounds.width - 15, JSON.stringify(bounds));
      assert.ok(bounds.top >= 15 && bounds.bottom <= bounds.height - 15, JSON.stringify(bounds));
      assert.equal(bounds.overflow, false);
      assert.equal(bounds.animation, 'none');
      await page.locator('#name-input').focus();
      await page.locator('#sekai-pass-login').focus();
      const controlBounds = await page.locator('#sekai-pass-login').evaluate(el => {
        const control = el.getBoundingClientRect();
        const dialog = el.closest('.name-chooser-content').getBoundingClientRect();
        return { top: control.top, bottom: control.bottom, dialogTop: dialog.top, dialogBottom: dialog.bottom };
      });
      assert.ok(controlBounds.top >= controlBounds.dialogTop && controlBounds.bottom <= controlBounds.dialogBottom,
        `keyboard focus scrolls the login action into view: ${JSON.stringify({ viewport, controlBounds })}`);
    }
  });

  await t.test('mobile navigation works by keyboard and hides closed controls from focus', async t => {
    const page = await fixture(t, { width: 390, height: 844 });
    await page.locator('#name-input').fill('访客');
    await page.locator('#name-input').press('Enter');
    const toggle = page.getByRole('button', { name: '切换成员列表' });
    assert.equal(await page.locator('.sidebar').evaluate(el => el.inert), true);
    await toggle.focus();
    await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.sidebar').evaluate(el => el.inert), false);
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'sidebar-toggle');
    assert.equal(await page.locator('.sidebar').evaluate(el => el.inert), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator('.sidebar').evaluate(el => el.inert), false);
  });

  await t.test('connection failures are visible and clear only once the room is ready', async t => {
    const page = await fixture(t);
    await page.locator('#name-input').fill('访客');
    await page.locator('#name-input').press('Enter');
    await page.evaluate(() => ui.eventBus.emit('room:joining'));
    assert.equal(await page.getByRole('status').textContent(), '正在连接…');
    await page.evaluate(() => ui.eventBus.emit('connection:error'));
    assert.equal(await page.getByRole('status').textContent(), '连接失败，正在重试…');
    await page.evaluate(() => ui.eventBus.emit('room:synced'));
    assert.equal(await page.locator('#connection-status').isVisible(), false);
    await page.evaluate(() => ui.eventBus.emit('connection:close'));
    assert.equal(await page.getByRole('status').textContent(), '连接中断，正在重试…');
  });

  await t.test('paste without clipboard data keeps the composer usable', async t => {
    const page = await fixture(t);
    await page.locator('#name-input').fill('访客');
    await page.locator('#name-input').press('Enter');
    await page.evaluate(() => ui.setupChatRoom(() => false));
    await page.locator('#messageInput').fill('保留草稿');
    await page.locator('#messageInput').dispatchEvent('paste');
    assert.equal(await page.locator('#messageInput').inputValue(), '保留草稿');
  });

  await t.test('sticker button keeps its picker open until a sticker is selected', async t => {
    const page = await fixture(t);
    await page.locator('#name-input').fill('访客');
    await page.locator('#name-input').press('Enter');
    await page.route('https://example.com/sticker.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>' }));
    await page.evaluate(() => {
      ui.stickerService = { getStickers: () => [{ code: 'airi_test', label: '测试贴纸', category: 'airi', url: 'https://example.com/sticker.png' }] };
      ui.setupChatRoom(() => false);
    });
    await page.locator('button[title="表情"]').click();
    const item = page.locator('.picker-grid-item');
    await item.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#messageInput').inputValue(), '[]');
    await item.click();
    assert.equal((await page.locator('#messageInput').inputValue()).trim(), '[airi_test]');
  });
});
