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
  // CI runners are slower; allow more time for browser actions there.
  const actionTimeout = Number(process.env.NIGHTCORD_ACTION_TIMEOUT || (process.env.CI ? 60_000 : 30_000));
  assert.ok(Number.isFinite(actionTimeout) && actionTimeout > 0, 'NIGHTCORD_ACTION_TIMEOUT must be a positive finite number');

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
      page.setDefaultTimeout(actionTimeout);
      page.setDefaultNavigationTimeout(actionTimeout);
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

  await t.test('system notices stay in chat without persisting or advancing history', async t => {
    const { page } = await fixture(t);
    const timestamp = 1700000012345;
    const ready = () => page.evaluate(timestamp => ui.eventBus.emit('room:ready', {
      roomname: 'sidebar-test', messages: [{ user: 'Reader', text: 'server message', timestamp }]
    }), timestamp);
    await ready();
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 4);
    assert.match(await page.locator('#messages').innerText(), /欢迎来到聊天室: sidebar-test/);
    assert.equal(await page.evaluate(() => ui.storage.getLastMsgTimestamp('sidebar-test')), timestamp);
    await page.evaluate(() => ui.eventBus.emit('message:notice', { message: 'command completed' }));
    await page.locator('#messages').getByText('command completed', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => ui.storage.loadMessages('sidebar-test').some(message => message.user === '系统')), false);
    assert.equal(await page.evaluate(() => ui.storage.getLastMsgTimestamp('sidebar-test')), timestamp);
    await ready();
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 4);
    assert.equal(await page.locator('#messages').getByText('欢迎来到聊天室: sidebar-test', { exact: true }).count(), 1);
  });

  await t.test('empty history and cached system notices cannot advance the room cursor', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => ui.eventBus.emit('room:ready', { roomname: 'sidebar-test' }));
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 3);
    assert.equal(await page.locator('#messages .message').count(), 3);
    assert.equal(await page.evaluate(() => ui.storage.getLastMsgTimestamp('sidebar-test')), 0);
    const timestamp = 1700000012345;
    await page.evaluate(timestamp => {
      ui.storage.saveMessages('sidebar-test', [
        { user: 'Reader', text: 'cached message', timestamp },
        { user: '系统', text: 'stale welcome', timestamp: timestamp + 10000 }
      ]);
      ui.eventBus.emit('room:ready', { roomname: 'sidebar-test' });
    }, timestamp);
    await page.locator('#messages').getByText('cached message', { exact: true }).waitFor();
    assert.equal(await page.locator('#messages .message').count(), 4);
    assert.equal(await page.locator('#messages').getByText('stale welcome', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => ui.storage.getLastMsgTimestamp('sidebar-test')), timestamp);
    assert.equal(await page.locator('#messages .message').filter({ hasText: '警告:' }).locator('.bg-red-600').count(), 1);
  });

  await t.test('a navigation toggle outside the chat header opens the drawer and restores focus', async t => {
    const { page } = await fixture(t, { viewport: { width: 375, height: 667 } });
    await page.evaluate(() => ui.elements.main.prepend(document.querySelector('.sidebar-toggle')));
    const toggle = page.locator('.sidebar-toggle');
    await toggle.locator('svg').click();
    assert.equal(await page.evaluate(() => ui.isNavigationDrawerOpen()), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.main').evaluate(node => node.inert), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => ui.isNavigationDrawerOpen()), false);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    await toggle.press('Enter');
    assert.equal(await page.evaluate(() => ui.isNavigationDrawerOpen()), true);
    await page.locator('#navigation-members').click();
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.main').evaluate(node => node.inert), false);
  });

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

  const taskButton = (page, name) => page.getByRole('button', {name, exact:true});
  async function order(page, title, due) {
    await taskButton(page, '添加任务').click();
    await page.getByLabel('任务标题', {exact:true}).fill(title);
    if (due) await page.getByLabel('截止日期（可选）', {exact:true}).fill(due);
    await taskButton(page, '交印').click();
  }

  await t.test('entry terminal previews pending text and sends it to the separate printer', async t => {
    const {page} = await fixture(t);
    await page.locator('#navigation-tasks').click();
    assert.equal(await page.locator('.task-printer button').count(), 0);
    await taskButton(page, '添加任务').click();
    const preview = page.getByRole('region', {name:'待印内容'});
    await page.getByLabel('任务标题', {exact:true}).fill('写副歌 <img src=x>');
    await page.getByLabel('截止日期（可选）', {exact:true}).fill('2026-12-01');
    await page.locator('.task-options summary').click();
    await page.getByLabel('操作人', {exact:true}).fill('K');
    await page.getByLabel('清单（每行一项）').fill('和声\n导出');
    assert.match(await preview.innerText(), /写副歌 <img src=x>/);
    assert.match(await preview.innerText(), /K/);
    assert.match(await preview.innerText(), /截止 2026-12-01/);
    assert.deepEqual(await preview.locator('li').allTextContents(), ['和声', '导出']);
    assert.equal(await preview.locator('img').count(), 0);
    await page.getByLabel('红单 · 贴条').check();
    assert.equal(await preview.locator('li').count(), 0);
    assert.doesNotMatch(await preview.innerText(), /截止/);
    await page.getByLabel('黑单 · 任务').check();
    assert.equal(await preview.locator('li').count(), 2);
    await taskButton(page, '交印').click();
    assert.match(await page.locator('.printer-mouth').innerText(), /写副歌 <img src=x>/);
    assert.equal(await page.locator('.order-pad').isVisible(), false);
    await taskButton(page, '添加任务').click();
    assert.match(await page.locator('.order-terminal-state').innerText(), /待取单/);
    await taskButton(page, '取单上轨').click();
    assert.match(await page.locator('.order-terminal-state').innerText(), /就绪/);
  });

  await t.test('terminal geometry stays fixed across paper modes, expanded fields and long content', async t => {
    const {page} = await fixture(t);
    await page.locator('#navigation-tasks').click();
    const geometry = () => page.locator('.order-pad').evaluate(form => {
      const origin = form.getBoundingClientRect();
      return [form, ...form.querySelectorAll('.order-terminal-screen, .order-display, .order-entry, .order-keyboard')].map(node => {
        const rect = node.getBoundingClientRect();
        return [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height];
      });
    });
    for (const [width,height] of [[1280,900],[390,844],[320,640],[667,375]]) {
      await page.setViewportSize({width,height});
      await taskButton(page, '添加任务').click();
      const initial = await geometry();
      await page.locator('.task-options summary').click();
      await page.getByLabel('任务标题', {exact:true}).fill('很长的任务标题'.repeat(20));
      await page.getByLabel('清单（每行一项）').fill(Array.from({length:30}, (_,i) => `清单项目 ${i}`).join('\n'));
      assert.deepEqual(await geometry(), initial, `expanded black sheet at ${width}`);
      await page.getByLabel('红单 · 贴条').check();
      assert.deepEqual(await geometry(), initial, `red sheet at ${width}`);
      await page.getByLabel('黑单 · 任务').check();
      assert.deepEqual(await geometry(), initial, `restored black sheet at ${width}`);
      assert.equal(await page.getByLabel('任务标题', {exact:true}).inputValue(), '很长的任务标题'.repeat(20));
      assert.ok(await page.locator('.order-entry').evaluate(node => node.scrollHeight > node.clientHeight));
      assert.ok(await page.locator('.order-display').evaluate(node => node.scrollHeight > node.clientHeight));
      assert.ok(await page.locator('.order-terminal-screen').evaluate(screen => {
        const bounds=screen.getBoundingClientRect(), keys=screen.querySelector('.order-keyboard').getBoundingClientRect();
        return keys.bottom <= bounds.bottom && keys.top > bounds.top;
      }));
      assert.ok(await page.locator('.tools-body').evaluate(node => node.scrollWidth <= node.clientWidth));
      await taskButton(page, '收起').click();
    }
  });

  await t.test('paper remains in its device across reloads, and only time on the rail counts', async t => {
    const {page, load} = await fixture(t);
    const at = minute => page.clock.setFixedTime(new Date(Date.UTC(2026,10,18,8,minute)));
    const action = name => taskButton(page, name).click();
    await page.locator('#navigation-tasks').click();
    await at(0); await order(page,'做小样 <img>','2026-01-01');
    assert.equal(await page.locator('.tool-task').count(), 0);
    assert.match(await page.locator('.printer-mouth').innerText(), /#001/);
    await load(page); await page.locator('#navigation-tasks').click();
    await at(5); await action('取单上轨');
    assert.match(await page.locator('.tool-task-date').textContent(), /已逾期/);
    assert.equal(await page.locator('.tool-task img').count(), 0);
    await action('编辑');
    await page.getByLabel('任务标题', {exact:true}).fill('做小样');
    await page.getByLabel('操作人', {exact:true}).fill('K');
    await page.getByLabel('清单（每行一项）').fill('和声\n导出');
    await action('保存修改');
    await page.getByLabel('和声', {exact:true}).check();
    await at(20); await page.locator('.ticket-head').dragTo(page.locator('.task-clock'));
    assert.match(await page.locator('.clock-throat').innerText(), /15 分/);
    assert.equal(await page.locator('.tool-task').count(), 0);
    await load(page); await page.locator('#navigation-tasks').click();
    await action('取回挂单');
    await action('未完成'); assert.equal(await page.locator('.tool-task').count(), 0);
    await action('已完成'); assert.equal(await page.locator('.tool-task').count(), 1);
    await at(40); await action('再次开工');
    await at(50); await action('送入打卡钟');
    assert.match(await page.locator('.clock-throat .card-total').textContent(), /25 分/);
    await action('收入抽屉'); await page.locator('.file-drawer summary').first().click();
    assert.equal(await page.getByLabel('和声', {exact:true}).isChecked(), true);
    await action('取出并重新计时');
    await action('删除任务：做小样'); await action('撤销删除');
    assert.equal(await page.locator('.tools-results .tool-task-title').innerText(), '做小样');
    const tab = await load(); await tab.locator('#navigation-tasks').click();
    assert.equal(await tab.locator('.tool-task-title').innerText(), '做小样');
    await page.evaluate(() => ui.setCurrentRoom('another-room'));
    await page.waitForFunction(() => !document.querySelector('.tool-task'));
    await page.evaluate(() => ui.setCurrentRoom('sidebar-test'));
    await page.waitForFunction(() => !!document.querySelector('.tool-task'));
    await page.evaluate(() => ui.eventBus.emit('session:updated',{user:peer}));
    await page.waitForFunction(() => !document.querySelector('.tool-task'));
    await page.evaluate(() => ui.setSessionUnavailable());
    await page.waitForFunction(() => document.querySelector('.task-pad-toggle').disabled);
  });

  await t.test('legacy work orders keep unknown times, single-device capacity and small widths', async t => {
    const {page} = await fixture(t);
    await page.evaluate(() => features.save(s => { s.tasks = [{id:'old',title:'旧任务',done:true}]; }));
    await page.locator('#navigation-tasks').click();
    assert.equal(await page.locator('.tool-task time').count(), 0);
    await order(page,'A'.repeat(200)); await order(page,'B');
    assert.match(await page.locator('.task-station-notice').innerText(), /待取/);
    await taskButton(page,'取单上轨').click();
    await taskButton(page,'交印').click();
    assert.match(await page.locator('.printer-mouth').innerText(), /#002/);
    await taskButton(page,'取单上轨').click();
    const tickets = page.locator('.tools-results .tool-task');
    await tickets.nth(1).getByRole('button',{name:'前移一位'}).click();
    assert.equal(await tickets.first().locator('.tool-task-title').innerText(), 'A'.repeat(200));
    await tickets.first().getByRole('button',{name:'送入打卡钟'}).press('Enter');
    await tickets.first().getByRole('button',{name:'送入打卡钟'}).click();
    assert.match(await page.locator('.task-station-notice').innerText(), /先取回/);
    for (const [width,height] of [[320,640],[375,667],[667,375],[1024,768]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.locator('.tools-body').evaluate(node => node.scrollWidth <= node.clientWidth));
    }
  });

  await t.test('blocked storage retains both output and hanging tickets in memory', async t => {
    const {page} = await fixture(t,{blockStorage:true});
    await page.locator('#navigation-tasks').click(); await order(page,'Unsaved task');
    assert.match(await page.locator('.tools-warning').textContent(), /当前页面保留/);
    await close(page); await page.locator('#navigation-tasks').click(); await taskButton(page,'取单上轨').click();
    assert.equal(await page.locator('.tool-task-title').textContent(),'Unsaved task');
  });

  await t.test('red slips print independently, persist, attach by drag or click and can be moved', async t => {
    const {page, load} = await fixture(t);
    await page.locator('#navigation-tasks').click();
    await order(page, '写副歌'); await taskButton(page, '取单上轨').click();
    await order(page, '画封面'); await taskButton(page, '取单上轨').click();
    await taskButton(page, '添加任务').click();
    await page.getByLabel('红单 · 贴条').check();
    await page.getByLabel('红单内容', {exact:true}).fill('改用第二版 <img src=x>');
    await taskButton(page, '交印').click();
    assert.equal(await page.locator('.printer-mouth .red-slip').count(), 1);
    assert.equal(await page.locator('.tool-task').count(), 2);
    await load(page); await page.locator('#navigation-tasks').click();
    await page.locator('.printer-mouth .red-slip').dragTo(page.locator('.tool-task').first().locator('.kitchen-ticket'));
    assert.match(await page.locator('.tool-task').first().locator('.ticket-amendment').innerText(), /改用第二版/);
    assert.equal(await page.locator('.ticket-amendment img').count(), 0);
    assert.equal(await page.locator('.printer-mouth .red-slip').count(), 0);
    await page.getByRole('button', {name:'取下红单：改用第二版 <img src=x>',exact:true}).click();
    await page.getByRole('button', {name:'选择这张红单',exact:true}).click();
    await page.locator('.tool-task').nth(1).getByRole('button', {name:'贴在这里'}).click();
    await load(page); await page.locator('#navigation-tasks').click();
    assert.equal(await page.locator('.tool-task').nth(1).locator('.ticket-amendment').count(),1);
    assert.equal(await page.locator('.tool-task').first().locator('.ticket-amendment').count(),0);
    assert.equal(await page.locator('.tool-task details').count(),0);
    assert.equal(await page.locator('.tool-task .time-card').count(),2);
    await page.evaluate(() => ui.setCurrentRoom('other-room'));
    await page.waitForFunction(() => !document.querySelector('.tool-task'));
    assert.equal(await page.locator('.red-slip').count(),0);
  });

  await t.test('continuous rail pans, supports keyboard and keeps its position on chat refresh', async t => {
    const {page} = await fixture(t);
    await page.evaluate(() => features.save(state => {
      state.tasks = Array.from({length:8}, (_,i) => ({id:'rail-'+i,number:i+1,title:'任务 '+i,done:false}));
    }));
    await page.locator('#navigation-tasks').click();
    const rail = page.locator('.tools-results');
    assert.equal(await rail.locator('.tool-task').count(),8);
    const grip = page.locator('.rail-grip');
    const box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width * .75, box.y + box.height/2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .25, box.y + box.height/2,{steps:8});
    await page.mouse.up();
    const scrolled = await rail.evaluate(node => node.scrollLeft);
    assert.ok(scrolled > 100);
    await page.evaluate(() => ui.eventBus.emit('message:received', {name:peer.displayName,user:peer,message:'刷新',timestamp:Date.now()}));
    assert.equal(await rail.evaluate(node => node.scrollLeft),scrolled);
    await rail.focus(); await page.keyboard.press('End');
    assert.ok(await rail.evaluate(node => Math.abs(node.scrollWidth - node.clientWidth - node.scrollLeft) < 2));
    await page.keyboard.press('Home');
    assert.equal(await rail.evaluate(node => node.scrollLeft),0);
    await taskButton(page,'向右转动轨道').click();
    assert.ok(await rail.evaluate(node => node.scrollLeft > 0));
    for (const [width,height] of [[320,640],[375,667],[667,375]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.locator('.tools-body').evaluate(node => node.scrollWidth <= node.clientWidth));
      assert.equal(await rail.locator('.tool-task').count(),8);
    }
    await page.setViewportSize({width:1280,height:900});
    await rail.focus(); await page.keyboard.press('Home');
    await rail.locator('.ticket-hanger').first().dragTo(page.locator('.task-clock'));
    assert.equal(await page.locator('.clock-throat .tool-task-title').innerText(), '任务 0');
    assert.equal(await page.locator('.clock-throat .ticket-hanger').count(), 0);
    await taskButton(page, '取回挂单').click();
    assert.equal(await rail.locator('[data-task="rail-0"] .ticket-hanger').count(), 1);
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

  await t.test('Escape respects composition and consumed keys, then closes one navigation layer', async t => {
    const { page } = await fixture(t, { viewport: { width: 375, height: 667 } });
    await page.locator('.sidebar-toggle').click();
    await page.locator('#navigation-search').click();
    const sendIgnoredEscape = () => page.evaluate(() => {
      const target = document.activeElement;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
      const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      consumed.preventDefault();
      target.dispatchEvent(consumed);
    });
    await sendIgnoredEscape();
    assert.equal(await page.locator('#sidebar-tools').isVisible(), true);
    await page.locator('.tools-menu').click();
    await sendIgnoredEscape();
    assert.equal(await page.evaluate(() => ui.isNavigationDrawerOpen()), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => ui.isNavigationDrawerOpen()), false);
    assert.equal(await page.locator('#sidebar-tools').isVisible(), true);
    assert.equal(await page.locator('.tools-menu').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sidebar-tools').isVisible(), false);
    assert.equal(await page.locator('.sidebar-toggle').evaluate(node => node === document.activeElement), true);
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
    // Wait for both the requested viewport and the resulting panel layout.
    const checkWidth = async () => {
      await page.waitForFunction(width => {
        const dialog = document.querySelector('#sidebar-tools');
        const rect = dialog.getBoundingClientRect();
        return innerWidth === width && rect.width > 0 && rect.left >= 0
          && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
      }, page.viewportSize().width);
    };
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
    // The tool panel was already visible underneath the drawer; wait for the
    // actual dismissal and focus return, not that unchanged visibility state.
    await page.waitForFunction(() => {
      const toggle = document.querySelector('.tools-menu');
      return toggle === document.activeElement && toggle.getAttribute('aria-expanded') === 'false';
    });
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
        { id: crypto.randomUUID(), number: 3, title: '调整副歌的和声', operator: 'K', due: '2026-11-18', done: false, createdAt: Date.now() - 1800000, startedAt: Date.now() - 1800000, items: [{text:'导出试听版', checked:false}] },
        { id: crypto.randomUUID(), number: 2, title: '确认封面的最终版本', operator: 'えななん', due: '', done: false, createdAt: Date.now() - 3600000, startedAt: Date.now() - 3600000, notes: [{text:'沿用第二版配色', at:Date.now()}] },
        { id: crypto.randomUUID(), number: 1, title: '整理今晚一起听的参考曲', operator: '雪', due: '', done: true, createdAt: Date.now() - 7200000, completedAt: Date.now() - 600000, sessions:[{start:Date.now() - 2400000, end:Date.now() - 600000}] },
      ]; });
    });
    for (const kind of ['search', 'inbox', 'tasks', 'help']) {
      await page.locator(`#navigation-${kind}`).click();
      await page.screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/nightcord-${kind}-desktop.png` });
      if (kind === 'tasks') {
        const completed = page.locator('.tool-task').last();
        await completed.locator('.time-card').screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/time-card.png` });
        await completed.locator('.task-sheet').screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/task-card.png` });
        await page.locator('.kitchen-ticket').first().screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/kitchen-ticket.png` });
        await page.locator('.tools-results').evaluate(node => {node.scrollLeft = 0;});
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const kind of ['search', 'inbox', 'tasks', 'help']) {
      await page.evaluate(kind => features.open(kind), kind);
      await page.screenshot({ path: `${process.env.NIGHTCORD_SCREENSHOT_DIR}/nightcord-${kind}-mobile.png` });
    }
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(() => features.open('tasks'));
    await taskButton(page, '添加任务').click();
    await page.getByLabel('红单 · 贴条').check();
    await page.getByLabel('红单内容',{exact:true}).fill('第二段留一点空白，晚些一起听。');
    await page.screenshot({path:`${process.env.NIGHTCORD_SCREENSHOT_DIR}/red-slip-form.png`});
    await taskButton(page, '交印').click();
    await taskButton(page, '取下红单').click();
    await page.screenshot({path:`${process.env.NIGHTCORD_SCREENSHOT_DIR}/red-slip-ready.png`});
  }
});
