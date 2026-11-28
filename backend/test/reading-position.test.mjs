/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

test('reading bookmarks and new-message navigation', { timeout: 90_000 }, async t => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const file = resolve(root, '.' + new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html'));
      if (!file.startsWith(root + sep)) return res.writeHead(403).end();
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const settled = page => page.waitForFunction(() => !ui.messageBuild && !ui.messageRenderPending && ui.messageRenderFrame === null);
  async function initialize(page, seed = true) {
    await page.evaluate(seed => {
      window.ui = new UIManager(new EventBus()); ui.setupChatRoom(() => {}, () => {});
      window.me = { id: 'sekai:reader', displayName: '读者', authenticated: true };
      window.peer = { id: 'sekai:peer', displayName: '雪', authenticated: true };
      ui.eventBus.emit('session:updated', { user: me }); ui.setCurrentRoom('reading-test');
      ui.alerts.preferences.save(p => { p.sound = false; p.messageNotice = 'off'; });
      if (seed) {
        ui.messages = Array.from({ length: 100 }, (_, i) => ({ ...ui.createMessageData('雪', `消息 ${i + 1}`, 1700000000000 + i), profile: peer }));
        ui.storage.saveMessages(ui.currentRoom, ui.messages); ui.renderMessages();
      }
      ui.eventBus.emit('room:synced');
      window.incoming = timestamp => ui.eventBus.emit('message:received', { name: peer.displayName, user: peer, message: '新消息 ' + timestamp, timestamp });
    }, seed);
    await settled(page);
    await page.waitForFunction(() => { const log = ui.elements.chatlog; return log.scrollHeight - log.scrollTop - log.clientHeight < 2; });
  }
  async function fixture(t, { blocked = false, viewport = { width: 1280, height: 900 } } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport });
    t.after(() => context.close());
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      return url.origin === origin ? route.continue() : route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    if (blocked) await context.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
    await page.goto(origin); await initialize(page);
    return page;
  }
  async function readHistory(page) {
    await page.locator('#messages').evaluate(log => {
      log.dispatchEvent(new Event('wheel')); log.scrollTop = 600;
    });
    await page.waitForFunction(() => !ui.isAtBottom);
    await page.waitForFunction(() => ui.readingPosition.current?.timestamp < 1700000000090);
    await page.evaluate(() => ui.readingPosition.leave());
    return page.evaluate(() => ui.readingPosition.current);
  }

  await t.test('count appears only off the bottom, deduplicates arrivals and jumps to the first new message', async t => {
    const page = await fixture(t);
    await page.evaluate(() => incoming(1700000000100)); await settled(page);
    assert.equal(await page.locator('.chat-reading-new').isVisible(), false);
    await readHistory(page);
    const top = await page.locator('#messages').evaluate(log => log.scrollTop);
    await page.evaluate(() => {
      ui.alerts.preferences.save(p => { p.messageNotice = 'away'; });
      ui.lastUserActivityTime = Date.now() - 60_000;
      for (let i = 0; i < 30; i++) incoming(1700000000200 + i);
      incoming(1700000000200);
    });
    await settled(page);
    assert.equal(await page.locator('.chat-reading-new').textContent(), '30 条新消息');
    assert.equal(await page.locator('.chat-alert').count(), 0, 'the edge tab handles ordinary arrivals while reading history');
    assert.equal(await page.locator('.chat-unread').isVisible(), false);
    assert.equal(await page.locator('#messages').evaluate(log => log.scrollTop), top);
    await page.locator('.chat-reading-new').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => Number(document.activeElement?.dataset.timestamp) === 1700000000200);
    assert.equal(await page.locator('.chat-reading-new').isVisible(), false);
    assert.equal(await page.locator('.chat-unread').isVisible(), true);
    await page.locator('.chat-unread').click();
    await page.waitForFunction(() => ui.isAtBottom);
    assert.equal(await page.locator('.chat-unread').isVisible(), false);
  });

  await t.test('reload opens at latest and preserves the old bookmark until explicitly resumed', async t => {
    const page = await fixture(t);
    const saved = await readHistory(page);
    await page.reload(); await initialize(page, false);
    await page.locator('.chat-reading-resume').waitFor({ state: 'visible' });
    await page.waitForTimeout(260);
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem(ui.readingPosition.scope)));
    assert.equal(persisted.timestamp, saved.timestamp);
    assert.ok(Math.abs(persisted.offset - saved.offset) < 20, 'closing preserves the reading viewport');
    await page.reload(); await initialize(page, false);
    await page.locator('.chat-reading-resume').click();
    const position = await page.evaluate(() => ({ timestamp: Number(document.activeElement.dataset.timestamp), offset: Math.round(document.activeElement.getBoundingClientRect().top - ui.elements.chatlog.getBoundingClientRect().top) }));
    assert.equal(position.timestamp, saved.timestamp);
    assert.ok(Math.abs(position.offset - persisted.offset) <= 1);
    assert.equal(await page.locator('.chat-reading-resume').isVisible(), false);
  });

  await t.test('rooms and identities keep separate bookmarks and sidebar return starts at latest', async t => {
    const page = await fixture(t);
    const saved = await readHistory(page);
    await page.evaluate(() => ui.setCurrentRoom('empty')); await settled(page);
    assert.equal(await page.locator('.chat-reading-resume').isVisible(), false);
    await page.evaluate(() => ui.setCurrentRoom('reading-test')); await settled(page);
    await page.locator('.chat-reading-resume').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => ui.readingPosition.previous.timestamp), saved.timestamp);
    await page.evaluate(() => ui.eventBus.emit('session:updated', { user: { ...me, id: 'sekai:other' } })); await settled(page);
    assert.equal(await page.locator('.chat-reading-resume').isVisible(), false);
    await page.evaluate(() => ui.eventBus.emit('session:updated', { user: me })); await settled(page);
    await page.locator('.chat-reading-resume').waitFor({ state: 'visible' });
    await page.locator('.chat-reading-resume').click();
    await page.evaluate(() => { ui.sidebarFeatures = new SidebarFeatures(ui); ui.sidebarFeatures.open('search'); });
    assert.equal(await page.locator('.chat-reading-resume').isVisible(), false);
    await page.evaluate(() => ui.sidebarFeatures.close());
    await page.waitForFunction(() => ui.isAtBottom);
    await page.locator('.chat-reading-resume').waitFor({ state: 'visible' });
  });

  await t.test('blocked storage keeps an in-memory bookmark and removed history hides its shortcut', async t => {
    const page = await fixture(t, { blocked: true });
    await readHistory(page);
    await page.evaluate(() => { ui.readingPosition.leave(); ui.readingPosition.open(); });
    await page.locator('.chat-reading-resume').waitFor({ state: 'visible' });
    await page.evaluate(() => { ui.messages = []; ui.renderMessages(); }); await settled(page);
    assert.equal(await page.locator('.chat-reading-resume').isVisible(), false);
    assert.equal(await page.locator('.chat-unread').isVisible(), false);
  });

  await t.test('managed-room bookmarks load older pages and cancel a late jump after navigation', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
      ui.readingPosition.leave();
      window.roomHistory = Array.from({ length: 100 }, (_, i) => ({
        ...ui.createMessageData('雪', `房间消息 ${i + 1}`, 1700000010000 + i), profile: peer, seq: i + 1, replyKey: i + 1,
      }));
      const manager = { moreBefore: true, messages: new Map(roomHistory.slice(70).map(m => [m.seq, m])), calls: 0,
        async older() {
          this.calls++;
          if (window.delayOlder) await new Promise(resolve => { window.releaseOlder = resolve; });
          const first = Math.min(...this.messages.keys()), start = Math.max(0, first - 31);
          for (const message of roomHistory.slice(start, first - 1)) this.messages.set(message.seq, message);
          this.moreBefore = start > 0;
          ui.messages = [...this.messages.values()].sort((a, b) => a.seq - b.seq); ui.renderMessages();
        } };
      ui.managedChat = { manager }; ui.currentRoom = 'managed-reading';
      ui.messages = [...manager.messages.values()]; ui.renderMessages();
      localStorage.setItem(ui.readingPosition.key(), JSON.stringify({ timestamp: roomHistory[9].timestamp, seq: 10, offset: 12 }));
      ui.eventBus.emit('room:changed');
    });
    await settled(page);
    await page.locator('.chat-reading-resume').click();
    await page.waitForFunction(() => document.activeElement?.dataset.seq === '10');
    assert.equal(await page.evaluate(() => ui.managedChat.manager.calls), 3);
    await page.evaluate(() => {
      const manager = ui.managedChat.manager;
      manager.messages = new Map(roomHistory.slice(70).map(m => [m.seq, m])); manager.moreBefore = true;
      ui.messages = [...manager.messages.values()]; ui.renderMessages();
      ui.readingPosition.current = null; window.delayOlder = true;
      localStorage.setItem(ui.readingPosition.scope, JSON.stringify({ timestamp: roomHistory[9].timestamp, seq: 10, offset: 12 }));
      ui.readingPosition.open();
    });
    await settled(page); await page.locator('.chat-reading-resume').click();
    await page.waitForFunction(() => !!window.releaseOlder);
    await page.evaluate(() => { ui.sidebarFeatures = new SidebarFeatures(ui); ui.sidebarFeatures.open('search'); });
    const focus = await page.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.className);
    await page.evaluate(() => releaseOlder()); await settled(page);
    assert.equal(await page.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.className), focus);
    assert.equal(await page.locator('#sidebar-tools').isVisible(), true);
  });

  await t.test('both edge tabs fit phone and landscape without overlapping the composer', async t => {
    const page = await fixture(t, { viewport: { width: 375, height: 812 } });
    await readHistory(page);
    await page.evaluate(() => { ui.readingPosition.leave(); ui.readingPosition.open(); });
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#messages').evaluate(log => { log.dispatchEvent(new Event('wheel')); log.scrollTop = log.scrollHeight - log.clientHeight - 400; });
      await page.waitForFunction(() => !ui.isAtBottom);
      await page.evaluate(() => incoming(Date.now())); await settled(page);
      await page.locator('#messageInput').fill('一行草稿\n第二行\n第三行');
      for (const selector of ['.chat-reading-new', '.chat-reading-resume']) {
        await page.locator(selector).waitFor({ state: 'visible' });
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 48 && box.height >= 36);
      }
      const composer = await page.locator('.input-area').boundingBox();
      const newMessages = await page.locator('.chat-reading-new').boundingBox();
      assert.ok(newMessages.y + newMessages.height < composer.y);
      if (process.env.NIGHTCORD_SCREENSHOT_DIR) {
        await mkdir(process.env.NIGHTCORD_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.NIGHTCORD_SCREENSHOT_DIR, `reading-${viewport.width}.png`) });
      }
    }
  });
});
