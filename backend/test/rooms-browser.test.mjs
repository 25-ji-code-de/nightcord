/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('managed rooms: create, join, send, replies, invitations, removal, mobile and account isolation', { timeout: 180000 }, async t => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) return res.writeHead(403).end();
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const runtime = createRuntime({}, { origin, inspectDurableObjects: true, bindings: { DM_MODE: 'on', ROOMS_MODE: 'on',
    VOICE_MODE: 'on', VOICE_ALLOWED_ROOMS: 'nightcord-default,nightcord-test',
    REALTIME_SFU_APP_ID: 'fixture', REALTIME_SFU_APP_SECRET: 'fixture',
    REALTIME_TURN_KEY_ID: 'fixture', REALTIME_TURN_API_TOKEN: 'fixture',
    ROOMS_OFFICIAL: [{ id: 'nightcord-default', name: '作业', description: '官方作业频道' }, { id: 'nightcord-study', name: '自习室', description: '官方自习频道' }] },
    identities: { 'Bearer alice': 'alice', 'Bearer bob': 'bob', 'Bearer eve': 'eve' },
    profiles: { alice: { name: '小夜', preferred_username: 'sayo', picture: '' },
      bob: { name: '遥', preferred_username: 'haru', picture: '' },
      eve: { name: '冬青', preferred_username: 'holly', picture: '' } } });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const db = await runtime.getD1Database('ROOM_DIRECTORY');
  await db.exec((await readFile('migrations/0001_rooms.sql', 'utf8')).replace(/\n/g, ' '));
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const errors = [];
  const screenshots = resolve(root, 'backend/dist/rooms-screenshots'); await mkdir(screenshots, { recursive: true });
  async function pageFor(name, width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 },
      isMobile: width < 600, hasTouch: width < 600, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith(base)) return route.continue();
      if (url.includes('autocomplete.json')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ test: { '你好': 'nihao', '晚安': 'wanan' } }) });
      if (url.endsWith('.png')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#d6c7eb"/><path d="M20 38q12 12 24 0M23 24v4m18-4v4" fill="none" stroke="#50476a" stroke-width="3" stroke-linecap="round"/></svg>' });
      return route.abort();
    });
    await context.addInitScript(({ base, name }) => {
      const nativeFetch = window.fetch.bind(window);
      window.dmTestRequests = [];
      window.fetch = (url, options) => {
        if (String(url).includes('/api/dm/')) window.dmTestRequests.push({ path: new URL(url).pathname, method: options?.method || 'GET', data: options?.body ? JSON.parse(options.body) : null });
        return nativeFetch(String(url).replace('https://chat.nightcord.de5.net', base), options);
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket { constructor(url, protocols) { super(String(url).replace('wss://chat.nightcord.de5.net', base.replace(/^http/, 'ws')), protocols); } };
      if (!localStorage.getItem('dm-test-seeded')) {
        localStorage.setItem('dm-test-seeded', '1');
        localStorage.setItem('sekai_pass_access_token', name);
        localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
        localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: name, name }));
      }
    }, { base, name });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.directMessages.ready); }
    catch (error) {
      console.error(await page.evaluate(() => ({ status: window.nightcord?.directMessages?.status, user: window.nightcord?.directMessages?.user?.id, mode: window.nightcord?.directMessages?.mode })), errors);
      throw error;
    }
    return page;
  }
  async function clearLimits() {
    const ids = await runtime.listDurableObjectIds('LIMITERS');
    for (const id of ids) {
      const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'RateLimiter', { id });
      await storage.exec('DELETE FROM rate_limit');
    }
  }
  async function adminScreenshots(page, name) {
    await page.locator('.sekai-notice__close').evaluateAll(nodes => nodes.forEach(node => node.click()));
    for (const [width, height] of [[1280, 900], [375, 812], [390, 844], [812, 375]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator('.rooms-content').evaluate(node => node.scrollWidth <= node.clientWidth), true, name + ' content fits ' + width);
      assert.equal(await page.locator('.rooms-header').evaluate(node => node.scrollWidth <= node.clientWidth), true, name + ' header fits ' + width);
      if (name.startsWith('invites')) assert.equal(await page.locator('.room-invite-fields').evaluate(node => {
        const [hours, uses] = [...node.querySelectorAll('input')].map(input => input.getBoundingClientRect());
        return Math.abs(hours.top - uses.top) < 1 && hours.height >= 44 && uses.height >= 44;
      }), true, 'invitation controls stay aligned at ' + width);
      await page.screenshot({ path: resolve(screenshots, `admin-${name}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  const alice = await pageFor('alice'), bob = await pageFor('bob', 390);
  async function checkPublicHeader(page) {
    assert.equal(await page.getByRole('button', { name: '房间信息', exact: true, includeHidden: true }).isVisible(), false,
      'managed room information must not occupy the public channel header');
    await page.locator('[data-voice-toggle]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#current-channel-name').textContent(), '作业');
    assert.equal(await page.locator('#navigation-channel .channel-name').textContent(), '作业');
    assert.ok(await page.locator('.main > .chat-header').evaluate(node => {
      const header = node.getBoundingClientRect();
      const voice = node.querySelector('[data-voice-toggle]').getBoundingClientRect();
      return node.scrollWidth <= node.clientWidth && voice.left >= header.left && voice.right <= header.right;
    }), 'the voice entry stays inside the header');
    await page.locator('[data-voice-toggle]').click();
    assert.equal(await page.locator('#voice-panel').isVisible(), true);
    await page.getByRole('button', { name: '收起语音面板', exact: true }).click();
  }
  for (const [width, height] of [[1280, 900], [375, 812], [320, 640], [812, 375]]) {
    await alice.setViewportSize({ width, height });
    await checkPublicHeader(alice);
    await alice.screenshot({ path: resolve(screenshots, `public-voice-header-${width}.png`) });
  }
  await alice.setViewportSize({ width: 1280, height: 900 });
  await alice.getByRole('button', { name: '设置', exact: true }).click();
  await alice.getByRole('tab', { name: '成员动态与关注', exact: true }).click();
  const hidden = alice.getByRole('radio', { name: '从列表隐藏', exact: true });
  assert.equal(await hidden.isEnabled(), true, 'official room exposes its confirmed setting');
  await hidden.check();
  await alice.waitForFunction(() => nightcord.ui.roomVisibility.visibility === 'hidden' && !nightcord.ui.roomVisibility.pending);
  await alice.locator('.settings-close').click();
  await alice.evaluate(() => {
    window.originalChatLog = document.querySelector('#messages');
    window.originalComposer = document.querySelector('#messageInput');
    window.originalComposer.value = '官方频道未发送草稿';
  });
  await alice.getByRole('button', {name:'房间大厅',exact:true}).click();
  await alice.locator('.rooms-listing[aria-busy="false"]').waitFor();
  assert.deepEqual(await alice.locator('.rooms-room-card').evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), node.dataset.kind])), [['作业', 'official'], ['自习室', 'official']]);
  assert.equal(await alice.getByText('暂无公开房间', { exact: true }).count(), 0);
  assert.deepEqual(await alice.locator('.navigation-item[aria-current="page"]').evaluateAll(nodes => nodes.map(node => node.id)), ['navigation-rooms']);
  await alice.screenshot({ path: resolve(screenshots, 'desktop-lobby-empty.png') });
  await clearLimits();
  await alice.getByRole('button', { name: '自习室', exact: true }).click();
  await alice.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentRoom === 'nightcord-study');
  await alice.locator('[data-voice-toolbar]').waitFor({ state: 'hidden' });
  assert.equal(await alice.locator('#current-channel-name').textContent(), '自习室');
  assert.equal(await alice.locator('#navigation-channel .channel-name').textContent(), '自习室');
  await alice.locator('#navigation-rooms').click();
  // Other navigation destinations must replace the room surface, never hide both.
  await alice.locator('#navigation-search').click();
  assert.equal(await alice.locator('#managed-rooms').isVisible(), false);
  assert.equal(await alice.locator('#sidebar-tools').isVisible(), true);
  await alice.locator('#navigation-rooms').click();
  await alice.getByRole('button', { name: '我的房间', exact: true }).click();
  await alice.getByText('尚未加入房间', { exact: true }).waitFor();
  assert.equal(await alice.locator('.rooms-room-card[data-kind="official"]').count(), 0);
  await alice.getByRole('button', { name: '浏览公开房间', exact: true }).click();
  await alice.locator('#managed-rooms').getByRole('button', { name: '创建房间', exact: true }).click();
  await alice.locator('.rooms-form').getByRole('button', { name: '取消', exact: true }).click();
  await alice.locator('.rooms-listing[aria-busy="false"]').waitFor();
  // A late directory response must not append cards to the creation form.
  await alice.evaluate(() => {
    window.originalRoomList = nightcord.rooms.list;
    nightcord.rooms.list = () => new Promise(resolve => { window.finishRoomList = resolve; });
    void nightcord.roomsView.lobby(false, '', true);
  });
  await alice.locator('.rooms-loading').waitFor();
  await alice.getByRole('button', { name: '创建房间', exact: true }).click();
  await alice.evaluate(() => {
    nightcord.rooms.list = window.originalRoomList;
    window.finishRoomList({ rooms: [{ id: 'stale', name: '过期列表结果' }] });
  });
  assert.equal(await alice.locator('.rooms-form').isVisible(), true);
  assert.equal(await alice.getByText('过期列表结果', { exact: true }).count(), 0);
  await alice.locator('.rooms-form').getByRole('button', { name: '取消', exact: true }).click();
  await alice.evaluate(async () => {
    nightcord.rooms.list = async () => { throw new Error('连接暂时中断'); };
    await nightcord.roomsView.lobby(false, '', true);
    nightcord.rooms.list = window.originalRoomList;
  });
  await alice.getByRole('alert').getByText('连接暂时中断', { exact: true }).waitFor();
  assert.equal(await alice.getByRole('button', { name: '自习室', exact: true }).isVisible(), true, 'official channels remain accessible when the user directory fails');
  await alice.getByRole('button', { name: '重试', exact: true }).click();
  await alice.locator('.rooms-listing[aria-busy="false"]').waitFor();
  await alice.locator('#managed-rooms').getByRole('button',{name:'创建房间',exact:true}).click();
  await alice.getByLabel('房间名称',{exact:true}).fill('测试用户房');
  await alice.getByLabel('简介',{exact:true}).fill('房间简介');
  await alice.getByRole('radio', { name: '公开展示', exact: true }).check();
  // An interrupted response can follow a successful creation; retry the same room.
  await alice.evaluate(() => {
    const call = nightcord.rooms.call;
    nightcord.rooms.call = async function (...args) {
      const result = await call.apply(this, args);
      if (args[0] === '/rooms' && args[1]) {
        this.call = call; window.firstCreatedRoom = result.room.id;
        throw new Error('连接暂时中断');
      }
      return result;
    };
  });
  await alice.locator('.rooms-form').getByRole('button',{name:'创建房间',exact:true}).click();
  await alice.locator('.rooms-form').getByText('连接暂时中断', { exact: true }).waitFor();
  assert.equal(await alice.getByLabel('房间名称', { exact: true }).inputValue(), '测试用户房');
  assert.equal(await alice.getByLabel('房间名称', { exact: true }).isDisabled(), true);
  await alice.getByRole('button', { name: '重试创建', exact: true }).click();
  await alice.waitForFunction(()=>nightcord.rooms.ready).catch(async error => {
    console.error(errors, await alice.evaluate(() => ({ status: nightcord.rooms.status, room: nightcord.rooms.room,
      errors: document.querySelector('.rooms-error').textContent, input: document.querySelector('#messageInput').value })));
    throw error;
  });
  const id=await alice.evaluate(()=>nightcord.rooms.room.id);
  assert.equal(id, await alice.evaluate(() => window.firstCreatedRoom));
  assert.equal(await alice.evaluate(() => window.originalChatLog === document.querySelector('#messages') && window.originalComposer === document.querySelector('#messageInput')), true);
  assert.equal(await alice.locator('.rooms-compose, .rooms-log, .rooms-message').count(), 0);
  assert.equal(await alice.locator('#attachmentBtn').isVisible(), false);
  assert.equal(await alice.locator('#formatBtn').isVisible(), true);
  assert.equal(await alice.locator('#stickerBtn').isVisible(), true);
  assert.equal(await alice.locator('#current-channel-name').textContent(), '测试用户房');
  assert.equal(await alice.evaluate(() => nightcord.chatRoom.wsManager.ready), false);

  await clearLimits();
  await bob.locator('.sidebar-toggle').click();
  await bob.locator('#navigation-rooms').click();
  await bob.getByRole('button', { name: '测试用户房', exact: true }).waitFor();
  assert.deepEqual(await bob.locator('.rooms-room-card').evaluateAll(nodes => nodes.map(node => node.dataset.kind)), ['official', 'official', 'community']);
  for (const [width, height] of [[375, 812], [812, 375], [1280, 900]]) {
    await bob.setViewportSize({ width, height });
    assert.equal(await bob.locator('#managed-rooms').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await bob.locator('.rooms-content').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await bob.screenshot({ path: resolve(screenshots, `lobby-${width}.png`) });
  }
  for (const palette of ['indigo', 'plum-orchid']) {
    await bob.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
    await bob.screenshot({ path: resolve(screenshots, `lobby-${palette}.png`) });
  }
  await bob.evaluate(() => { document.documentElement.dataset.palette = 'gray-purple'; });
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.getByRole('button', { name: '测试用户房', exact: true }).focus();
  await bob.keyboard.press('Enter');
  await bob.getByRole('button',{name:'确认加入',exact:true}).click().catch(async error => {
    console.error(errors, await bob.evaluate(() => ({ status: nightcord.rooms.status, room: nightcord.rooms.room,
      errors: document.querySelector('.rooms-error').textContent, content: document.querySelector('.rooms-content').textContent, panel: document.querySelector('#managed-rooms').hidden })));
    throw error;
  });
  await bob.waitForFunction(()=>nightcord.rooms.ready);
  await alice.waitForFunction(() => nightcord.ui.roster.some(member => member.profile.id === 'sekai:bob'));
  assert.equal(await bob.getByRole('button', { name: '房间信息', exact: true }).isVisible(), true);
  assert.equal(await bob.locator('[data-voice-toolbar]').isVisible(), false);
  await clearLimits();
  await alice.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await alice.getByRole('radio', { name: '正常显示', exact: true }).isChecked(), true, 'managed room does not reuse the official hidden state');
  await alice.getByRole('radio', { name: '显示为离线', exact: true }).check();
  await bob.locator('#offline-users [data-user-id="sekai:alice"]').waitFor({ state: 'attached' });
  assert.equal(await bob.locator('#online-users [data-user-id="sekai:alice"]').count(), 0);
  await hidden.check();
  await bob.waitForFunction(() => !nightcord.ui.roomMembers.has('sekai:alice'));
  await alice.waitForFunction(() => nightcord.ui.roomVisibility.visibility === 'hidden' && !nightcord.ui.roomVisibility.pending);
  await alice.locator('.settings-close').click();
  await clearLimits();
  await alice.evaluate(() => nightcord.joinRoom('nightcord-default'));
  await alice.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.roomVisibility.available);
  await checkPublicHeader(alice);
  assert.equal(await alice.evaluate(() => nightcord.ui.roomVisibility.visibility), 'hidden');
  await alice.evaluate(() => nightcord.chatRoom.setVisibility('online'));
  await alice.waitForFunction(() => nightcord.ui.roomVisibility.visibility === 'online' && !nightcord.ui.roomVisibility.pending);
  await clearLimits();
  await alice.evaluate(id => nightcord.roomsView.enter(id), id);
  await alice.waitForFunction(() => nightcord.rooms.ready && nightcord.ui.roomVisibility.available);
  assert.equal(await alice.evaluate(() => nightcord.ui.roomVisibility.visibility), 'hidden', 'managed setting survives leaving for an official channel');
  await alice.getByRole('button', { name: '设置', exact: true }).click();
  await alice.getByRole('radio', { name: '正常显示', exact: true }).check();
  await bob.locator('#online-users [data-user-id="sekai:alice"]').waitFor({ state: 'attached' });
  await alice.locator('.settings-close').click();
  await clearLimits();
  assert.equal(await alice.evaluate(() => nightcord.ui.autocomplete.mentionCandidates().some(item => item.type === 'ai')), false);
  await alice.evaluate(async () => {
    window.uploadAttempts = 0;
    const upload = nightcord.ui.fileUploadService.upload;
    nightcord.ui.fileUploadService.upload = () => { window.uploadAttempts++; throw new Error('must not upload'); };
    await nightcord.ui.handleFileUpload(new File(['x'], 'private.txt'), 'file');
    nightcord.ui.fileUploadService.upload = upload;
    nightcord.eventBus.emit('message:received', { name: '其他频道', message: '跨频道消息不得混入', timestamp: Date.now() });
  });
  assert.equal(await alice.evaluate(() => window.uploadAttempts), 0);
  assert.equal(await alice.getByText('跨频道消息不得混入', { exact: true }).count(), 0);
  await alice.locator('#messageInput').fill('只有房间成员可见 <script>');
  await alice.locator('#messageInput').press('Enter');
  await bob.locator('#messages .message').getByText('只有房间成员可见', {exact:true}).waitFor();
  assert.equal(await bob.locator('#messages script').count(), 0);
  await bob.locator('#messageInput').fill('收到 ');
  await bob.locator('#messages .message[data-seq="1"] .message-reply-btn').click();
  assert.match(await bob.locator('#messageInput').inputValue(), /Reply::1/);
  await bob.locator('#messageInput').press('End');
  await bob.locator('#messageInput').pressSequentially('😀');
  await bob.locator('#messageInput').press('Enter');
  await alice.waitForFunction(() => nightcord.rooms.messages.get(2)?.replyTo === 1);
  await alice.locator('#messages .message[data-seq="2"]').filter({ hasText: '收到' }).waitFor();
  await alice.locator('#messages .message[data-seq="2"] .message-user').click();
  await alice.getByRole('dialog').getByRole('button', { name: '发私信', exact: true }).click();
  await alice.waitForFunction(() => [...nightcord.directMessages.conversations.values()].some(item => item.peer.id === 'sekai:bob'));
  assert.equal(await alice.evaluate(() => window.dmTestRequests.some(item => item.method === 'POST' && item.data?.sourceType === 'managed')), true);
  await alice.locator('#navigation-chat').click();
  assert.equal(await alice.evaluate(() => nightcord.ui.currentRoom), id);
  assert.equal(await alice.evaluate(() => nightcord.ui.sidebarFeatures.mentions().some(item => item.replyKey === 2)), true);
  await bob.screenshot({path: resolve(screenshots, 'mobile-room.png')});
  await alice.screenshot({path: resolve(screenshots, 'desktop-room.png')});
  await alice.getByRole('button', { name: '房间信息', exact: true }).click();
  await adminScreenshots(alice, 'overview');
  for (const palette of ['indigo', 'plum-orchid']) {
    await alice.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
    await alice.screenshot({ path: resolve(screenshots, `admin-overview-${palette}.png`) });
  }
  await alice.evaluate(() => { document.documentElement.dataset.palette = 'gray-purple'; });
  assert.equal(await alice.getByRole('button', { name: '归档房间', exact: true }).count(), 0);
  await alice.getByRole('button', { name: '复制链接', exact: true }).click();
  await alice.getByText('链接已复制。', { exact: true }).waitFor();
  // Returning during a slow list load must keep the overview in place.
  await alice.evaluate(() => {
    window.adminCall = nightcord.rooms.call;
    nightcord.rooms.call = function (...args) {
      if (args[0].endsWith('/members')) return new Promise(resolve => { window.finishAdminList = resolve; });
      return window.adminCall.apply(this, args);
    };
  });
  await alice.getByRole('button', { name: '成员管理', exact: true }).click();
  await alice.locator('.room-loading').waitFor();
  await alice.locator('.rooms-back').click();
  await alice.evaluate(async () => {
    nightcord.rooms.call = window.adminCall; window.finishAdminList({ members: [], cursor: null });
    await Promise.resolve();
  });
  assert.equal(await alice.locator('#rooms-title').textContent(), '房间信息');
  assert.equal(await alice.locator('.room-member-list').count(), 0);
  await alice.getByRole('button',{name:'成员管理',exact:true}).click();
  await alice.locator('.room-member[data-account-id="sekai:bob"]').waitFor();
  await adminScreenshots(alice, 'members');
  await alice.locator('#managed-rooms').getByLabel('搜索成员', { exact: true }).fill('not-a-member');
  await alice.getByText('没有找到匹配的成员。', { exact: true }).waitFor();
  await alice.locator('#managed-rooms').getByLabel('搜索成员', { exact: true }).fill('');
  await alice.setViewportSize({ width: 812, height: 375 });
  await alice.locator('.room-member[data-account-id="sekai:bob"] summary').click();
  await alice.getByRole('button', { name: '转让房主', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await alice.locator('.room-member-menu[open] .room-member-actions').evaluate(node => {
    const rect = node.getBoundingClientRect(), body = document.querySelector('.rooms-body').getBoundingClientRect();
    return rect.top >= body.top && rect.bottom <= body.bottom;
  }), true, 'the whole menu stays inside the visible scroll area');
  assert.equal(await alice.getByRole('button', { name: '转让房主', exact: true }).evaluate(node => {
    const rect = node.getBoundingClientRect(), body = document.querySelector('.rooms-body').getBoundingClientRect();
    return rect.top >= body.top && rect.bottom <= body.bottom;
  }), true, 'last menu operation remains reachable in landscape');
  await alice.screenshot({ path: resolve(screenshots, 'admin-member-menu-812.png') });
  await alice.keyboard.press('Escape');
  await alice.setViewportSize({ width: 1280, height: 900 });
  await alice.locator('.room-member[data-account-id="sekai:bob"] summary').click();
  await alice.getByRole('button', { name: '移出房间', exact: true }).click();
  await alice.getByRole('dialog', { name: '移出房间：遥' }).waitFor();
  await alice.evaluate(() => {
    const action = nightcord.rooms.action;
    nightcord.rooms.action = async function () { this.action = action; throw new Error('成员操作暂未完成'); };
  });
  await alice.getByRole('dialog').getByRole('button', { name: '移出房间', exact: true }).click();
  await alice.getByRole('dialog').getByText('成员操作暂未完成', { exact: true }).waitFor();
  assert.equal(await alice.locator('.room-member[data-account-id="sekai:bob"]').count(), 1);
  await alice.keyboard.press('Escape');
  assert.equal(await alice.locator('#rooms-title').textContent(), '成员管理');
  assert.equal(await alice.locator('.room-member[data-account-id="sekai:bob"] summary').evaluate(node => document.activeElement === node), true);
  await alice.locator('.room-member[data-account-id="sekai:bob"] summary').click();
  await alice.getByRole('button',{name:'提及',exact:true}).click();
  assert.match(await alice.locator('#messageInput').inputValue(), /sekai:bob>/);
  await alice.waitForTimeout(800);
  await alice.locator('#messageInput').press('Enter');
  await bob.locator('#messages .message.mentioned').waitFor();
  // Shared search/navigation stays in the active managed room.
  await alice.locator('#navigation-search').click();
  await alice.getByLabel('关键词', { exact: true }).fill('只有房间成员可见');
  await alice.locator('.tool-message').waitFor();
  await alice.locator('#navigation-chat').click();
  assert.equal(await alice.evaluate(() => nightcord.ui.currentRoom), id);
  assert.equal(await alice.locator('#messageInput').isVisible(), true);
  // Shared picker, renderer and retry path use the managed transport.
  await alice.locator('#stickerBtn').click();
  await alice.locator('#mention-list [data-code]').first().click();
  await alice.waitForTimeout(800);
  await alice.locator('#messageInput').press('Enter');
  await bob.locator('#messages .dm-sticker').waitFor();
  await alice.evaluate(() => {
    const request = nightcord.rooms.request.bind(nightcord.rooms);
    nightcord.rooms.request = (...args) => {
      nightcord.rooms.request = request;
      return Promise.reject(new Error('连接暂时中断'));
    };
  });
  await alice.locator('#messageInput').fill('重试后仅发送一次');
  await alice.locator('#messageInput').press('Enter');
  await alice.getByRole('button', { name: '重试发送', exact: true }).waitFor();
  await alice.waitForTimeout(800);
  await alice.getByRole('button', { name: '重试发送', exact: true }).click();
  await bob.locator('#messages').getByText('重试后仅发送一次', { exact: true }).waitFor();
  assert.equal(await alice.evaluate(() => [...nightcord.rooms.messages.values()].filter(message => message.text === '重试后仅发送一次').length), 1);
  // Hide messages while disconnected and restore them after authentication.
  await bob.evaluate(() => { nightcord.rooms.transport.pauseAutoReconnect(); nightcord.rooms.transport.disconnect(); nightcord.rooms.ready = false; nightcord.rooms.update(); });
  assert.equal(await bob.locator('#messages .message').count(), 0);
  assert.equal(await bob.locator('#messageInput').isDisabled(), true);
  await clearLimits();
  await bob.evaluate(() => nightcord.rooms.connect());
  await bob.locator('#messages').getByText('重试后仅发送一次', { exact: true }).waitFor();
  await alice.getByRole('button', { name: '房间信息', exact: true }).click();
  await alice.getByRole('button',{name:'房间设置',exact:true}).click();
  await adminScreenshots(alice, 'settings');
  await alice.setViewportSize({ width: 375, height: 812 });
  await alice.getByRole('radio', { name: '公开展示', exact: true }).focus();
  assert.equal(await alice.getByRole('radio', { name: '公开展示', exact: true }).evaluate(node => {
    const rect = node.getBoundingClientRect(), footer = document.querySelector('.room-savebar').getBoundingClientRect();
    return rect.top >= 48 && rect.bottom <= footer.top;
  }), true, 'sticky save controls do not obscure keyboard focus');
  await alice.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await alice.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
  await alice.getByLabel('简介', { exact: true }).fill('未保存的简介');
  await alice.locator('.rooms-back').click();
  await alice.getByRole('dialog', { name: '放弃未保存的修改？' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await alice.getByLabel('简介', { exact: true }).inputValue(), '未保存的简介');
  await alice.locator('#navigation-rooms').click();
  await alice.getByRole('dialog', { name: '放弃未保存的修改？' }).getByRole('button', { name: '取消', exact: true }).click();
  await alice.locator('#navigation-chat').click();
  await alice.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.equal(await alice.locator('#managed-rooms').isVisible(), false);
  assert.equal(await alice.evaluate(() => nightcord.ui.currentRoom), id);
  await alice.getByRole('button', { name: '房间信息', exact: true }).click();
  await alice.getByRole('button', { name: '房间设置', exact: true }).click();
  await alice.getByLabel('简介', { exact: true }).fill('房间简介');
  await alice.getByRole('radio', { name: '仅限邀请', exact: true }).check();
  await alice.evaluate(() => {
    const action = nightcord.rooms.action;
    nightcord.rooms.action = async function () { this.action = action; throw new Error('设置暂未保存，请重试。'); };
  });
  await alice.setViewportSize({ width: 375, height: 812 });
  await alice.locator('.rooms-body').evaluate(node => { node.scrollTop = 0; });
  await alice.getByRole('button',{name:'保存设置',exact:true}).click();
  await alice.getByText('设置暂未保存，请重试。', { exact: true }).waitFor();
  assert.equal(await alice.getByText('设置暂未保存，请重试。', { exact: true }).evaluate(node => {
    const rect = node.getBoundingClientRect(); return rect.top >= 48 && rect.bottom <= innerHeight;
  }), true, 'save failures are visible beside the save controls on mobile');
  assert.equal(await alice.getByRole('radio', { name: '仅限邀请', exact: true }).isChecked(), true);
  assert.equal(await alice.getByLabel('简介', { exact: true }).inputValue(), '房间简介');
  assert.equal(await alice.getByLabel('简介', { exact: true }).isEnabled(), true);
  await alice.getByRole('button',{name:'保存设置',exact:true}).click();
  await alice.getByText('房间设置已保存。', { exact: true }).waitFor();
  await alice.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await alice.locator('#rooms-title').textContent(), '房间设置');
  await alice.getByLabel('简介', { exact: true }).fill('放弃这段修改');
  await alice.locator('.rooms-back').click();
  await alice.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.equal(await alice.locator('#rooms-title').textContent(), '房间信息');
  assert.equal(await alice.evaluate(() => nightcord.rooms.room.description), '房间简介');
  await bob.getByRole('button', { name: '房间信息', exact: true }).click();
  assert.equal(await bob.getByRole('button', { name: '房间设置', exact: true }).count(), 0);
  assert.equal(await bob.getByRole('button', { name: '邀请管理', exact: true }).count(), 0);
  assert.equal(await bob.getByRole('button', { name: '退出房间', exact: true }).count(), 1);
  await bob.locator('.rooms-back').click();
  await clearLimits();
  await alice.getByRole('button',{name:'邀请管理',exact:true}).click();
  await alice.getByText('暂无有效邀请。生成链接后，可在这里查看使用情况。', { exact: true }).waitFor();
  await adminScreenshots(alice, 'invites-empty');
  await alice.locator('.rooms-back').click();
  await alice.evaluate(() => {
    const call = nightcord.rooms.call;
    nightcord.rooms.call = function (...args) {
      if (args[0].endsWith('/invites') && !args[1]) {
        this.call = call; return new Promise(resolve => { window.finishOldInvites = resolve; });
      }
      return call.apply(this, args);
    };
  });
  await alice.getByRole('button', { name: '邀请管理', exact: true }).click();
  await alice.locator('.room-loading').waitFor();
  await alice.getByLabel('有效期（小时）', { exact: true }).fill('0');
  await alice.getByRole('button',{name:'生成邀请',exact:true}).click();
  assert.equal(await alice.getByLabel('邀请链接', { exact: true }).count(), 0);
  await alice.getByLabel('有效期（小时）', { exact: true }).fill('24');
  await alice.getByRole('button',{name:'生成邀请',exact:true}).click();
  await alice.getByLabel('邀请链接',{exact:true}).waitFor();
  const link=await alice.getByLabel('邀请链接',{exact:true}).inputValue();
  assert.match(link,/#invite=[a-f0-9]{64}$/);
  await alice.locator('.room-invite-row').waitFor();
  await alice.evaluate(async () => { window.finishOldInvites({ invites: [] }); await Promise.resolve(); });
  assert.equal(await alice.locator('.room-invite-row').count(), 1, 'an older list cannot hide a newly generated invitation');
  await adminScreenshots(alice, 'invites-created');
  await alice.locator('.room-invite-result').getByRole('button', { name: '复制链接', exact: true }).click();
  await alice.locator('.room-invite-result').getByText('链接已复制。', { exact: true }).waitFor();
  await alice.getByRole('button', { name: '撤销邀请', exact: true }).click();
  await alice.getByRole('dialog').getByRole('button', { name: '撤销邀请', exact: true }).click();
  await alice.getByText('邀请已撤销。', { exact: true }).waitFor();
  assert.equal(await alice.getByLabel('邀请链接', { exact: true }).count(), 0);
  await alice.locator('.rooms-back').click();
  assert.equal(await alice.locator('#rooms-title').textContent(), '房间信息');
  await alice.locator('.rooms-back').click();
  const second = await alice.evaluate(async () => {
    const result = await nightcord.rooms.call('/rooms', { requestId: crypto.randomUUID(), name: '另一个房间', description: '', discoverability: 'unlisted', joinPolicy: 'invite' });
    return result.room.id;
  });
  // A transfer from another tab invalidates owner controls on an open members page.
  await alice.getByRole('button', { name: '房间信息', exact: true }).click();
  await alice.getByRole('button', { name: '成员管理', exact: true }).click();
  await alice.locator('.room-member[data-account-id="sekai:bob"]').waitFor();
  await clearLimits();
  await alice.evaluate(id => nightcord.rooms.call('/rooms/' + id + '/transfer', { accountId: 'sekai:bob' }), id);
  await alice.waitForFunction(() => nightcord.rooms.role === 'member');
  await alice.getByRole('button', { name: '查看成员', exact: true }).waitFor();
  assert.equal(await alice.getByRole('group', { name: '成员范围' }).count(), 0);
  await bob.waitForFunction(() => nightcord.rooms.role === 'owner');
  await bob.evaluate(id => nightcord.rooms.call('/rooms/' + id + '/transfer', { accountId: 'sekai:alice' }), id);
  await alice.waitForFunction(() => nightcord.rooms.role === 'owner');
  await alice.locator('.rooms-back').click();
  await alice.locator('#messageInput').fill('不得带入其他房间的草稿');
  await alice.evaluate(second => nightcord.roomsView.enter(second), second);
  await alice.waitForFunction(() => nightcord.rooms.ready);
  assert.equal(await alice.locator('#messageInput').inputValue(), '');
  assert.equal(await alice.locator('#messages .message').count(), 0);
  await clearLimits();
  await alice.evaluate(id => nightcord.roomsView.enter(id), id);
  await alice.locator('#messages').getByText('重试后仅发送一次', { exact: true }).waitFor();
  await alice.getByRole('button', { name: '房间信息', exact: true }).click();
  await alice.getByRole('button',{name:'成员管理',exact:true}).click();
  await alice.locator('.room-member[data-account-id="sekai:bob"] summary').click();
  await alice.locator('.room-member-actions').getByRole('button',{name:'禁止加入',exact:true}).click();
  // Revocation must also purge an open search surface and its copied previews.
  await bob.locator('.sidebar-toggle').click();
  await bob.locator('#navigation-search').click();
  await bob.getByLabel('关键词', { exact: true }).fill('只有房间成员可见');
  await bob.locator('.tool-message').waitFor();
  await alice.getByRole('dialog').getByRole('button',{name:'禁止加入',exact:true}).click();
  await bob.waitForFunction(()=>nightcord.rooms.room===null);
  assert.equal(await bob.locator('#messages .message').count(),0);
  await bob.locator('.tool-message').waitFor({ state: 'detached' });
  assert.equal(await bob.evaluate(()=>Object.keys(localStorage).some(key=>String(localStorage.getItem(key)).includes('只有房间成员可见'))),false);
  await alice.getByText('已禁止该用户加入。', { exact: true }).waitFor();
  assert.equal(await alice.locator('#rooms-title').textContent(), '成员管理');
  await alice.getByRole('group', { name: '成员范围' }).getByRole('button', { name: '禁止加入', exact: true }).click();
  await alice.locator('.room-member[data-account-id="sekai:bob"]').waitFor();
  await alice.locator('.rooms-back').click();
  await alice.getByRole('button', { name: '房间设置', exact: true }).click();
  await alice.getByRole('button', { name: '归档房间', exact: true }).click();
  await alice.getByRole('dialog').getByRole('button', { name: '归档房间', exact: true }).click();
  await alice.getByText('房间已归档。', { exact: true }).waitFor();
  assert.equal(await alice.locator('#messageInput').isDisabled(), true);
  assert.equal(await alice.locator('#stickerBtn').isDisabled(), true);
  assert.equal(await alice.evaluate(() => nightcord.ui.onSendMessage('已归档房间不得发送')), false);
  await alice.evaluate(()=>nightcord.rooms.reset());
  assert.equal(await alice.locator('#messages .message').count(),0);
  await clearLimits();
  await alice.locator('#managed-rooms').getByRole('button', { name: '导航', exact: true }).click();
  await alice.locator('#navigation-chat').click();
  await alice.waitForFunction(() => nightcord.chatRoom.wsManager.ready);
  assert.equal(await alice.locator('#managed-rooms').isVisible(), false);
  assert.equal(await alice.evaluate(() => nightcord.ui.currentRoom), 'nightcord-default');
  assert.equal(await alice.locator('#messageInput').isVisible(), true);
  assert.equal(await alice.locator('#attachmentBtn').isVisible(), true);
  assert.equal(await alice.locator('#messageInput').isDisabled(), false);
  assert.equal(await alice.locator('#messageInput').inputValue(), '官方频道未发送草稿');
  assert.equal(await alice.locator('#sidebar-tools').isVisible(), false);
  await bob.evaluate(() => { nightcord.rooms.reset(); return nightcord.roomsView.lobby(true); });
  await bob.getByText('登录后查看已加入的房间', { exact: true }).waitFor();
  assert.equal(await bob.locator('#managed-rooms').getByRole('button', { name: '使用 SEKAI Pass 登录', exact: true }).isVisible(), true);
  await bob.getByRole('button', { name: '公开房间', exact: true }).click();
  await bob.locator('.rooms-listing[aria-busy="false"]').waitFor();
  assert.equal(await bob.getByText('暂无公开房间', { exact: true }).count(), 0);
  await bob.evaluate(() => { nightcord.rooms.mode = 'off'; return nightcord.roomsView.lobby(); });
  assert.equal(await bob.getByRole('button', { name: '自习室', exact: true }).isVisible(), true);
  await bob.getByText('用户房间暂未开放', { exact: true }).waitFor();
  await clearLimits();
  await bob.getByRole('button', { name: '自习室', exact: true }).click();
  await bob.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentRoom === 'nightcord-study');
  assert.deepEqual(errors,[]);
});
