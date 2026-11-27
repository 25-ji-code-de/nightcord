/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { readBrowserScript } from '../../scripts/browser-source.mjs';

const root = new URL('../../', import.meta.url);
const scripts = ['purify.js', 'sekai-escape.js', 'performance-optimizer.js', 'event-bus.js',
  'ai-config.js', 'storage-manager.js', 'file-upload-service.js', 'sekai-renderer.js',
  'user-profile.js', 'ui-manager.js', 'js/services/roleplay.js', 'js/ui/roleplay.js'];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

test('role selector preserves drafts, focus, identity and space across desktop and mobile', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  async function fixture(t, viewport = { width: 1200, height: 900 }) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'roleplay.test') return route.fulfill({ status: 204, body: '' });
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      try {
        let body = await readFile(new URL(path, root));
        if (path === 'index.html') body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        await route.fulfill({ contentType: mime[extname(path)] || 'application/octet-stream', body });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://roleplay.test/');
    for (const file of scripts) await page.addScriptTag({ content: readBrowserScript(file) });
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus()); ui.currentRoom = Roleplay.ROOM_ID;
      window.roleplay = new Roleplay({ settings: localStorage, getRoom: () => ui.currentRoom });
      window.view = new RoleplayView(ui, roleplay);
      ui.elements.chatInput.value = '尚未发送的草稿';
    });
    return page;
  }
  const open = page => page.locator('.roleplay-trigger').click();
  const selected = page => page.evaluate(() => roleplay.active);
  const focused = page => page.evaluate(() => document.activeElement.className);

  await t.test('one compact control opens real portraits and switching leaves the draft intact', async t => {
    const page = await fixture(t);
    assert.equal(await page.locator('.roleplay-panel').isVisible(), false);
    assert.ok((await page.locator('.roleplay-bar').boundingBox()).height <= 52);
    await open(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.roleplay-defaults img')].every(img => img.complete && img.naturalWidth === 128));
    assert.equal(await page.locator('.roleplay-defaults img').count(), 4);
    for (const role of ['K', '雪', 'えななん', 'Amia']) {
      if (!await page.locator('.roleplay-panel').isVisible()) await open(page);
      await page.getByRole('button', { name: role, exact: true }).click();
      assert.equal(await selected(page), role);
      assert.equal(await page.locator('#messageInput').inputValue(), '尚未发送的草稿');
      assert.equal(await page.locator('#messageInput').getAttribute('placeholder'), `以 ${role} 的身份发言`);
      assert.equal(await page.locator('.roleplay-trigger').getAttribute('aria-expanded'), 'false');
      assert.equal(await focused(page), 'roleplay-trigger');
    }
    await open(page); await page.locator('.roleplay-option--self').click();
    assert.equal(await selected(page), null);
    assert.equal(await page.evaluate(() => roleplay.encode('hello')), 'hello');
  });

  await t.test('keyboard selection, layered Escape, composition and outside dismissal retain sensible focus', async t => {
    const page = await fixture(t);
    await page.locator('.roleplay-trigger').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.role), '');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
    assert.equal(await selected(page), 'K');
    await open(page); await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'Amia');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.role), '');
    await page.getByRole('button', { name: '添加角色', exact: true }).click();
    await page.locator('.roleplay-input').dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    assert.equal(await page.locator('.roleplay-form').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.roleplay-form').isVisible(), false);
    assert.equal(await focused(page), 'roleplay-add');
    await page.keyboard.press('Escape'); assert.equal(await focused(page), 'roleplay-trigger');
    await open(page); await page.locator('#messageInput').focus();
    assert.equal(await page.locator('.roleplay-panel').isVisible(), false);
    await open(page); await page.locator('#messages').click({ position: { x: 10, y: 10 } });
    assert.equal(await page.locator('.roleplay-panel').isVisible(), false);
  });

  await t.test('add validates inline, saves the chosen role, and removal restores self without losing focus', async t => {
    const page = await fixture(t);
    await open(page); await page.getByRole('button', { name: '添加角色', exact: true }).click();
    await page.getByLabel('角色名称', { exact: true }).fill('雪');
    await page.getByRole('button', { name: '添加并使用' }).click();
    assert.equal(await page.locator('.roleplay-error').textContent(), '已经有同名角色。');
    assert.equal(await page.locator('.roleplay-input').getAttribute('aria-invalid'), 'true');
    await page.locator('.roleplay-input').fill('我的自定义角色');
    await page.getByRole('button', { name: '添加并使用' }).click();
    assert.equal(await selected(page), '我的自定义角色');
    assert.equal(await page.evaluate(() => new Roleplay({ settings: localStorage, getRoom: () => ui.currentRoom }).active), '我的自定义角色');
    await open(page); await page.getByRole('button', { name: '删除角色 我的自定义角色' }).click();
    assert.equal(await selected(page), null);
    assert.equal(await focused(page), 'roleplay-add');
    assert.equal(await page.locator('.roleplay-custom').isVisible(), false);
    assert.equal(await page.locator('#messageInput').inputValue(), '尚未发送的草稿');
  });

  await t.test('all palettes, long names and a full custom list fit narrow and short viewports', async t => {
    const page = await fixture(t, { width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      roleplay.add('这是一个长度刚好十六个字的角色名');
      for (let i = roleplay.custom.length; i < 16; i++) roleplay.add(`自定义角色${i}`);
      roleplay.select(roleplay.custom[0]); view.renderRoles();
    });
    for (const palette of ['gray-purple', 'indigo', 'plum-orchid']) {
      await page.evaluate(palette => document.documentElement.dataset.palette = palette, palette);
      for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (!await page.locator('.roleplay-panel').isVisible()) await open(page);
        await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height
          && document.querySelector('.roleplay-panel').getBoundingClientRect().top >= 0, viewport);
        const panel = await page.locator('.roleplay-panel').boundingBox();
        assert.ok(panel.x >= 0 && panel.y >= 0, JSON.stringify({ panel, viewport }));
        assert.ok(panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('.roleplay-panel').evaluate(node => getComputedStyle(node).animationName), 'none');
      }
    }
    assert.equal(await page.locator('.roleplay-add').isDisabled(), true);
    await page.setViewportSize({ width: 375, height: 320 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => innerWidth === 375 && innerHeight === 320
      && document.querySelector('.roleplay-panel').getBoundingClientRect().top >= 0);
    const panel = await page.locator('.roleplay-panel').boundingBox();
    assert.ok(panel.y >= 0 && panel.y + panel.height <= 320);
    await page.locator('.roleplay-remove').last().click();
    assert.equal(await page.locator('.roleplay-add').isDisabled(), false);
    await page.getByRole('button', { name: '添加角色', exact: true }).click();
    await page.locator('.roleplay-input').fill('短屏添加');
    await page.getByRole('button', { name: '添加并使用' }).click();
    assert.equal(await selected(page), '短屏添加');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => { document.documentElement.dataset.roundedCorners = 'off'; document.documentElement.dataset.iosLayout = 'on'; });
    await open(page);
    assert.equal(await page.locator('.roleplay-panel').evaluate(node => getComputedStyle(node).borderRadius), '0px');
    for (const selector of ['.roleplay-trigger', '.roleplay-remove', '.roleplay-icon-button']) {
      const bounds = await page.locator(selector).first().boundingBox(); assert.ok(bounds.height >= 44);
    }
  });

  await t.test('room changes close the panel and restore the composer placeholder; destruction removes the control', async t => {
    const page = await fixture(t);
    await open(page); await page.getByRole('button', { name: '雪', exact: true }).click();
    await open(page);
    await page.evaluate(() => ui.eventBus.emit('room:left', {}));
    assert.equal(await page.locator('.roleplay-bar').isVisible(), false);
    assert.equal(await page.locator('#messageInput').getAttribute('data-roleplay-placeholder'), null);
    await page.evaluate(() => ui.eventBus.emit('room:joining', {}));
    assert.equal(await page.locator('.roleplay-bar').isVisible(), true);
    assert.equal(await page.locator('.roleplay-panel').isVisible(), false);
    assert.equal(await selected(page), '雪');
    await page.evaluate(() => view.destroy());
    assert.equal(await page.locator('.roleplay-bar').count(), 0);
    await page.locator('#messageInput').focus();
  });
});
