/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('private messaging works across real browsers, requests, hidden history, refusal, reconnection and logout', { timeout: 180000 }, async t => {
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
  const runtime = createRuntime({}, { origin, inspectDurableObjects: true, bindings: { DM_MODE: 'on' },
    identities: { 'Bearer alice': 'alice', 'Bearer bob': 'bob', 'Bearer eve': 'eve' },
    profiles: { alice: { name: '小夜', preferred_username: 'sayo', picture: '' },
      bob: { name: '遥', preferred_username: 'haru', picture: '' },
      eve: { name: '冬青', preferred_username: 'holly', picture: '' } } });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const errors = [];
  const screenshots = resolve(root, 'backend/dist/dm-screenshots'); await mkdir(screenshots, { recursive: true });
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
        if (String(url).includes('/api/dm/')) window.dmTestRequests.push({ path: new URL(url).pathname, method: options?.method || 'GET' });
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
  const alice = await pageFor('alice'), bob = await pageFor('bob', 390), eve = await pageFor('eve');
  await alice.waitForFunction(() => nightcord.ui.roster.some(member => member.profile?.id === 'sekai:bob'));
  await alice.locator('.sidebar .user[data-user-id="sekai:bob"], .sidebar .voice-user[data-user-id="sekai:bob"]').first().click();
  await alice.getByRole('button', { name: '发私信', exact: true }).click();
  await alice.locator('#dm-input').waitFor({ state: 'visible' });
  await alice.locator('#dm-input').fill('晚上好，刚才听到你分享的曲子，想问问名字。');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await alice.getByText('已发送私信请求，等待对方接受。', { exact: true }).waitFor();
  assert.equal(await alice.locator('#dm-input').isDisabled(), true);
  const id = await alice.evaluate(() => nightcord.directMessageView.active);
  await bob.waitForFunction(() => nightcord.directMessages.conversations.size === 1);
  await bob.evaluate(() => nightcord.directMessageView.open());
  assert.equal(await bob.locator('.dm-conversation').count(), 0);
  await bob.screenshot({ path: resolve(screenshots, 'request-notice.png') });
  await bob.getByRole('button', { name: '新的私信请求', exact: false }).click();
  await bob.locator('.dm-conversation').click();
  await bob.screenshot({ path: resolve(screenshots, 'request-review.png') });
  await bob.getByRole('button', { name: '接受请求', exact: true }).click();
  await alice.waitForFunction(() => !document.querySelector('#dm-input').disabled);
  await bob.waitForFunction(() => [...nightcord.directMessages.conversations.values()][0].unread === 0);
  // Let the previous command and read notifications settle before measuring one send.
  await bob.waitForTimeout(500);
  await alice.evaluate(() => { window.dmTestRequests.length = 0; });
  await bob.evaluate(() => { window.dmTestRequests.length = 0; });
  await bob.locator('#dm-input').fill('晚上好！是《ハロ／ハワユ》，我最近一直在循环。');
  await bob.getByRole('button', { name: '发送', exact: true }).click();
  await alice.locator('.dm-message-content').filter({ hasText: 'ハロ／ハワユ' }).waitFor();
  await alice.waitForFunction(() => [...nightcord.directMessages.conversations.values()][0].unread === 0);
  await alice.waitForTimeout(500);
  const sendRequests = [...await alice.evaluate(() => window.dmTestRequests), ...await bob.evaluate(() => window.dmTestRequests)];
  t.diagnostic('DM requests for one delivered/read message: ' + JSON.stringify(sendRequests));
  assert.equal(sendRequests.length, 3, 'one send, one history read, one read acknowledgement');
  assert.equal(sendRequests.filter(request => request.path.endsWith('/messages') && request.method === 'GET').length, 1);
  assert.equal(sendRequests.filter(request => request.path.endsWith('/read')).length, 1);
  assert.equal(await eve.evaluate(() => nightcord.directMessages.conversations.size), 0);
  assert.equal(await eve.locator('#messages').textContent().then(text => text.includes('刚才听到你分享')), false);
  assert.equal(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await bob.locator('.dm-sidebar').isVisible(), false);
  assert.equal(await alice.locator('#member-list-panel').isVisible(), false);
  assert.equal(await alice.locator('.dm-request-notice').isVisible(), false);
  assert.equal(await alice.locator('.dm-filters').count(), 0);
  const replyRow = alice.locator('.dm-message').filter({ hasText: 'ハロ／ハワユ' }).first();
  await alice.mouse.move(5, 5); await alice.locator('#dm-input').focus();
  assert.equal(await replyRow.locator('.dm-reply-button').evaluate(node => getComputedStyle(node).opacity), '0');
  await replyRow.focus();
  await alice.keyboard.press('Tab');
  assert.equal(await replyRow.locator('.dm-reply-button').evaluate(node => document.activeElement === node), true);
  await alice.keyboard.press('Enter');
  assert.equal(await alice.locator('#dm-input').evaluate(node => document.activeElement === node), true);
  await alice.getByRole('button', { name: '取消回复' }).click();
  await replyRow.hover();
  assert.equal(await replyRow.locator('.dm-reply-button').evaluate(node => getComputedStyle(node).opacity), '1');
  await replyRow.getByRole('button', { name: '回复此消息' }).click();
  assert.match(await alice.locator('.dm-reply').textContent(), /遥.*ハロ／ハワユ/);
  await clearLimits();
  await alice.locator('#dm-input').fill('找到了，前奏很好听。谢谢！');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await bob.locator('.dm-message-content').filter({ hasText: '找到了' }).waitFor();
  assert.match(await bob.locator('.dm-message-reply').textContent(), /你.*ハロ／ハワユ/);
  const touchRow = bob.locator('.dm-message').filter({ hasText: '找到了' }).last();
  await touchRow.tap();
  assert.equal(await touchRow.locator('.dm-reply-button').evaluate(node => getComputedStyle(node).opacity), '1');
  await touchRow.getByRole('button', { name: '回复此消息' }).tap();
  await bob.getByRole('button', { name: '取消回复' }).tap();
  await clearLimits();
  await bob.locator('#dm-input').fill('不客气，适合这样安静的晚上。');
  await bob.getByRole('button', { name: '发送', exact: true }).click();
  await alice.locator('.dm-message-content').filter({ hasText: '安静的晚上' }).waitFor();
  await alice.locator('#dm-input').fill('我也准备再写一会儿。');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await bob.locator('.dm-message-content').filter({ hasText: '再写一会儿' }).waitFor();
  await clearLimits();
  await alice.locator('#dm-input').fill('等下还在的话，一起听下一首吧。');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await bob.locator('.dm-message-content').filter({ hasText: '下一首' }).waitFor();
  await bob.locator('#dm-input').fill('好呀，写完这一段就来。');
  await bob.getByRole('button', { name: '发送', exact: true }).click();
  await alice.locator('.dm-message-content').filter({ hasText: '这一段' }).waitFor();
  await alice.mouse.move(5, 5); await alice.locator('#dm-input').focus();
  await alice.screenshot({ path: resolve(screenshots, 'desktop.png') });
  await bob.locator('#dm-input').blur();
  await bob.screenshot({ path: resolve(screenshots, 'mobile.png') });
  for (const palette of ['indigo', 'plum-orchid']) {
    await alice.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
    await alice.screenshot({ path: resolve(screenshots, palette + '.png') });
  }
  await alice.evaluate(() => { document.documentElement.dataset.palette = 'gray-purple'; document.documentElement.dataset.roundedCorners = 'off'; });
  assert.equal(await alice.locator('.dm-composer-box').evaluate(node => getComputedStyle(node).borderRadius), '0px');
  await alice.evaluate(() => { document.documentElement.dataset.roundedCorners = 'on'; });
  for (const [width, height] of [[375, 667], [844, 390]]) {
    await bob.evaluate(() => { document.documentElement.dataset.iosLayout = 'on'; });
    await bob.setViewportSize({ width, height });
    await bob.waitForFunction(() => {
      const box = document.querySelector('.dm-send').getBoundingClientRect();
      return box.width >= 44 && box.height >= 44 && box.bottom <= innerHeight;
    });
    assert.equal(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const controls = await bob.locator('.dm-send').boundingBox();
    assert.ok(controls.width >= 44 && controls.height >= 44 && controls.y + controls.height <= height);
    assert.ok((await bob.locator('.dm-log').boundingBox()).height > 100);
    await bob.waitForFunction(() => { const log = document.querySelector('.dm-log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 3; });
    await bob.screenshot({ path: resolve(screenshots, width === 375 ? 'small-phone.png' : 'landscape.png') });
  }
  await bob.evaluate(() => { delete document.documentElement.dataset.iosLayout; });
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.getByRole('button', { name: '返回会话列表' }).click();
  assert.equal(await bob.locator('.dm-thread').isVisible(), false);
  await bob.screenshot({ path: resolve(screenshots, 'mobile-list.png') });
  await bob.locator('.dm-manage summary').click();
  await bob.screenshot({ path: resolve(screenshots, 'management.png') });
  await bob.keyboard.press('Escape');
  assert.equal(await bob.locator('.dm-manage').evaluate(node => node.open), false);
  assert.equal(await bob.locator('.dm-panel').isVisible(), true);
  await bob.locator('.dm-conversation').click();
  await alice.locator('#navigation-chat').click();
  assert.equal(await alice.locator('#member-list-panel').isVisible(), true);
  await alice.locator('#navigation-dm').click();
  assert.equal(await alice.locator('#member-list-panel').isVisible(), false);
  await clearLimits();
  await bob.locator('.dm-settings summary').click();
  await bob.getByRole('button', { name: '隐藏会话', exact: true }).click();
  await bob.waitForFunction(() => [...nightcord.directMessages.conversations.values()][0].hidden);
  await bob.getByRole('button', { name: '恢复显示', exact: true }).waitFor();
  await alice.locator('#dm-input').fill('Hidden history survives');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await alice.locator('.dm-message-content').filter({ hasText: 'Hidden history survives' }).waitFor();
  await bob.waitForFunction(() => [...nightcord.directMessages.conversations.values()][0].incoming === 5);
  assert.equal(await bob.locator('.dm-log').isVisible(), false);
  assert.equal(await bob.locator('.dm-toast').count(), 0);
  const bobDesktop = await pageFor('bob');
  await bobDesktop.evaluate(() => nightcord.directMessageView.open());
  await bobDesktop.locator('.dm-manage summary').click();
  await bobDesktop.getByRole('button', { name: '已隐藏的会话' }).click();
  await bobDesktop.locator('.dm-conversation').click();
  assert.equal(await bobDesktop.locator('.dm-log').isVisible(), false);
  await clearLimits();
  await bob.getByRole('button', { name: '恢复显示', exact: true }).click();
  try { await bob.locator('.dm-message-content').filter({ hasText: 'Hidden history survives' }).waitFor(); }
  catch (error) {
    console.error(await bob.evaluate(() => ({
      conversations: [...nightcord.directMessages.conversations.values()], messages: [...nightcord.directMessages.messages],
      loading: [...nightcord.directMessages.loading.keys()], viewLoading: nightcord.directMessageView.loadingActive,
      failed: nightcord.directMessageView.failedLoad, error: document.querySelector('.dm-error').textContent,
      active: nightcord.directMessageView.active, requests: window.dmTestRequests,
    })));
    throw error;
  }
  await bobDesktop.locator('.dm-message-content').filter({ hasText: 'Hidden history survives' }).waitFor();
  await bob.locator('.dm-settings summary').click();
  await bob.getByRole('button', { name: '拒收消息', exact: true }).click();
  await bob.getByText('你已拒收对方的新消息。已有记录仍然保留。', { exact: true }).waitFor();
  await alice.locator('#dm-input').fill('Must be refused');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await alice.getByText('对方已拒收，消息未发送', { exact: false }).waitFor();
  assert.equal(await bob.locator('.dm-message-content').filter({ hasText: 'Must be refused' }).count(), 0);
  await clearLimits();
  await bob.locator('.dm-settings summary').click();
  await bob.getByRole('button', { name: '解除拒收', exact: true }).click();
  await bob.waitForFunction(() => ![...nightcord.directMessages.conversations.values()][0].refuseIncoming);
  await alice.getByRole('button', { name: '重试发送', exact: true }).click();
  await bob.locator('.dm-message-content').filter({ hasText: 'Must be refused' }).waitFor();
  await alice.waitForFunction(() => [...nightcord.directMessages.pending.values()].every(items => items.length === 0));
  await clearLimits();
  await alice.locator('#dm-input').fill('<img src=x onerror="window.dmInjected=1"> @Nako');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await bob.locator('.dm-message-content').filter({ hasText: '<img src=x' }).waitFor();
  assert.equal(await bob.locator('.dm-message-content img[src="x"]').count(), 0);
  assert.equal(await bob.evaluate(() => window.dmInjected), undefined);
  assert.equal(await bob.evaluate(() => nightcord.ai.messages.some(message => message.text.includes('刚才听到你分享'))), false);
  await clearLimits();
  await alice.getByRole('button', { name: '贴纸', exact: true }).click();
  await alice.locator('#dm-picker').getByRole('button', { name: '[test_你好]', exact: true }).click();
  assert.equal(await alice.locator('#dm-input').inputValue(), '[test_你好]');
  await alice.getByRole('button', { name: '发送', exact: true }).click();
  await bob.locator('.dm-sticker').waitFor();
  // Receiving while reading must preserve both the focused message and text selection.
  await alice.locator('#dm-input').focus();
  await alice.waitForFunction(() => nightcord.directMessages.conversations.get(nightcord.directMessageView.active).unread === 0);
  await alice.evaluate(() => {
    const row = document.querySelector('.dm-message'); row.focus();
    const range = document.createRange(); range.selectNodeContents(row.querySelector('.dm-message-content'));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.dmFocusedMessage = row; window.dmSelectedText = selection.toString();
  });
  await clearLimits();
  await bob.evaluate(id => nightcord.directMessages.send(id, { text: 'Keep reading this conversation' }), id);
  await alice.locator('.dm-message-content').filter({ hasText: 'Keep reading this conversation' }).waitFor();
  assert.equal(await alice.evaluate(() => document.activeElement === window.dmFocusedMessage), true);
  assert.equal(await alice.evaluate(() => getSelection().toString() === window.dmSelectedText), true);
  await alice.evaluate(() => { getSelection().removeAllRanges(); const log = document.querySelector('.dm-log'); log.scrollTop = log.scrollHeight; });
  await alice.locator('#dm-input').focus();
  await alice.waitForFunction(() => nightcord.directMessages.conversations.get(nightcord.directMessageView.active).unread === 0);
  // A modal can cover an otherwise visible log. Those messages remain unread.
  await alice.evaluate(() => {
    const dialog = document.createElement('dialog'); dialog.id = 'dm-test-dialog';
    dialog.innerHTML = '<button>Modal task</button>'; document.body.append(dialog); dialog.showModal();
  });
  await clearLimits();
  await bob.evaluate(id => nightcord.directMessages.send(id, { text: 'Unread behind the dialog' }), id);
  await alice.locator('.dm-message-content').filter({ hasText: 'Unread behind the dialog' }).waitFor();
  await alice.waitForTimeout(500);
  assert.equal(await alice.evaluate(() => nightcord.directMessages.conversations.get(nightcord.directMessageView.active).unread), 1);
  assert.equal(await alice.locator('.dm-toast').getByRole('button', { name: '关闭私信提醒' }).count(), 1);
  await alice.evaluate(() => { const dialog = document.querySelector('#dm-test-dialog'); dialog.close(); dialog.remove(); });
  await alice.locator('#dm-input').focus();
  await alice.waitForFunction(() => nightcord.directMessages.conversations.get(nightcord.directMessageView.active).unread === 0);
  await alice.getByRole('button', { name: '关闭私信提醒' }).click();
  // A delayed creation must not reopen or select its thread after navigation.
  await clearLimits();
  await alice.evaluate(() => {
    const manager = nightcord.directMessages, create = manager.create.bind(manager);
    manager.create = (...args) => new Promise(resolve => { window.dmReleaseCreate = () => resolve(create(...args)); });
    window.dmOpening = nightcord.directMessageView.start({ id: 'sekai:eve' });
    manager.create = create;
  });
  await alice.locator('#navigation-chat').click();
  await alice.evaluate(async () => { window.dmReleaseCreate(); await window.dmOpening; });
  assert.equal(await alice.locator('.dm-panel').isVisible(), false);
  assert.equal(await alice.evaluate(() => nightcord.directMessageView.active), id);
  await alice.evaluate(() => nightcord.directMessages.socket.close());
  await alice.waitForFunction(() => nightcord.directMessages.ready);
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await alice.waitForFunction(() => nightcord.directMessages.ready);
  await alice.evaluate(id => nightcord.directMessageView.open(id), id);
  await alice.locator('.dm-message-content').filter({ hasText: '刚才听到你分享' }).waitFor();
  assert.equal(await alice.evaluate(() => Object.keys(localStorage).some(key => localStorage.getItem(key)?.includes('刚才听到你分享'))), false);
  await alice.evaluate(() => nightcord.ui.onLogout());
  await alice.waitForFunction(() => nightcord.directMessages.user === null);
  assert.equal(await alice.locator('.dm-message').count(), 0);
  assert.equal(await alice.locator('.dm-thread-header').textContent(), '');
  assert.equal(await alice.locator('.dm-request').textContent(), '');
  assert.equal(await alice.evaluate(() => nightcord.directMessages.messages.size), 0);
  assert.deepEqual(errors, []);
});
