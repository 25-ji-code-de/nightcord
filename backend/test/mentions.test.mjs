/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('mention composition, delivery and actions', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const scripts = await Promise.all([
    'purify.js', 'sekai-escape.js', 'event-bus.js', 'ai-config.js', 'storage-manager.js',
    'file-upload-service.js', 'sekai-renderer.js', 'mention-service.js', 'ui-autocomplete.js',
    'user-profile.js', 'ui-manager.js', 'pangu.js',
  ].map(file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8')));
  const styles = await Promise.all(['app-shell', 'renderer', 'notifications'].map(file =>
    readFile(new URL(`../../css/${file}.css`, import.meta.url), 'utf8')));

  async function fixture(t, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <style>
        .hidden { display: none; }
        #messages { height: 300px; overflow-y: auto; }
        #mention-list { position: static; }
        #messageInput { width: 250px; }
      </style>
      <main class="main"><div class="channel"><span>Test</span></div><div id="messages"></div>
      <textarea id="messageInput" maxlength="256"></textarea>
      <div id="mention-list" class="mention-list hidden"></div><div id="voice-users"></div></main>` }));
    await page.goto('http://nightcord-mentions.test/');
    for (const content of styles) await page.addStyleTag({ content });
    for (const content of scripts) await page.addScriptTag({ content });
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus());
      window.me = { id: 'sekai:one', displayName: 'Same', authenticated: true, username: 'member-one' };
      window.peer = { id: 'guest:two', displayName: 'Same', authenticated: false };
      window.sent = []; window.asks = []; window.notices = []; window.sendOK = true;
      ui.eventBus.on('nako:ask', data => asks.push(data));
      ui.eventBus.on('message:mentioned', data => notices.push(data));
      ui.eventBus.emit('session:updated', { user: me });
      ui.eventBus.emit('user:joined', { username: peer.displayName, user: peer });
      ui.eventBus.emit('room:ready', { roomname: 'mention-test' });
      ui.setupChatRoom(message => {
        if (!sendOK) return false;
        sent.push(message);
        ui.eventBus.emit('message:sent', { message });
        return true;
      });
    });
    return page;
  }

  await t.test('same-name users stay separate and selection emits an intact identity token', async t => {
    const page = await fixture(t);
    const input = page.locator('#messageInput');
    await page.evaluate(() => {
      ui.messages.push(
        { user: 'Same', text: 'legacy without ID' },
        { user: 'Old name', text: 'legacy alias' },
        { user: 'Nako', text: 'AI reply' },
      );
    });
    await input.fill('@Same');
    assert.equal(await page.locator('.mention-item[data-type="user"]').count(), 2);
    assert.equal(await page.locator('.mention-item[data-id="sekai:one"] .mention-detail').textContent(), '账号 · @member-one');
    assert.equal(await page.locator('.mention-item[data-id="guest:two"] .mention-detail').textContent(), '访客 · two');
    await input.fill('@Nako');
    assert.equal(await page.locator('.mention-item').count(), 1);
    assert.equal(await page.locator('.mention-item').getAttribute('data-type'), 'ai');
    await input.fill('@Same');
    await page.locator('.mention-item[data-id="guest:two"]').click();
    assert.match(await input.inputValue(), /type=user;display=Same:guest:two>/);
    await page.keyboard.insertText('你好');
    await input.press('Enter');
    const result = await page.evaluate(() => ({ sent, asks }));
    assert.equal(result.sent.length, 1);
    assert.match(result.sent[0], /:guest:two>.*你好/);
    assert.deepEqual(result.asks, []);
  });

  await t.test('suggestions show profile avatars with fallbacks and compact AI and everyone icons', async t => {
    const page = await fixture(t, { width: 375, height: 812 });
    await page.route('https://avatars.example.test/**', route => route.request().url().endsWith('/broken')
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#a78bfa"/></svg>' }));
    await page.evaluate(() => {
      ui.addUserToRoster(me.displayName, { ...me, avatarUrl: 'https://avatars.example.test/live' });
      ui.addUserToRoster('Broken', { id: 'sekai:broken', displayName: 'Broken', authenticated: true, avatarUrl: 'https://avatars.example.test/broken' });
      ui.addUserToRoster('Unsafe', { id: 'sekai:unsafe', displayName: 'Unsafe', authenticated: true, avatarUrl: 'javascript:alert(1)' });
      const offline = { id: 'sekai:offline', displayName: 'Offline', authenticated: true, avatarUrl: 'https://avatars.example.test/cached' };
      ui.storage.rememberProfile(offline);
      ui.messages.push({ user: 'Old name', text: 'old message', profile: { ...offline, avatarUrl: null } });
    });
    const input = page.locator('#messageInput');
    await input.fill('@');
    await page.waitForFunction(() => ['sekai:one', 'sekai:offline'].every(id => {
      const image = document.querySelector(`.mention-item[data-id="${id}"] .avatar img`);
      return image?.complete && image.naturalWidth > 0;
    }));
    assert.equal(await page.locator('.mention-item[data-id="sekai:one"] img').getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await page.locator('.mention-item[data-id="sekai:offline"] img').getAttribute('src'), 'https://avatars.example.test/cached');
    await page.waitForFunction(() => document.querySelector('.mention-item[data-id="sekai:broken"] .avatar')?.textContent === 'B');
    assert.equal(await page.locator('.mention-item[data-id="sekai:unsafe"] img').count(), 0);
    assert.equal(await page.locator('.mention-item[data-id="guest:two"] .avatar').textContent(), 'S');
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.locator('.mention-item[data-type="all"], .mention-item[data-type="ai"]').evaluateAll(items => items.map(item => ({
        height: item.getBoundingClientRect().height,
        icon: item.querySelector('.avatar svg')?.getAttribute('aria-hidden'),
        status: getComputedStyle(item.querySelector('.status-indicator')).display,
        direction: getComputedStyle(item.querySelector('.mention-identity')).flexDirection,
      })));
      assert.equal(layout.length, 5);
      assert.ok(layout.every(row => row.height === 44 && row.icon === 'true' && row.status === 'none' && row.direction === 'row'));
    }
  });

  await t.test('keyboard AI selection submits once and incoming messages do not invoke AI', async t => {
    const page = await fixture(t);
    const input = page.locator('#messageInput');
    await input.fill('@汤');
    await input.press('Enter');
    assert.match(await input.inputValue(), /type=ai;display=汤川唯:yui>/);
    assert.deepEqual(await page.evaluate(() => ({ sent, asks })), { sent: [], asks: [] });
    await page.keyboard.insertText('你好');
    await input.press('Enter');
    let result = await page.evaluate(() => ({ sent, asks }));
    assert.equal(result.sent.length, 1);
    assert.deepEqual(result.asks, [{ persona: 'yui', prompt: '你好' }]);
    await page.evaluate(() => {
      ui.eventBus.emit('message:received', { name: 'Same', message: sent[0], timestamp: 100, user: peer });
      ui.eventBus.emit('message:received', { name: '汤川唯', message: '你好呀', timestamp: 101, isNako: true, sender: peer });
    });
    assert.equal(await page.evaluate(() => asks.length), 1);
    const chip = page.locator('.sekai-mention-ai');
    await chip.focus();
    await chip.press('Space');
    assert.match(await input.inputValue(), /type=ai.*:yui>/);
    assert.equal(await page.evaluate(() => asks.length), 1);
  });

  await t.test('empty prompts, composition and failed sends preserve drafts without invoking AI', async t => {
    const page = await fixture(t);
    const input = page.locator('#messageInput');
    await input.fill('/nako');
    await input.press('Enter');
    assert.equal(await input.inputValue(), '/nako');
    await input.fill('/nako 你好');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.deepEqual(await page.evaluate(() => ({ sent, asks })), { sent: [], asks: [] });
    await page.evaluate(() => { sendOK = false; });
    await input.press('Enter');
    assert.equal(await input.inputValue(), '/nako 你好');
    assert.deepEqual(await page.evaluate(() => ({ sent, asks })), { sent: [], asks: [] });
  });

  await t.test('mention insertion keeps the existing text intact at the length limit', async t => {
    const page = await fixture(t);
    const input = page.locator('#messageInput');
    const draft = 'x'.repeat(248) + ' @ev';
    await input.fill(draft);
    await input.press('Enter');
    assert.equal(await input.inputValue(), draft);
    assert.deepEqual(await page.evaluate(() => ({ sent, asks })), { sent: [], asks: [] });
  });

  await t.test('everyone notices ignore replay, duplicates and own messages, and resume on reconnect', async t => {
    const page = await fixture(t, { width: 375, height: 812 });
    await page.evaluate(() => {
      ui.eventBus.emit('roster:clear');
      const history = { name: 'Same', user: peer, message: '<$SEKAI:Mention:type=all:> history', timestamp: 200 };
      ui.eventBus.emit('message:received', history);
      ui.eventBus.emit('room:synced', { roomname: 'mention-test' });
      ui.eventBus.emit('message:received', { ...history, user: me, timestamp: 201 });
    });
    assert.equal(await page.locator('.mention-notice').count(), 0);
    await page.evaluate(() => {
      const live = { name: '<img onerror=alert(1)>', user: peer, message: '<$SEKAI:Mention:type=all:> live', timestamp: 202 };
      ui.eventBus.emit('message:received', live);
      ui.eventBus.emit('message:received', live);
    });
    assert.equal(await page.evaluate(() => notices.length), 1);
    assert.equal(await page.locator('.mention-notice img').count(), 0);
    await page.locator('.message[data-timestamp="202"].mentioned').waitFor();
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      const box = await page.locator('.mention-notice').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
    }
    await page.locator('.mention-notice button').first().click();
    assert.equal(await page.locator('.mention-notice').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.timestamp), '202');
  });

  await t.test('profile chips resolve the latest exact identity and role remains display only', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
      ui.eventBus.emit('message:received', {
        name: 'Same', user: peer, timestamp: 300,
        message: '<$SEKAI:Mention:type=user;display=Same:guest:two> <$SEKAI:Mention:type=role;display=Team:team>',
      });
    });
    const chip = page.locator('.sekai-mention-user');
    await chip.waitFor();
    await page.evaluate(() => ui.addUserToRoster('Renamed', { ...peer, displayName: 'Renamed' }));
    await chip.focus();
    await chip.press('Enter');
    assert.equal(await page.locator('#profile-title').textContent(), 'Renamed');
    assert.equal(await page.locator('.profile-id').textContent(), 'guest:two');
    assert.equal(await page.locator('.sekai-mention-role[role="button"]').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('sekai-mention-user')), true);
  });
});
