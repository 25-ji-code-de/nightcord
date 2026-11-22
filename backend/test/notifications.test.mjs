/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

test('notification routing, lifetime and responsive interaction', { timeout: 120_000 }, async t => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());

  async function fixture(t, options = {}) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    t.after(() => context.close());
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (url.origin === origin) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    if (options.blockStorage) await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
    });
    const errors = [];
    t.after(() => assert.deepEqual(errors, []));
    async function load(existing) {
      const page = existing || await context.newPage();
      if (!existing) page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(() => {
        window.ui = new UIManager(new EventBus());
        ui.setupChatRoom(() => {}, () => {});
        ui.setCurrentRoom('sidebar-test');
        window.features = new SidebarFeatures(ui);
        ui.sidebarFeatures = features;
        window.me = { id: 'sekai:one', displayName: 'Same name', authenticated: true };
        window.peer = { id: 'guest:two', displayName: 'Same name', authenticated: false };
        ui.eventBus.emit('session:updated', { user: me });
        ui.eventBus.emit('room:synced');
      });
      return page;
    }
    const page = await load();
    return { page, load, context };
  }

  await t.test('replies resolve before rendering; overlapping mentions produce one notice', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      ui.addChatMessage(me.displayName, 'My original message', 10, undefined, undefined, me);
      ui.eventBus.emit('message:received', { name: '奏', user: peer, message: '<$SEKAI:Reply::10> 收到，晚点一起看看。', timestamp: 11 });
    });
    assert.equal(await page.locator('.reply-notice').count(), 1);
    await page.locator('.reply-notice .sekai-notice__open').click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.timestamp), '11');
    await page.evaluate(() => {
      const message = '<$SEKAI:Reply::10> ' + ui.mentions.format({ id: me.id, name: me.displayName });
      const data = { name: '奏', user: peer, message, timestamp: 12 };
      ui.eventBus.emit('message:received', data);
      ui.eventBus.emit('message:received', data);
    });
    assert.equal(await page.locator('.mention-notice').count(), 1);
    assert.equal(await page.locator('.reply-notice').count(), 0);
    await page.evaluate(() => ui.eventBus.emit('session:updated', { user: peer }));
    assert.equal(await page.locator('.sekai-notice').count(), 0);
    for (const event of ['room:changed', 'session:unavailable', 'roster:clear', 'room:left']) {
      await page.evaluate(event => {
        ui.showReplyNotice({ name: '奏', message: '新回复', timestamp: 13, user: peer });
        ui.showMentionNotice({ name: '奏', message: '新提及', timestamp: 14, user: peer });
        ui.eventBus.emit(event, {});
      }, event);
      assert.equal(await page.locator('.sekai-notice').count(), 0, event);
    }
  });

  await t.test('previews keep spoilers hidden and replies remain actionable from a tool panel', async t => {
    const { page } = await fixture(t);
    for (const message of ['公开 ||不要提前看||', '<$SEKAI:Format:spoiler=true:不要提前看>', '<$SEKAI:Format:spoiler=true;enc=base64:c2VjcmV0>']) {
      await page.evaluate(message => ui.showMentionNotice({ name: '奏', message, timestamp: 20, user: peer }), message);
      const preview = await page.locator('.mention-notice .sekai-notice__preview').textContent();
      assert.match(preview, /剧透内容/);
      assert.doesNotMatch(preview, /不要提前看|secret/);
    }
    await page.evaluate(() => ui.clearNotices());
    await page.locator('#navigation-tasks').click();
    await page.evaluate(() => {
      ui.addChatMessage(me.displayName, '原文', 30, undefined, undefined, me);
      ui.eventBus.emit('message:received', { name: '奏', user: peer, message: '<$SEKAI:Reply::30> 回复', timestamp: 31 });
    });
    await page.locator('.reply-notice .sekai-notice__open').click();
    assert.equal(await page.locator('#sidebar-tools').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.timestamp), '31');
  });

  await t.test('reply lifetime pauses until both pointer and focus leave; dismissal restores focus', async t => {
    const { page } = await fixture(t);
    await page.clock.install();
    await page.locator('#messageInput').focus();
    await page.evaluate(() => ui.showReplyNotice({ name: '奏', message: '今晚再听一次吧。', timestamp: 20, user: peer }));
    const notice = page.locator('.reply-notice');
    await notice.hover();
    await notice.locator('.sekai-notice__open').focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(9000);
    assert.equal(await notice.count(), 1, 'leaving with the pointer must not dismiss a focused notice');
    await notice.hover();
    await page.locator('#messageInput').focus();
    await page.clock.runFor(9000);
    assert.equal(await notice.count(), 1, 'moving keyboard focus must not dismiss a hovered notice');
    await page.mouse.move(0, 0);
    await page.clock.runFor(8100);
    assert.equal(await notice.count(), 0);
    await page.evaluate(() => ui.showReplyNotice({ name: '奏', message: '新的回复', timestamp: 21, user: peer }));
    await notice.locator('.sekai-notice__close').focus();
    await page.keyboard.press('Escape');
    assert.equal(await notice.count(), 0);
    assert.equal(await page.locator('#messageInput').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => ui.notifications.replyTimerCleanup), null);
    assert.equal(await page.evaluate(() => ui.notifications.replyLift), null);
  });

  await t.test('notices fit narrow screens, align to chat and clear the resized composer', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      const data = { name: '一个很长的成员昵称'.repeat(4), message: '这是新消息的预览。可以先读完，再跳转到对话里继续回复。', timestamp: 30, user: peer };
      ui.showMentionNotice(data);
      ui.showReplyNotice(data);
    });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const notice = document.querySelector('.reply-notice').getBoundingClientRect();
        const main = document.querySelector('.main').getBoundingClientRect();
        const input = document.querySelector('.input-area').getBoundingClientRect();
        return Math.abs(notice.x + notice.width / 2 - main.x - main.width / 2) < 2 && notice.bottom <= input.top - 8;
      });
      for (const selector of ['.mention-notice', '.reply-notice']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0, selector);
        assert.equal(await page.locator(selector).evaluate(node => node.scrollWidth <= node.clientWidth), true, selector);
      }
      if (process.env.NIGHTCORD_REVIEW_ARTIFACTS) {
        await mkdir(process.env.NIGHTCORD_REVIEW_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: process.env.NIGHTCORD_REVIEW_ARTIFACTS + '/notices-' + viewport.width + '.png' });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#messageInput').fill('第一行\n第二行\n第三行\n第四行');
    await page.waitForFunction(() => document.querySelector('.reply-notice').getBoundingClientRect().bottom
      <= document.querySelector('.input-area').getBoundingClientRect().top - 8);
  });
});
