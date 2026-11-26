/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

test('chat notifications, preferences, presence and multiple tabs', { timeout: 120_000 }, async t => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) return res.writeHead(403).end();
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());

  async function fixture(t, { viewport = { width: 1280, height: 900 }, blocked = false } = {}) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
    t.after(() => context.close());
    const errors = []; t.after(() => assert.deepEqual(errors, []));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (url.origin === origin) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await context.addInitScript(({ blocked }) => {
      window.played = [];
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.src.includes('se_notify_')) window.played.push(this.src.split('/').at(-1));
        if (window.denyAudio) return Promise.reject(new DOMException('Interaction required', 'NotAllowedError'));
        return window.realAudio ? originalPlay.call(this) : Promise.resolve();
      };
      if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    }, { blocked });
    async function pageFor() {
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(() => {
        window.ui = new UIManager(new EventBus()); ui.setupChatRoom(() => {}, () => {}); ui.setCurrentRoom('alerts-test');
        ui.sidebarFeatures = new SidebarFeatures(ui);
        window.me = { id: 'sekai:me', displayName: 'Me', authenticated: true };
        window.peer = { id: 'sekai:peer', displayName: 'Peer', authenticated: true };
        ui.eventBus.emit('session:updated', { user: me });
        ui.addChatMessage('Me', 'Original message', 10, undefined, undefined, me);
        ui.eventBus.emit('room:synced');
        window.incoming = (text, timestamp) => ui.eventBus.emit('message:received', { name: peer.displayName, user: peer, message: text, timestamp });
      });
      return page;
    }
    return { context, page: await pageFor(), pageFor };
  }
  const atMe = '<$SEKAI:Mention:type=user;display=Me:sekai:me>';

  await t.test('settings categories share volume and mute state while preserving room preferences', async t => {
    const { page } = await fixture(t);
    await page.locator('#navigation-settings').click();
    await page.getByRole('tab', { name: '声音与免打扰' }).click();
    await page.getByRole('slider', { name: '提醒音量' }).focus();
    await page.keyboard.press('Home');
    await page.getByRole('tab', { name: '消息提醒' }).click();
    await page.getByRole('button', { name: '试听新消息音效', exact: true }).click();
    assert.match(await page.locator('#palette-status').textContent(), /音量为 0/);
    assert.equal(await page.evaluate(() => played.length), 0);
    assert.equal(await page.locator('#settings-messages .alert-page-state').isVisible(), true);
    await page.getByRole('tab', { name: '声音与免打扰' }).click();
    await page.getByRole('slider', { name: '提醒音量' }).focus();
    await page.keyboard.press('End');
    await page.getByRole('switch', { name: '提醒声音', exact: true }).uncheck();
    await page.getByRole('tab', { name: '成员动态与关注' }).click();
    assert.match(await page.locator('#settings-presence .alert-page-state').textContent(), /声音已关闭/);
    await page.evaluate(() => ui.setCurrentRoom('another-room'));
    assert.equal(await page.locator('#settings-presence .alert-page-state').isVisible(), false);
    await page.getByRole('tab', { name: '声音与免打扰' }).click();
    assert.equal(await page.getByRole('switch', { name: '提醒声音', exact: true }).isChecked(), true);
    await page.evaluate(() => ui.setCurrentRoom('alerts-test'));
    assert.equal(await page.getByRole('switch', { name: '提醒声音', exact: true }).isChecked(), false);
    await page.locator('.settings-close').click();
    await page.locator('#navigation-settings').click();
    assert.equal(await page.locator('[data-alert=sound]').count(), 1, 'reopening reuses controls');
    assert.equal(await page.getByRole('tab', { name: '声音与免打扰' }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: '成员动态与关注' }).click();
    await page.getByRole('button', { name: '试听成员上线音效', exact: true }).click();
    await page.waitForFunction(() => played.length === 1);
    assert.match(await page.locator('#palette-status').textContent(), /正在试听：成员上线/);
  });

  await t.test('room push switches are independent, announce failures and fit a small screen', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      const rooms = {};
      ui.pushNotifications = { config: { enabled: true }, supported: () => true, state: { rooms },
        roomPreferences: room => rooms[room] || {},
        setRoomPreferences: async (room, change) => {
          if (window.failPush) throw new Error('推送同步失败，请重试。');
          rooms[room] = { ...rooms[room], ...change };
        }, roomAttention() {} };
    });
    await page.locator('#navigation-settings').click();
    await page.getByRole('tab', { name: '消息提醒' }).click();
    const message = page.getByRole('switch', { name: '新消息：推送', exact: true });
    assert.equal(await message.isChecked(), false);
    await message.check(); assert.equal(await message.isChecked(), true);
    const mention = page.getByRole('switch', { name: '@ 我：推送', exact: true });
    await page.evaluate(() => { window.failPush = true; });
    await mention.click(); await page.waitForFunction(() => !ui.alerts.view.pushBusy);
    assert.equal(await mention.isChecked(), false);
    assert.match(await page.locator('#settings-messages [role=status]').textContent(), /推送同步失败/);
    await page.evaluate(() => { window.failPush = false; });
    await mention.check(); assert.equal(await message.isChecked(), true);
    await page.evaluate(() => ui.setCurrentRoom('another-room'));
    assert.equal(await message.isChecked(), false); assert.equal(await mention.isChecked(), false);
    await page.evaluate(() => ui.setCurrentRoom('alerts-test'));
    assert.equal(await message.isChecked(), true); assert.equal(await mention.isChecked(), true);
    await page.setViewportSize({ width: 375, height: 812 });
    for (const kind of ['新消息', '回复我', '@ 我', '全体提及']) {
      const input = page.getByRole('switch', { name: kind + '：推送', exact: true });
      await input.scrollIntoViewIfNeeded(); const box = await input.locator('..').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 375);
    }
    if (process.env.NIGHTCORD_ALERT_ARTIFACTS) {
      await mkdir(process.env.NIGHTCORD_ALERT_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, 'settings-push-mobile.png') });
    }
  });

  await t.test('ordinary arrivals group without stealing focus and open the latest message', async t => {
    const { page } = await fixture(t);
    await page.locator('#navigation-tasks').click();
    const focused = await page.evaluate(() => document.activeElement.outerHTML);
    await page.evaluate(() => incoming('一起听刚完成的那首歌吧。', 100));
    assert.equal(await page.locator('.chat-alert-title').textContent(), 'Peer');
    assert.equal(await page.locator('.chat-alert-summary').textContent(), '一起听刚完成的那首歌吧。');
    assert.equal(await page.evaluate(() => document.activeElement.outerHTML), focused);
    await page.evaluate(() => {
      peer = { ...peer, id: 'sekai:second', displayName: '瑞希' };
      incoming('公开 ||不要提前看|| <$SEKAI:Format:spoiler=true:隐藏的文字>', 101);
    });
    assert.equal(await page.locator('.chat-alert').count(), 1);
    assert.equal(await page.locator('.chat-alert-title').textContent(), '瑞希');
    assert.equal(await page.locator('.chat-alert-avatar').textContent(), '瑞');
    assert.match(await page.locator('.chat-alert-footer').textContent(), /2 条/);
    assert.match(await page.locator('.chat-alert-summary').textContent(), /隐藏内容/);
    assert.doesNotMatch(await page.locator('.chat-alert-summary').textContent(), /不要提前看|隐藏的文字/);
    await page.evaluate(() => {
      window.readWrites = 0;
      const save = ui.sidebarFeatures.saveRead.bind(ui.sidebarFeatures);
      ui.sidebarFeatures.saveRead = (...args) => { readWrites++; return save(...args); };
    });
    await page.locator('.chat-alert-open').click();
    assert.equal(await page.locator('#sidebar-tools').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.timestamp), '101');
    assert.equal(await page.evaluate(() => readWrites), 0, 'ordinary messages never create inbox read markers');
    assert.equal(await page.locator('.chat-alert').count(), 0);
  });

  await t.test('ordinary notice modes respect attention and give priority to existing mentions', async t => {
    const { page } = await fixture(t);
    await page.locator('#messageInput').focus();
    await page.waitForFunction(() => ui.alerts.viewing());
    await page.evaluate(() => incoming('Already reading', 110));
    assert.equal(await page.locator('.chat-alert').count(), 0);
    await page.evaluate(() => {
      ui.alerts.preferences.save(p => { p.messageNotice = 'always'; });
      incoming('Always visible', 111);
    });
    await page.locator('.chat-alert-open').focus();
    assert.equal(await page.locator('.chat-alert').count(), 1, 'focus must not dismiss the always-on card');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#messageInput').evaluate(node => node === document.activeElement), true);
    await page.evaluate(text => incoming(text, 112), atMe);
    await page.evaluate(() => incoming('Lower priority', 113));
    assert.equal(await page.locator('.mention-notice').count(), 1);
    assert.equal(await page.locator('.chat-alert').count(), 0);
    await page.evaluate(() => {
      ui.clearNotices();
      incoming('<$SEKAI:Reply::10> A reply', 114);
    });
    assert.equal(await page.locator('.reply-notice').count(), 1);
    await page.evaluate(() => {
      ui.clearNotices();
      ui.alerts.preferences.save(p => { p.messageNotice = 'off'; });
      ui.sidebarFeatures.open('tasks');
      incoming('Disabled banner', 115);
    });
    assert.equal(await page.locator('.chat-alert').count(), 0);
    assert.ok(await page.evaluate(() => ui.alerts.unread > 0), 'the unread entry survives disabled banners');
  });

  await t.test('grouped card pauses its remaining lifetime for pointer and keyboard', async t => {
    const { page } = await fixture(t);
    await page.clock.install();
    await page.locator('#messageInput').focus();
    await page.evaluate(() => {
      ui.alerts.preferences.save(p => { p.messageNotice = 'always'; p.sound = false; });
      incoming('Take your time', 120);
    });
    const notice = page.locator('.chat-alert');
    await page.clock.runFor(4000);
    await notice.hover();
    await notice.locator('.chat-alert-open').focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(7000);
    assert.equal(await notice.count(), 1);
    await notice.hover();
    await page.locator('#messageInput').focus();
    await page.clock.runFor(7000);
    assert.equal(await notice.count(), 1);
    await page.mouse.move(0, 0);
    await page.clock.runFor(2600);
    assert.equal(await notice.count(), 0, 'resumes the remaining time instead of a new full interval');
  });

  await t.test('swiping closes only the current card and the next card is still clickable', async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      ui.alerts.preferences.save(p => { p.messageNotice = 'always'; p.sound = false; });
      incoming('Swipe this away', 125);
      const card = document.querySelector('.chat-alert');
      card.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 150 }));
      card.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: 200, clientY: 150 }));
      incoming('The next card', 126);
      card.querySelector('.chat-alert-open').click();
    });
    assert.equal(await page.locator('.chat-alert').count(), 1, 'a trailing click from the old swipe must not open the new arrival');
    await page.locator('.chat-alert-open').click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.timestamp), '126');
    assert.equal(await page.locator('.chat-alert').count(), 0);
  });

  await t.test('message card fits mobile and landscape in every palette with reduced motion', async t => {
    const { page } = await fixture(t);
    await page.clock.install();
    await page.evaluate(() => {
      ui.alerts.preferences.save(p => { p.messageNotice = 'always'; p.sound = false; });
      ui.elements.roomName.textContent = '作业';
      peer.displayName = '晓山瑞希';
      incoming('新曲的 Demo 发过来了，一起听听？', 130);
      incoming('副歌那里我又改了一点，等你的意见。', 131);
    });
    for (const palette of ['gray-purple', 'indigo', 'plum-orchid']) {
      await page.evaluate(value => { document.documentElement.dataset.palette = value; }, palette);
      for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(() => {
          const rect = document.querySelector('.chat-alert').getBoundingClientRect();
          return rect.x >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        });
        const notice = page.locator('.chat-alert');
        const box = await notice.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height,
          `${palette}: ${JSON.stringify({ viewport, box })}`);
        assert.equal(await notice.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        assert.equal(await notice.evaluate(node => getComputedStyle(node).animationName), 'none');
        const close = await notice.locator('.chat-alert-close').boundingBox();
        assert.ok(close.width >= 44 && close.height >= 44);
        if (process.env.NIGHTCORD_ALERT_ARTIFACTS && viewport.width === 375) {
          await mkdir(process.env.NIGHTCORD_ALERT_ARTIFACTS, { recursive: true });
          await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, `message-${palette}-mobile.png`) });
        }
      }
    }
    await page.evaluate(() => {
      peer.displayName = '一个非常长的成员昵称'.repeat(8);
      incoming('LongUnbrokenText'.repeat(30), 132);
    });
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(await page.locator('.chat-alert').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  });

  await t.test('reply and mention share one inbox row and cue, with independent controls', async t => {
    const { page } = await fixture(t);
    await page.evaluate(text => incoming(`<$SEKAI:Reply::10> ${text}`, 20), atMe);
    await page.waitForFunction(() => played.length === 1);
    assert.match((await page.evaluate(() => played))[0], /mention\.opus\?v=3$/);
    assert.match(await page.locator('.mention-notice').textContent(), /提到了你/);
    await page.locator('#navigation-inbox').click();
    assert.equal(await page.locator('.tool-message').count(), 1);
    assert.match(await page.locator('.tool-alert-kind').textContent(), /@ 我.*回复我/);
    await page.getByRole('button', { name: '回复我', exact: true }).click();
    assert.equal(await page.locator('.tool-message').count(), 1);
    await page.getByRole('button', { name: '全体提及', exact: true }).click();
    assert.equal(await page.locator('.tool-message').count(), 0);
    await page.locator('.tools-back').click();
    await page.locator('#navigation-settings').click();
    await page.getByRole('tab', { name: '消息提醒' }).click();
    const pinnedBounds = () => page.locator('.settings-header, .settings-sidebar, .settings-footer').evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
    }));
    const beforeScroll = await pinnedBounds();
    const content = page.locator('#appearance-settings .settings-content');
    assert.ok(await content.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; }) > 0);
    assert.deepEqual(await pinnedBounds(), beforeScroll, 'only the page content scrolls');
    await page.getByRole('tab', { name: '外观与布局', exact: true }).click();
    assert.equal(await content.evaluate(node => node.scrollTop), 0);
    if (process.env.NIGHTCORD_ALERT_ARTIFACTS) {
      await mkdir(process.env.NIGHTCORD_ALERT_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, 'settings-layout-desktop.png') });
    }
    await page.getByRole('tab', { name: '消息提醒' }).click();
    assert.equal(await content.evaluate(node => node.scrollTop), 0);
    if (process.env.NIGHTCORD_ALERT_ARTIFACTS) await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, 'settings-notifications-desktop.png') });
    await page.locator('[data-alert=mentionSound]').uncheck();
    await page.locator('[data-alert=replyNotice]').uncheck();
    await page.locator('#appearance-settings .settings-close').click();
    await page.evaluate(() => { ui.alerts.lastSound = 0; incoming('<$SEKAI:Reply::10> hello', 21); });
    await page.waitForFunction(() => played.length === 2);
    assert.match((await page.evaluate(() => played))[1], /reply\.opus\?v=3$/);
    assert.equal(await page.locator('.mention-notice').count(), 0);
    await page.locator('#navigation-settings').click();
    await page.getByRole('tab', { name: '声音与免打扰' }).click();
    await page.locator('[data-alert=pause]').selectOption('hour');
    await page.getByRole('tab', { name: '消息提醒' }).click();
    assert.match(await page.locator('#settings-messages .alert-page-state').textContent(), /提醒已暂停/);
    await page.getByRole('tab', { name: '成员动态与关注' }).click();
    assert.equal(await page.locator('#settings-presence .alert-page-state').isVisible(), true);
    await page.locator('#appearance-settings .settings-close').click();
    await page.evaluate(text => incoming(text, 22), atMe);
    assert.equal(await page.locator('.mention-notice').count(), 0);
    assert.equal((await page.evaluate(() => played)).length, 2);
    assert.equal(await page.evaluate(() => ui.sidebarFeatures.mentions().length), 3, 'paused notifications still reach the inbox');
  });

  await t.test('profile follows work, debounced transitions cancel and settings persist across tabs', async t => {
    const { page, pageFor } = await fixture(t);
    await page.evaluate(() => ui.profileUI.open(peer));
    await page.locator('[data-follow=online]').check();
    await page.locator('[data-follow=offline]').check();
    await page.locator('.profile-close').click();
    await page.clock.install();
    await page.evaluate(() => ui.eventBus.emit('user:joined', { user: peer, username: peer.displayName }));
    await page.clock.runFor(2000);
    await page.waitForFunction(() => played.length === 1);
    assert.match(await page.locator('.chat-alert').textContent(), /进入/);
    await page.evaluate(() => ui.eventBus.emit('user:quit', { userId: peer.id, username: peer.displayName }));
    await page.clock.runFor(7000);
    await page.evaluate(() => ui.eventBus.emit('user:joined', { user: peer, username: peer.displayName }));
    await page.clock.runFor(16000);
    assert.equal(await page.evaluate(() => ui.alerts.recent.length), 1);
    const other = await pageFor();
    assert.equal(await other.evaluate(() => ui.alerts.preferences.read().followed[peer.id].offline), true);
    await other.locator('#navigation-settings').click();
    await other.getByRole('tab', { name: '成员动态与关注' }).click();
    await other.getByRole('button', { name: '取消关注 Peer', exact: true }).click();
    await page.waitForFunction(() => !ui.alerts.preferences.read().followed[peer.id]);
  });

  for (const blocked of [false, true]) {
    await t.test(`concurrent tabs play once${blocked ? ' with storage blocked' : ''}`, async t => {
      const { page, pageFor } = await fixture(t, { blocked });
      const other = await pageFor();
      for (const tab of [page, other]) await tab.evaluate(() => { ui.alerts.preferences.save(p => { p.message = 'always'; }); });
      await Promise.all([page, other].map(tab => tab.evaluate(() => incoming('A shared event', 50))));
      await page.waitForTimeout(250);
      assert.equal((await page.evaluate(() => played.length)) + (await other.evaluate(() => played.length)), 1);
      for (const tab of [page, other]) await tab.evaluate(() => { ui.alerts.preferences.save(p => { p.message = 'away'; }); ui.alerts.lastSound = 0; });
      await page.evaluate(() => { ui.alerts.viewing = () => true; ui.alerts.delivery.announce(); });
      await other.waitForFunction(() => ui.alerts.delivery.viewing(ui.alerts.preferences.key()));
      await other.evaluate(() => incoming('Already being read in the first tab', 51));
      assert.equal((await page.evaluate(() => played.length)) + (await other.evaluate(() => played.length)), 1);
    });
  }

  await t.test('a blocked tab does not swallow another tab’s playable cue or queue old sounds', async t => {
    const { page, pageFor } = await fixture(t);
    const other = await pageFor();
    await page.evaluate(() => { window.denyAudio = true; incoming('<$SEKAI:Mention:type=user:sekai:me>', 70); });
    await page.waitForFunction(() => ui.alerts.sounds.state === 'blocked');
    await other.evaluate(() => incoming('<$SEKAI:Mention:type=user:sekai:me>', 70));
    await other.waitForFunction(() => played.length === 1);
    await page.locator('#messageInput').click();
    assert.equal(await page.evaluate(() => played.length), 1, 'gesture does not replay old notifications');
    assert.equal(await other.evaluate(() => ui.alerts.sounds.state), 'ready');
  });

  await t.test('BroadcastChannel fallback elects one tab when Web Locks is absent', async t => {
    const { context, page, pageFor } = await fixture(t);
    await page.close();
    await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    const tabs = [await pageFor(), await pageFor()];
    await tabs[0].waitForFunction(() => ui.alerts.delivery.peers.size > 0);
    const generation = await tabs[1].evaluate(() => ui.alerts.generation);
    await tabs[0].evaluate(() => ui.alerts.preferences.save(p => { p.message = 'always'; }));
    await tabs[1].waitForFunction(before => ui.alerts.generation > before, generation);
    await Promise.all(tabs.map(tab => tab.evaluate(() => incoming('fallback', 71))));
    await Promise.all(tabs.map(tab => tab.waitForFunction(() => ui.alerts.delivery.pending.size === 0)));
    assert.equal((await tabs[0].evaluate(() => played.length)) + (await tabs[1].evaluate(() => played.length)), 1);
  });

  await t.test('all five assets decode and previews remain usable on a small phone', async t => {
    const { page } = await fixture(t, { viewport: { width: 375, height: 812 } });
    await page.evaluate(() => { window.realAudio = true; ui.closeNavigationDrawer?.(); });
    // Use the settings event through the actual button, including the mobile drawer.
    await page.locator('.sidebar-toggle').first().click();
    await page.locator('#navigation-settings').click();
    const category = async name => {
      const back = page.getByRole('button', { name: '返回设置列表', exact: true });
      if (await back.isVisible()) await back.click();
      await page.getByRole('button', { name, exact: true }).click();
    };
    for (const kind of ['新消息', '回复我', '@ 我', '成员上线', '成员下线']) {
      await category(kind.startsWith('成员') ? '成员动态与关注' : '消息提醒');
      await page.getByRole('button', { name: `试听${kind}音效`, exact: true }).click();
      await page.waitForFunction(() => ui.alerts.sounds.active?.currentTime > 0);
      assert.equal(await page.evaluate(() => ui.alerts.sounds.state), 'ready');
      await page.waitForFunction(() => ui.alerts.sounds.active?.ended);
    }
    await page.evaluate(() => { ui.alerts.sounds.ext = 'mp3'; });
    for (const kind of ['新消息', '回复我', '@ 我', '成员上线', '成员下线']) {
      await category(kind.startsWith('成员') ? '成员动态与关注' : '消息提醒');
      await page.getByRole('button', { name: `试听${kind}音效`, exact: true }).click();
      await page.waitForFunction(() => ui.alerts.sounds.active?.currentTime > 0 && ui.alerts.sounds.active?.ended);
      assert.equal(await page.evaluate(() => ui.alerts.sounds.state), 'ready');
    }
    assert.equal(await page.locator('.alert-settings').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
    await category('消息提醒');
    await page.locator('[data-alert=message]:checked').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => ui.alerts.preferences.read().message), 'always');
    assert.equal(await page.locator('[data-alert=message][value=always]').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => ui.alerts.preferences.read().message), 'away');
    await page.getByRole('switch', { name: '回复我：声音', exact: true }).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => ui.alerts.preferences.read().replySound), false);
    await page.keyboard.press('Space');
    // The transparent native input covers its label; click its text side.
    await page.getByRole('switch', { name: '回复我：站内提醒', exact: true }).click({ position: { x: 20, y: 22 } });
    assert.deepEqual(await page.evaluate(() => {
      const { replyNotice, replySound } = ui.alerts.preferences.read(); return { replyNotice, replySound };
    }), { replyNotice: false, replySound: true }, 'the reminder label toggles only its adjacent switch');
    await page.getByRole('switch', { name: '回复我：声音', exact: true }).click({ position: { x: 20, y: 22 } });
    assert.deepEqual(await page.evaluate(() => {
      const { replyNotice, replySound } = ui.alerts.preferences.read(); return { replyNotice, replySound };
    }), { replyNotice: false, replySound: false }, 'the sound label is a separate click target');
    await category('声音与免打扰');
    await page.getByRole('slider', { name: '提醒音量', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => ui.alerts.preferences.read().volume), .55);
    assert.equal(await page.getByRole('slider').getAttribute('aria-valuetext'), '55%');
    if (process.env.NIGHTCORD_ALERT_ARTIFACTS) {
      await mkdir(process.env.NIGHTCORD_ALERT_ARTIFACTS, { recursive: true });
      await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, 'settings-mobile.png') });
      await category('消息提醒');
      await page.locator('#settings-messages .alert-category').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, 'settings-replies-mobile.png') });
    }
    await page.setViewportSize({ width: 812, height: 375 });
    assert.equal(await page.locator('#appearance-settings').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.locator('#appearance-settings .settings-close').click();
    await page.evaluate(() => ui.profileUI.open(peer));
    assert.equal(await page.locator('.alert-profile input').count(), 2);
    await page.getByRole('switch', { name: '上线时提醒我', exact: true }).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => ui.alerts.preferences.read().followed[peer.id].online), true);
    if (process.env.NIGHTCORD_ALERT_ARTIFACTS) {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: join(process.env.NIGHTCORD_ALERT_ARTIFACTS, 'profile-mobile.png') });
    }
  });
});
