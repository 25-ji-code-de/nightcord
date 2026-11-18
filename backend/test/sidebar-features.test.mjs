/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

test('sidebar tools use real chat state and preserve scoped preferences', { timeout: 120_000 }, async t => {
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
  const close = page => page.locator('.tools-back').click();
  const rows = page => page.locator('#sidebar-tools .tool-message');
  async function seed(page) {
    await page.evaluate(() => {
      const mention = ui.mentions.format({ type: 'user', id: me.id, name: me.displayName });
      const all = ui.mentions.format({ type: 'all', id: 'everyone' });
      for (const data of [
        { name: peer.displayName, user: peer, message: `needle ${mention}`, timestamp: new Date('2026-11-01T12:00:00').getTime() },
        { name: me.displayName, user: me, message: `self ${mention}`, timestamp: new Date('2026-11-02T12:00:00').getTime() },
        { name: 'Nako', user: null, sender: peer, isNako: true, message: `AI ${all}`, timestamp: new Date('2026-11-03T12:00:00').getTime() },
        { name: peer.displayName, user: peer, message: `everyone ${all}`, timestamp: new Date('2026-11-04T12:00:00').getTime() },
        { name: '<img onerror=alert(1)>', user: { ...peer, displayName: '<img onerror=alert(1)>' }, message: '<script>window.injected=true</script>', timestamp: new Date('2026-11-05T12:00:00').getTime() },
      ]) ui.eventBus.emit('message:received', data);
    });
    await page.locator('#messages .message').first().waitFor();
  }

  await t.test('search filters, safe previews, keyboard focus and original message jumps', async t => {
    const { page } = await fixture(t);
    await seed(page);
    assert.equal(await page.locator('.navigation-links > button:disabled').count(), 1);
    await page.locator('#messageInput').fill('Keep this draft');
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#tools-search-query').evaluate(node => node === document.activeElement), true);
    await page.locator('#tools-search-query').fill('needle');
    assert.equal(await rows(page).count(), 1);
    assert.equal(await page.locator('#tools-search-author').isVisible(), false);
    await page.locator('.tools-search-options summary').click();
    await page.locator('#tools-search-author').fill('sekai:one');
    assert.equal(await rows(page).count(), 0);
    await page.locator('#tools-search-author').fill('guest:two');
    assert.equal(await rows(page).count(), 1);
    await page.locator('#tools-search-after').fill('2026-11-02');
    assert.equal(await rows(page).count(), 0);
    await page.locator('#tools-search-before').fill('2026-11-01');
    assert.match(await page.locator('.tools-count').textContent(), /结束日期不能/);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    assert.equal(await rows(page).count(), 5);
    assert.equal(await page.locator('.tools-results img, .tools-results script').count(), 0);
    await page.locator('#tools-search-query').fill('needle');
    await page.locator('.tool-message-link').click();
    assert.equal(await page.locator('#sidebar-tools').isVisible(), false);
    assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
    assert.match(await page.locator('#messages .message-highlighted').textContent(), /needle/);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('message-highlighted')), true);
    await page.locator('#navigation-help').click();
    const helpQuery = page.locator('#tools-help-query');
    await page.getByText('法律条款', { exact: true }).click();
    const legal = page.locator('.tools-help details[open]');
    assert.deepEqual(await legal.getByRole('link').allTextContents(), ['用户协议', '隐私政策', '版权声明', '开源许可']);
    await helpQuery.fill('隐私政策');
    assert.equal(await legal.locator('summary').textContent(), '法律条款');
    assert.equal(await legal.getByRole('link', { name: '隐私政策' }).getAttribute('href'), 'https://docs.nightcord.de5.net/legal/complete/privacy-nightcord');
    await helpQuery.fill('disclaimer');
    assert.equal(await legal.locator('summary').textContent(), '免责声明');
    assert.equal(await legal.locator('p').last().innerText(), '使用本网站即表示您已阅读并同意上述条款。');
    assert.equal(await legal.getByRole('link', { name: 'GitHub Issues' }).isVisible(), true);
    await helpQuery.fill('附件');
    assert.equal(await page.locator('.tools-help summary').textContent(), '发送消息、表情与附件');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#navigation-help').evaluate(node => node === document.activeElement), true);
    await page.locator('#navigation-help').click();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#navigation-search').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => !!window.injected), false);
    await page.evaluate(() => {
      for (let index = 0; index < 55; index++) ui.addChatMessage('Pagination', `page ${index}`, Date.now() + index, undefined, undefined, peer);
    });
    await page.locator('#navigation-search').click();
    assert.equal(await rows(page).count(), 50);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    assert.equal(await rows(page).count(), 60);
    assert.equal(await page.evaluate(() => document.querySelector('.tools-results').children[50].contains(document.activeElement)), true);
    if (process.env.NIGHTCORD_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/sidebar-search.png` });
  });

  await t.test('inbox excludes self and AI, persists read state, syncs tabs and handles live mentions', async t => {
    const { page, load } = await fixture(t);
    await seed(page);
    await page.waitForFunction(() => document.querySelector('.navigation-badge').textContent === '2');
    await page.locator('#navigation-inbox').click();
    assert.equal(await rows(page).count(), 2);
    await page.getByRole('button', { name: '全部标为已读' }).click();
    assert.equal(await page.locator('.navigation-badge').isVisible(), false);
    await page.getByRole('button', { name: '标为未读', exact: true }).first().click();
    await page.getByRole('button', { name: '只看未读', exact: true }).click();
    assert.equal(await rows(page).count(), 1);
    await load(page);
    await page.waitForFunction(() => document.querySelector('.navigation-badge').textContent === '1');
    const tab = await load();
    await page.locator('#navigation-inbox').click();
    await page.getByRole('button', { name: '全部标为已读' }).click();
    await tab.waitForFunction(() => document.querySelector('.navigation-badge').hidden);
    await page.evaluate(() => {
      const data = { name: peer.displayName, user: peer, message: '@everyone live', timestamp: Date.now() };
      ui.eventBus.emit('message:received', data); ui.eventBus.emit('message:received', data);
    });
    await page.waitForFunction(() => document.querySelector('.navigation-badge').textContent === '1');
    assert.equal(await rows(page).count(), 3);
    await page.evaluate(() => ui.eventBus.emit('session:updated', { user: peer }));
    await page.waitForFunction(() => document.querySelector('.tools-count').textContent.includes('0 条提醒'));
    assert.equal(await rows(page).count(), 0);
  });

  await t.test('tasks edit, complete, undo, reload and isolate by room and identity', async t => {
    const { page, load } = await fixture(t);
    await page.locator('#navigation-tasks').click();
    await page.getByLabel('任务标题', { exact: true }).fill('Review <img onerror=alert(1)>');
    await page.getByLabel('截止日期（可选）', { exact: true }).fill('2026-01-01');
    await page.getByRole('button', { name: '添加任务', exact: true }).click();
    assert.match(await page.locator('.tool-task-date').textContent(), /已逾期/);
    assert.equal(await page.locator('.tool-task img').count(), 0);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('任务标题', { exact: true }).fill('Ship sidebar');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.locator('.tool-task input[type=checkbox]').check();
    await page.getByRole('button', { name: '未完成', exact: true }).click();
    assert.equal(await page.locator('.tool-task').count(), 0);
    await page.getByRole('button', { name: '已完成', exact: true }).click();
    assert.equal(await page.locator('.tool-task').count(), 1);
    await page.getByRole('button', { name: '删除任务：Ship sidebar' }).click();
    assert.equal(await page.locator('.tool-task').count(), 0);
    await page.getByRole('button', { name: '撤销删除', exact: true }).click();
    await load(page);
    await page.locator('#navigation-tasks').click();
    assert.equal(await page.locator('.tool-task-title').textContent(), 'Ship sidebar');
    assert.equal(await page.locator('.tool-task input').isChecked(), true);
    await page.locator('.tool-task input').uncheck();
    const tab = await load();
    await tab.locator('#navigation-tasks').click();
    assert.equal(await tab.locator('.tool-task input').isChecked(), false);
    await page.evaluate(() => ui.setCurrentRoom('another-room'));
    await page.waitForFunction(() => document.querySelectorAll('.tool-task').length === 0);
    await page.evaluate(() => ui.setCurrentRoom('sidebar-test'));
    await page.waitForFunction(() => document.querySelectorAll('.tool-task').length === 1);
    await page.evaluate(() => ui.eventBus.emit('session:updated', { user: peer }));
    await page.waitForFunction(() => document.querySelectorAll('.tool-task').length === 0);
    await page.evaluate(() => ui.setSessionUnavailable());
    await page.waitForFunction(() => document.querySelector('#tools-task-title').disabled);
  });

  await t.test('blocked storage keeps edits in memory and warns instead of losing them', async t => {
    const { page } = await fixture(t, { blockStorage: true });
    await page.locator('#navigation-tasks').click();
    await page.getByLabel('任务标题', { exact: true }).fill('Unsaved task');
    await page.getByRole('button', { name: '添加任务', exact: true }).click();
    assert.match(await page.locator('.tools-warning').textContent(), /当前页面保留/);
    await close(page); await page.locator('#navigation-tasks').click();
    assert.equal(await page.locator('.tool-task-title').textContent(), 'Unsaved task');
  });

  await t.test('inbox retention keeps the newest read flags when more mentions arrive', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      ui.messages = Array.from({ length: 2000 }, (_, index) => ({ user: peer.displayName, profile: peer, text: '@everyone', timestamp: 10000 + index }));
      ui.eventBus.emit('room:synced');
    });
    await page.locator('#navigation-inbox').click();
    await page.getByRole('button', { name: '全部标为已读' }).click();
    await page.evaluate(() => {
      ui.messages.push({ user: peer.displayName, profile: peer, text: '@everyone new', timestamp: 12000 });
      ui.eventBus.emit('room:synced');
    });
    await page.waitForFunction(() => document.querySelector('.navigation-badge').textContent === '1');
    await page.getByRole('button', { name: '全部标为已读' }).click();
    assert.equal(await page.locator('.navigation-badge').isVisible(), false);
    assert.equal(await page.evaluate(() => Object.keys(features.read().read).length), 2000);
  });

  await t.test('integrated navigation preserves chat draft and position, and notices return to the message', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      for (let i = 0; i < 60; i++) ui.addChatMessage(peer.displayName, `Chat line ${i}`, Date.now() + i, undefined, undefined, peer);
    });
    await page.waitForFunction(() => ui.messageIndex.size >= 60);
    await page.locator('#messageInput').fill('Keep my draft');
    const before = await page.locator('#messages').evaluate(node => { node.scrollTop = 200; return node.scrollTop; });
    await page.locator('#navigation-tasks').click();
    assert.equal(await page.locator('#messages').isVisible(), false);
    assert.equal(await page.locator('#navigation-help').isVisible(), true);
    await page.locator('#navigation-help').click();
    assert.equal(await page.locator('.navigation-item[aria-current="page"]').count(), 1);
    await page.locator('.tools-back').click();
    assert.equal(await page.locator('#messages').evaluate(node => node.scrollTop), before);
    assert.equal(await page.locator('#messageInput').inputValue(), 'Keep my draft');
    await page.locator('#navigation-search').click();
    await page.locator('#navigation-chat').click();
    assert.equal(await page.locator('#messages').evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 2), true);
    await page.locator('#navigation-tasks').click();
    await page.evaluate(() => ui.eventBus.emit('message:received', { name: peer.displayName, user: peer, message: '@everyone view this', timestamp: Date.now() + 1000 }));
    await page.locator('.mention-notice button').first().click();
    assert.equal(await page.locator('#messages').isVisible(), true);
    assert.match(await page.evaluate(() => document.activeElement.textContent), /view this/);
  });

  await t.test('mobile views stay on screen, reopen navigation and return to chat', async t => {
    const { page } = await fixture(t, { viewport: { width: 375, height: 667 } });
    await seed(page);
    await page.locator('.sidebar-toggle').click();
    await page.locator('#navigation-search').click();
    await page.locator('#tools-search-query').fill('needle');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#sidebar-tools').contains(document.activeElement)), true);
    const checkWidth = async () => assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('#sidebar-tools'); const rect = dialog.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
    }), true);
    await checkWidth();
    if (process.env.NIGHTCORD_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/sidebar-mobile.png` });
    await page.setViewportSize({ width: 667, height: 375 }); await checkWidth();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sidebar-toggle').evaluate(node => node === document.activeElement), true);
    await page.locator('.sidebar-toggle').click();
    await page.locator('#navigation-search').click();
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    assert.equal(await page.locator('.sidebar').evaluate(node => node.classList.contains('show')), true);
    assert.equal(await page.locator('.tools-menu').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sidebar-tools').isVisible(), true);
    assert.equal(await page.locator('.tools-menu').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.tools-menu').getAttribute('aria-expanded'), 'false');
    await page.locator('.tools-menu').click();
    await page.locator('.navigation-scrim').click({ position: { x: 650, y: 50 } });
    assert.equal(await page.locator('.tools-menu').evaluate(node => node === document.activeElement), true);
    await page.locator('.tools-menu').click();
    await page.locator('#navigation-inbox').click();
    await page.locator('.tool-message-link').first().click();
    assert.equal(await page.locator('.sidebar').evaluate(node => node.classList.contains('show')), false);
    assert.equal(await page.locator('.main').evaluate(node => node.inert), false);
  });

  if (process.env.NIGHTCORD_SCREENSHOT_DIR) {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      ui.elements.roomName.textContent = '作业';
      const people = ['K', '雪', 'えななん', 'Amia'].map((displayName, index) => ({ id: `sekai:member-${index}`, displayName, authenticated: true }));
      ui.eventBus.emit('session:updated', { user: people[0] });
      for (const user of people) ui.eventBus.emit('user:joined', { user, username: user.displayName });
      const lines = ['新曲的 demo 放在这里了，副歌的和声还想再调整一下。', '@K 我听完了，第二段进来的时候可以再留一点空白。', '封面试了两个版本，等下发过来。', '@K 今晚一起听一遍吧，我把参考也整理好了。', '好，那就 25 点见。'];
      lines.forEach((text, index) => ui.addChatMessage(people[index % 4].displayName, text, Date.now() - (5 - index) * 180000, undefined, undefined, people[index % 4]));
      features.save(state => { state.tasks = [
        { id: 'demo', title: '调整副歌的和声', due: '2026-11-18', done: false },
        { id: 'cover', title: '确认封面的最终版本', due: '', done: false },
        { id: 'listen', title: '整理今晚一起听的参考曲', due: '', done: true },
      ]; });
    });
    for (const kind of ['search', 'inbox', 'tasks', 'help']) {
      await page.locator(`#navigation-${kind}`).click();
      await page.screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/nightcord-${kind}-desktop.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const kind of ['search', 'inbox', 'tasks', 'help']) {
      await page.evaluate(kind => features.open(kind), kind);
      await page.screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/nightcord-${kind}-mobile.png` });
    }
  }
});
