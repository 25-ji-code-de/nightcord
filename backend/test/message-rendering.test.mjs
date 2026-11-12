/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const scripts = [
  'purify.js', 'sekai-escape.js', 'performance-optimizer.js', 'event-bus.js',
  'ai-config.js', 'storage-manager.js', 'file-upload-service.js', 'sekai-renderer.js',
  'user-profile.js', 'ui-manager.js',
];

test('message rendering batches updates without losing or duplicating messages', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const sources = await Promise.all(scripts.map(async file => ({
    file, content: await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'),
  })));

  async function fixture(t, { optimizer = true, taskScheduler = true } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    t.after(() => assert.deepEqual(errors, []));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <style>
        #messages { width: 600px; height: 300px; overflow-y: auto; }
        .message { display: flex; min-height: 40px; padding: 8px; }
      </style>
      <div class="channel" id="navigation-channel"><span class="channel-icon"></span><span class="channel-name"></span></div>
      <div id="messages"></div><textarea id="messageInput"></textarea>
      <div id="online-users"></div><div id="voice-users"></div><div id="offline-users"></div>` }));
    await page.goto('http://nightcord-rendering.test/');
    if (!taskScheduler) await page.evaluate(() => Object.defineProperty(window, 'scheduler', { value: undefined, configurable: true }));
    for (const { file, content } of sources) {
      if (!optimizer && file === 'performance-optimizer.js') continue;
      await page.addScriptTag({ content });
    }
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus());
      window.nextFrame = () => new Promise(requestAnimationFrame);
      window.renderComplete = async () => {
        do { await nextFrame(); } while (ui.messageRenderFrame !== null || ui.messageBuild);
      };
      window.counts = { created: 0, heightReads: 0, scrollWrites: 0 };
      const create = ui.createMessageElement;
      ui.createMessageElement = function (message) {
        counts.created++;
        performance.mark('message-created');
        return create.call(this, message);
      };
      const chatlog = ui.elements.chatlog;
      const height = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperties(chatlog, {
        scrollHeight: { get() { counts.heightReads++; return height.get.call(this); } },
        scrollTop: {
          get() { return top.get.call(this); },
          set(value) { counts.scrollWrites++; top.set.call(this, value); performance.mark('messages-scrolled'); },
        },
      });
      window.rows = () => [...chatlog.querySelectorAll('.message-text')].map(el => el.textContent);
      window.seed = (count = 40) => {
        ui.messages = Array.from({ length: count }, (_, i) => ui.createMessageData('User', `Message ${i}`, 1700000000000 + i));
        ui.renderMessages();
      };
    });
    return page;
  }

  await t.test('member groups follow voice, device and presence changes without duplicating identities', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(() => {
      const pass = { id: 'sekai:one', displayName: 'Same name', authenticated: true, isMobile: true };
      const offline = { id: 'sekai:offline', displayName: 'Offline Pass', authenticated: true };
      const guest = { id: 'guest:two', displayName: 'Same name', authenticated: false };
      const ids = container => [...container.children].map(row => row.dataset.userId);
      const groups = () => ({ online: ids(ui.elements.roster), voice: ids(ui.elements.voiceRoster), offline: ids(ui.elements.offlineRoster) });
      ui.eventBus.emit('room:members', { users: [pass, offline, guest] });
      ui.addUserToRoster(pass.displayName, pass);
      ui.addUserToRoster(guest.displayName, guest);
      const row = ui.elements.roster.firstElementChild;
      const initial = groups();
      const callIconsHidden = () => row.querySelector('.member-microphone').hidden && row.querySelector('.member-video').hidden;
      const textIconsHidden = callIconsHidden();
      const members = [{ memberId: 'voice-one', user: pass, publishing: true }, { memberId: 'voice-two', user: guest, publishing: true, microphone: false }];
      ui.eventBus.emit('voice:state', { snapshot: { revision: 1, members } });
      const voice = groups();
      const voiceIconsVisible = !row.querySelector('.member-microphone').hidden && !row.querySelector('.member-video').hidden;
      const mobile = row.querySelector('.member-presence').dataset.presence;
      const micOn = row.querySelector('.member-microphone').dataset.microphone;
      const guestMic = ui.elements.voiceRoster.lastElementChild.querySelector('.member-microphone').dataset.microphone;
      ui.eventBus.emit('voice:activity', ['voice-one']);
      const speaking = row.classList.contains('is-speaking');
      ui.eventBus.emit('voice:changed', { joined: true, memberId: 'voice-one', microphone: false });
      const localMute = row.querySelector('.member-microphone').dataset.microphone;
      ui.eventBus.emit('voice:state', { snapshot: { revision: 2, members: [members[1]] } });
      ui.eventBus.emit('voice:state', { snapshot: { revision: 1, members } });
      ui.addUserToRoster('Renamed', { ...pass, displayName: 'Renamed', isMobile: false });
      const returned = groups();
      const returnedIconsHidden = callIconsHidden();
      const desktop = row.querySelector('.member-presence').dataset.presence;
      const sameRow = row === ui.elements.roster.firstElementChild;
      ui.removeUserFromRoster('Renamed', pass.id);
      const departed = groups();
      const offlineState = row.classList.contains('is-offline') && row.querySelector('.member-presence').hidden && row.querySelector('.member-microphone').hidden;
      ui.eventBus.emit('voice:state', { snapshot: { revision: 3, members: [] } });
      ui.removeUserFromRoster(guest.displayName, guest.id);
      const guestGone = groups();
      const opened = [];
      ui.profileUI.open = profile => opened.push(profile.displayName);
      row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      ui.eventBus.emit('roster:clear');
      return { initial, voice, returned, departed, guestGone, mobile, desktop, micOn, guestMic, localMute, speaking, sameRow, offlineState, textIconsHidden, voiceIconsVisible, returnedIconsHidden, opened, cleared: groups() };
    });
    assert.deepEqual(result.initial, { online: ['sekai:one', 'guest:two'], voice: [], offline: ['sekai:offline'] });
    assert.deepEqual(result.voice, { online: [], voice: ['sekai:one', 'guest:two'], offline: ['sekai:offline'] });
    assert.deepEqual(result.returned, { online: ['sekai:one'], voice: ['guest:two'], offline: ['sekai:offline'] });
    assert.deepEqual(result.departed, { online: [], voice: ['guest:two'], offline: ['sekai:one', 'sekai:offline'] });
    assert.deepEqual(result.guestGone, { online: [], voice: [], offline: ['sekai:one', 'sekai:offline'] });
    assert.equal(result.mobile, 'mobile'); assert.equal(result.desktop, 'online');
    assert.equal(result.micOn, 'true'); assert.equal(result.guestMic, 'false'); assert.equal(result.localMute, 'false');
    assert.ok(result.speaking && result.sameRow && result.offlineState);
    assert.ok(result.textIconsHidden && result.voiceIconsVisible && result.returnedIconsHidden);
    assert.deepEqual(result.opened, ['Renamed']);
    assert.deepEqual(result.cleared, { online: [], voice: [], offline: [] });
  });

  await t.test('AI echoes confirm one message through replay and reload', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      ui.currentRoom = 'ai-test';
      ui.currentUser = { id: 'sekai:one', displayName: '47177171806', authenticated: true };
      ui.onSendMessage = () => true;
      const text = '嗯……我在。\n怎么突然@我……是有什么事吗？';
      ui.eventBus.emit('nako:stream:start', { messageId: 'ai-1', user: '汤川唯' });
      ui.eventBus.emit('nako:stream:chunk', { messageId: 'ai-1', chunk: text });
      ui.eventBus.emit('nako:stream:end', { messageId: 'ai-1', user: '汤川唯', fullContent: text, reasoning: 'local detail' });
      const localTimestamp = ui.messages[0].timestamp;
      const serverTimestamp = localTimestamp - 1000;
      const echo = { name: '汤川唯', message: text, timestamp: serverTimestamp, isNako: true, sender: ui.currentUser };
      ui.eventBus.emit('message:received', echo);
      await nextFrame();
      const confirmed = {
        count: rows().length,
        timestamp: ui.messages[0].timestamp,
        sender: ui.messages[0].sender?.id,
        badge: ui.elements.chatlog.querySelector('.identity-badge')?.textContent,
        reasoning: ui.elements.chatlog.querySelector('.nako-thinking-icon')?.title,
        preview: ui.lookupReplyMeta(serverTimestamp),
        staleIndex: ui.messageIndex.has(localTimestamp),
      };
      // A reconnect replays the same server message after temporary UI state is gone.
      ui.setCurrentRoom('ai-test');
      await nextFrame();
      ui.eventBus.emit('message:received', echo);
      await nextFrame();
      const stored = ui.storage.loadMessages('ai-test');
      return { confirmed, rows: rows(), stored, serverTimestamp };
    });
    assert.equal(result.confirmed.count, 1);
    assert.equal(result.confirmed.timestamp, result.serverTimestamp);
    assert.equal(result.confirmed.sender, 'sekai:one');
    assert.equal(result.confirmed.badge, '由 47177171806 转发');
    assert.equal(result.confirmed.reasoning, 'local detail');
    assert.equal(result.confirmed.preview.name, '汤川唯');
    assert.equal(result.confirmed.staleIndex, false);
    assert.equal(result.rows.length, 1);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].timestamp, result.serverTimestamp);
    assert.equal(result.stored[0].sender.id, 'sekai:one');
  });

  await t.test('identical AI replies from other senders or personas are kept', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      ui.currentRoom = 'ai-test';
      ui.currentUser = { id: 'sekai:one', displayName: 'Same', authenticated: true };
      ui.onSendMessage = () => true;
      const other = { id: 'guest:two', displayName: 'Same', authenticated: false };
      const text = '你好';
      ui.eventBus.emit('nako:stream:start', { messageId: 'ai-1', user: '汤川唯' });
      ui.eventBus.emit('nako:stream:end', { messageId: 'ai-1', user: '汤川唯', fullContent: text });
      ui.startStreamingMessage('still-streaming', 'Miku');
      ui.eventBus.emit('message:received', { name: '汤川唯', message: text, timestamp: 100, isNako: true, sender: other });
      ui.eventBus.emit('message:received', { name: 'Nako', message: text, timestamp: 101, isNako: true, sender: ui.currentUser });
      ui.eventBus.emit('message:received', { name: '汤川唯', message: text, timestamp: 102, isNako: true, sender: ui.currentUser });
      await nextFrame();
      return {
        replies: ui.messages.map(m => ({ user: m.user, sender: m.sender?.id, timestamp: m.timestamp })),
        count: rows().length,
        streamPresent: !!ui.elements.chatlog.querySelector('[data-message-id="still-streaming"]'),
      };
    });
    assert.equal(result.replies.length, 3);
    assert.equal(result.count, 3);
    assert.deepEqual(result.replies.map(m => [m.user, m.sender, m.timestamp]).sort(), [
      ['汤川唯', 'sekai:one', 102], ['汤川唯', 'guest:two', 100], ['Nako', 'sekai:one', 101],
    ].sort());
    assert.equal(result.streamPresent, true);
  });

  await t.test('unconfirmed AI previews are not persisted or hidden by a short timeout', async t => {
    const page = await fixture(t);
    await page.evaluate(async () => {
      ui.currentRoom = 'ai-test';
      ui.currentUser = { id: 'sekai:one', displayName: 'User', authenticated: true };
      ui.onSendMessage = () => true;
      ui.eventBus.emit('nako:stream:start', { messageId: 'ai-1', user: '汤川唯' });
      ui.eventBus.emit('nako:stream:end', { messageId: 'ai-1', user: '汤川唯', fullContent: '迟到的回复' });
      ui.renderMessages();
      await nextFrame();
    });
    assert.equal(await page.evaluate(() => ui.storage.loadMessages('ai-test').length), 0);
    await page.waitForTimeout(5200);
    const result = await page.evaluate(async () => {
      ui.eventBus.emit('message:received', { name: '汤川唯', message: '迟到的回复', timestamp: 103, isNako: true, sender: ui.currentUser });
      await nextFrame();
      return { count: rows().length, stored: ui.storage.loadMessages('ai-test'), timestamp: ui.messages[0].timestamp };
    });
    assert.equal(result.count, 1);
    assert.equal(result.stored.length, 1);
    assert.equal(result.timestamp, 103);
  });

  await t.test('separate identical calls each receive their own confirmation', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      ui.currentRoom = 'ai-test';
      ui.currentUser = { id: 'sekai:one', displayName: 'User', authenticated: true };
      ui.onSendMessage = () => true;
      for (const messageId of ['ai-1', 'ai-2']) {
        ui.eventBus.emit('nako:stream:start', { messageId, user: '汤川唯' });
        ui.eventBus.emit('nako:stream:end', { messageId, user: '汤川唯', fullContent: '你好' });
      }
      const echo = { name: '汤川唯', message: '你好', timestamp: 104, isNako: true, sender: ui.currentUser };
      ui.eventBus.emit('message:received', echo);
      ui.eventBus.emit('message:received', echo);
      const afterReplay = ui.storage.loadMessages('ai-test').length;
      ui.eventBus.emit('message:received', { ...echo, timestamp: 105 });
      await nextFrame();
      return { count: rows().length, timestamps: ui.messages.map(m => m.timestamp), stored: ui.storage.loadMessages('ai-test'), afterReplay };
    });
    assert.equal(result.afterReplay, 1);
    assert.equal(result.count, 2);
    assert.deepEqual(result.timestamps, [104, 105]);
    assert.deepEqual(result.stored.map(m => m.timestamp), [104, 105]);
  });

  for (const order of ['ready-first', 'message-first']) {
    await t.test(`room readiness and incoming messages in one frame: ${order}`, async t => {
      const page = await fixture(t);
      const result = await page.evaluate(async order => {
        ui.currentRoom = 'test-room';
        const ready = () => ui.eventBus.emit('room:ready', { roomname: 'test-room' });
        const receive = () => ui.eventBus.emit('message:received', {
          name: 'User', message: 'new arrival', timestamp: 1700000001000,
        });
        if (order === 'ready-first') { ready(); receive(); } else { receive(); ready(); }
        await nextFrame();
        return { rows: rows(), model: ui.messages.map(m => m.text), counts };
      }, order);
      assert.deepEqual(result.rows, result.model);
      assert.equal(result.rows.filter(text => text === 'new arrival').length, 1);
      assert.equal(result.counts.created, result.model.length);
      assert.equal(result.counts.heightReads, 1);
      assert.equal(result.counts.scrollWrites, 1);
    });
  }

  await t.test('repeated rebuild requests render once and measure the actual DOM work', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      seed(100);
      ui.renderMessages();
      ui.renderMessages();
      const before = { rows: rows().length, measures: performance.getEntriesByName('renderMessages').length };
      await renderComplete();
      const measure = performance.getEntriesByName('renderMessages')[0];
      return {
        before, rows: rows().length, counts,
        measures: performance.getEntriesByName('renderMessages').length,
        measuredStart: measure.startTime, measuredEnd: measure.startTime + measure.duration,
        firstCreated: performance.getEntriesByName('message-created')[0].startTime,
        scrolled: performance.getEntriesByName('messages-scrolled')[0].startTime,
        bottom: ui.elements.chatlog.scrollTop + ui.elements.chatlog.clientHeight >= ui.elements.chatlog.scrollHeight - 1,
      };
    });
    assert.deepEqual(result.before, { rows: 0, measures: 0 });
    assert.equal(result.rows, 100);
    assert.equal(result.counts.created, 100);
    assert.equal(result.counts.scrollWrites, 1);
    assert.equal(result.measures, 1);
    assert.ok(result.measuredStart <= result.firstCreated);
    assert.ok(result.measuredEnd >= result.scrolled);
    assert.equal(result.bottom, true, 'scroll completes in the same frame as the rebuild');
  });

  await t.test('a burst appends once, preserving existing nodes and the active stream', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      seed(); await nextFrame();
      const first = ui.elements.chatlog.firstElementChild;
      const stream = ui.startStreamingMessage('stream-1', 'Nako');
      counts.created = counts.heightReads = counts.scrollWrites = 0;
      for (let i = 0; i < 25; i++) ui.addSystemMessage(`burst ${i}`, 1700000100000 + i);
      await nextFrame();
      return {
        counts, rows: rows(), sameFirst: first === ui.elements.chatlog.firstElementChild,
        sameStream: stream === ui.elements.chatlog.lastElementChild,
      };
    });
    assert.equal(result.sameFirst, true);
    assert.equal(result.sameStream, true);
    assert.equal(result.rows.length, 65);
    assert.deepEqual(result.rows.slice(-25), Array.from({ length: 25 }, (_, i) => `burst ${i}`));
    assert.deepEqual(result.counts, { created: 25, heightReads: 1, scrollWrites: 1 });
  });

  await t.test('large history yields to input, includes arrivals and keeps the active stream', async t => {
    const page = await fixture(t);
    const partial = await page.evaluate(async () => {
      seed(3); await renderComplete();
      window.previousRows = [...ui.elements.chatlog.children];
      counts.created = counts.heightReads = counts.scrollWrites = 0;
      seed(600); await nextFrame();
      ui.addSystemMessage('arrived during history', 1700000020000);
      window.activeStream = ui.startStreamingMessage('during-history', 'Nako');
      document.querySelector('#messageInput').addEventListener('input', () => window.inputDuringBuild = !!ui.messageBuild);
      return { pending: !!ui.messageBuild, created: counts.created,
        oldRowsConnected: previousRows.every(row => row.isConnected) };
    });
    assert.equal(partial.pending, true);
    assert.ok(partial.created > 0 && partial.created < 600);
    assert.equal(partial.oldRowsConnected, true);
    await page.locator('#messageInput').fill('draft while loading');
    const result = await page.evaluate(async () => {
      await renderComplete();
      const log = ui.elements.chatlog;
      return { rows: rows(), inputDuringBuild, stream: log.lastElementChild === activeStream,
        indexesConnected: [...ui.messageIndex.values()].every(row => row.isConnected),
        bottom: log.scrollHeight - log.clientHeight - log.scrollTop < 1 };
    });
    assert.equal(result.inputDuringBuild, true);
    assert.equal(await page.locator('#messageInput').inputValue(), 'draft while loading');
    assert.equal(result.rows.length, 601);
    assert.equal(result.rows.filter(text => text === 'arrived during history').length, 1);
    assert.equal(result.stream, true);
    assert.equal(result.indexesConnected, true);
    assert.equal(result.bottom, true);
  });

  await t.test('switching rooms cancels unfinished history before it can replace the new room', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      seed(120); await nextFrame();
      const pending = !!ui.messageBuild;
      ui.storage.saveMessages('replacement', [{ user: 'Other', text: 'replacement room', timestamp: 1700000090000 }]);
      ui.setCurrentRoom('replacement');
      await renderComplete();
      await nextFrame();
      return { pending, rows: rows(), index: [...ui.messageMeta.values()].map(m => m.text) };
    });
    assert.equal(result.pending, true);
    assert.deepEqual(result.rows, ['replacement room']);
    assert.deepEqual(result.index, ['replacement room']);
  });

  await t.test('AI confirmation during a history build keeps one reply and its server identity', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      ui.currentRoom = 'ai-history';
      ui.currentUser = { id: 'sekai:one', displayName: 'User', authenticated: true };
      ui.onSendMessage = () => true;
      ui.startStreamingMessage('ai-history', 'Nako');
      ui.finishStreamingMessage('ai-history', 'Nako', 'confirmed during build');
      const local = ui.messages[0];
      const localTimestamp = local.timestamp;
      const history = Array.from({ length: 120 }, (_, i) => ui.createMessageData('User', `History ${i}`, 1700000000000 + i));
      ui.messages = [local, ...history];
      ui.renderMessages(); await nextFrame();
      const pending = !!ui.messageBuild;
      const serverTimestamp = 1700000090000;
      ui.eventBus.emit('message:received', { name: 'Nako', message: local.text, timestamp: serverTimestamp, isNako: true, sender: ui.currentUser });
      await renderComplete();
      const confirmed = ui.messageIndex.get(serverTimestamp);
      return { pending, replies: rows().filter(text => text === local.text).length,
        total: rows().length, sender: ui.messages.find(message => message.timestamp === serverTimestamp)?.sender?.id,
        timestamp: confirmed?.dataset.timestamp, connected: confirmed?.isConnected,
        staleIndex: ui.messageIndex.has(localTimestamp), unconfirmed: ui.localNakoMessages.size };
    });
    assert.equal(result.pending, true);
    assert.equal(result.replies, 1);
    assert.equal(result.total, 121);
    assert.equal(result.timestamp, '1700000090000');
    assert.equal(result.sender, 'sekai:one');
    assert.equal(result.connected, true);
    assert.equal(result.staleIndex, false);
    assert.equal(result.unconfirmed, 0);
  });

  await t.test('plain text stays literal while markup and entities retain sanitization', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(() => {
      const renderer = new SekaiRenderer();
      const literal = renderer.render('中文 English 普通文本');
      const rich = renderer.render('<img src=x onerror="window.compromised=true"> &amp; **bold**');
      return { literal: literal.textContent, text: rich.textContent,
        bold: rich.querySelector('strong')?.textContent,
        unsafe: !!rich.querySelector('[onerror],script') };
    });
    assert.equal(result.literal, '中文 English 普通文本');
    assert.equal(result.text, ' & bold');
    assert.equal(result.bold, 'bold');
    assert.equal(result.unsafe, false);
  });

  await t.test('room changes discard pending old messages and rebuild reply indexes', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      const oldTimestamp = 1700000000000;
      seed(1); await nextFrame();
      const oldNode = ui.messageIndex.get(oldTimestamp);
      ui.addSystemMessage('pending in old room', 1700000002000);
      ui.storage.saveMessages('other-room', [{ user: 'Other', text: 'other room', timestamp: 1700000003000 }]);
      ui.setCurrentRoom('other-room');
      ui.addSystemMessage('new room arrival', 1700000004000);
      ui.renderMessages();
      await nextFrame();
      return {
        rows: rows(), indexSize: ui.messageIndex.size, metaSize: ui.messageMeta.size,
        oldConnected: oldNode.isConnected, oldPreview: ui.lookupReplyMeta(oldTimestamp),
        newPreview: ui.lookupReplyMeta(1700000003000),
        allConnected: [...ui.messageIndex.values()].every(el => el.isConnected),
      };
    });
    assert.deepEqual(result.rows, ['other room', 'new room arrival']);
    assert.equal(result.indexSize, 2);
    assert.equal(result.metaSize, 2);
    assert.equal(result.oldConnected, false);
    assert.equal(result.oldPreview, null);
    assert.deepEqual(result.newPreview, { name: 'Other', preview: 'other room' });
    assert.equal(result.allConnected, true);
  });

  await t.test('reading history suppresses scrolling and later updates still follow the bottom', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      seed(); await nextFrame();
      ui.elements.chatlog.scrollTop = 80;
      counts.scrollWrites = counts.heightReads = 0;
      ui.addSystemMessage('queued before user scroll', 1700000010000);
      // The decision must use user activity at flush time, not at enqueue time.
      ui.isAtBottom = false;
      ui.lastUserActivityTime = Date.now();
      await nextFrame();
      const reading = { top: ui.elements.chatlog.scrollTop, writes: counts.scrollWrites, reads: counts.heightReads };
      ui.renderMessages(); await renderComplete();
      const rebuilt = { top: ui.elements.chatlog.scrollTop, writes: counts.scrollWrites };
      ui.isAtBottom = true;
      ui.addSystemMessage('follow again', 1700000010001);
      await nextFrame();
      const following = ui.elements.chatlog.scrollTop + ui.elements.chatlog.clientHeight >= ui.elements.chatlog.scrollHeight - 1;
      ui.isAtBottom = false;
      ui.lastUserActivityTime = Date.now() - ui.interactionTimeWindow - 1;
      ui.addSystemMessage('idle follow', 1700000010002);
      await nextFrame();
      return { reading, rebuilt, following, writes: counts.scrollWrites };
    });
    assert.deepEqual(result.reading, { top: 80, writes: 0, reads: 0 });
    assert.deepEqual(result.rebuilt, { top: 80, writes: 0 });
    assert.equal(result.following, true);
    assert.equal(result.writes, 2);
  });

  await t.test('empty rooms clear the DOM and reply indexes', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      seed(1); await nextFrame();
      ui.setCurrentRoom('empty-room'); await nextFrame();
      return { rows: rows(), indexSize: ui.messageIndex.size, metaSize: ui.messageMeta.size };
    });
    assert.deepEqual(result, { rows: [], indexSize: 0, metaSize: 0 });
  });

  await t.test('the synchronous fallback works when PerformanceOptimizer is unavailable', async t => {
    const page = await fixture(t, { optimizer: false });
    const result = await page.evaluate(() => {
      seed(2);
      ui.addSystemMessage('fallback arrival', 1700000001000);
      ui.renderMessages();
      return { rows: rows(), indexSize: ui.messageIndex.size };
    });
    assert.deepEqual(result, { rows: ['Message 0', 'Message 1', 'fallback arrival'], indexSize: 3 });
  });

  await t.test('histories complete with timer yields when the task scheduler is unavailable', async t => {
    const page = await fixture(t, { taskScheduler: false });
    const result = await page.evaluate(async () => {
      seed(120); await nextFrame();
      const pending = !!ui.messageBuild;
      ui.addSystemMessage('timer arrival', 1700000999999);
      await renderComplete();
      return { pending, rows: rows().length, arrival: rows().filter(text => text === 'timer arrival').length,
        connected: [...ui.messageIndex.values()].every(row => row.isConnected) };
    });
    assert.deepEqual(result, { pending: true, rows: 121, arrival: 1, connected: true });
  });

  await t.test('presence updates keep in-flight avatars connected and profile triggers current', async t => {
    const page = await fixture(t);
    const avatarUrl = 'https://avatars.test/first.svg';
    const requests = [];
    const cancelled = [];
    let release;
    const responseReady = new Promise(resolve => { release = resolve; });
    t.after(release);
    page.on('requestfailed', request => {
      if (request.url() === avatarUrl) cancelled.push(request.failure()?.errorText);
    });
    await page.route(avatarUrl, async route => {
      requests.push(route.request().url());
      await responseReady;
      await route.fulfill({ contentType: 'image/svg+xml', headers: { 'Cache-Control': 'max-age=0' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/></svg>' });
    });
    const started = page.waitForRequest(avatarUrl);
    await page.evaluate(avatarUrl => {
      window.member = { id: 'sekai:one', displayName: 'Original', authenticated: true, avatarUrl };
      ui.addUserToRoster('Earlier guest', { id: 'guest:earlier', displayName: 'Earlier guest' });
      ui.addUserToRoster(member.displayName, member);
      window.originalRow = ui.elements.roster.lastElementChild;
      window.originalImage = originalRow.querySelector('img');
      window.removals = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.removedNodes) {
          if (node === originalImage || node.contains?.(originalImage)) removals++;
        }
      }).observe(ui.elements.roster, { childList: true, subtree: true });
    }, avatarUrl);
    await started;
    const result = await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) {
        ui.addUserToRoster(`Guest ${i}`, { id: `guest:${i}`, displayName: `Guest ${i}` });
        await nextFrame();
      }
      member = { ...member, displayName: 'Renamed', bio: 'Updated bio' };
      ui.addUserToRoster(member.displayName, member);
      ui.removeUserFromRoster('Earlier guest', 'guest:earlier');
      await nextFrame();
      window.openedProfiles = [];
      ui.profileUI.open = profile => openedProfiles.push(profile);
      originalRow.click();
      originalRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return {
        sameRow: ui.elements.roster.firstElementChild === originalRow,
        sameImage: originalRow.querySelector('img') === originalImage,
        connected: originalImage.isConnected, removals,
        opened: openedProfiles.map(profile => ({ id: profile.id, name: profile.displayName, bio: profile.bio })),
        label: originalRow.getAttribute('aria-label'),
      };
    });
    assert.equal(result.sameRow, true);
    assert.equal(result.sameImage, true);
    assert.equal(result.connected, true);
    assert.equal(result.removals, 0);
    assert.deepEqual(result.opened, Array(2).fill({ id: 'sekai:one', name: 'Renamed', bio: 'Updated bio' }));
    assert.equal(result.label, 'R Renamed，在线，查看资料');
    release();
    await page.waitForFunction(() => originalImage.complete && originalImage.naturalWidth === 32);
    assert.equal(requests.length, 1);
    assert.deepEqual(cancelled, []);
    await page.evaluate(() => ui.clearRoster());
    assert.equal(await page.locator('.voice-user').count(), 0);
    assert.equal(await page.evaluate(() => ui.rosterElements.size), 0);
  });

  await t.test('avatar changes replace only that image and stale errors cannot remove its replacement', async t => {
    const page = await fixture(t);
    await page.route('https://avatars.test/**', route => route.fulfill({
      contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
    }));
    const result = await page.evaluate(async () => {
      const first = { id: 'sekai:one', displayName: 'First', authenticated: true, avatarUrl: 'https://avatars.test/first.svg' };
      const other = { id: 'sekai:other', displayName: 'Other', authenticated: true, avatarUrl: 'https://avatars.test/other.svg' };
      ui.addUserToRoster(first.displayName, first);
      ui.addUserToRoster(other.displayName, other);
      const row = ui.elements.roster.firstElementChild;
      const oldImage = row.querySelector('img');
      const otherImage = ui.elements.roster.lastElementChild.querySelector('img');
      ui.addUserToRoster('Changed', { ...first, displayName: 'Changed', avatarUrl: 'https://avatars.test/changed.svg' });
      const replacement = row.querySelector('img');
      oldImage.dispatchEvent(new Event('error'));
      const replaced = {
        sameRow: row === ui.elements.roster.firstElementChild,
        changedImage: replacement !== oldImage,
        replacementSurvives: row.querySelector('img') === replacement,
        sameOtherImage: ui.elements.roster.lastElementChild.querySelector('img') === otherImage,
        source: replacement.getAttribute('src'),
      };
      replacement.dispatchEvent(new Event('error'));
      const fallback = row.querySelector('.avatar').textContent;
      ui.addUserToRoster('Unsafe', { ...first, displayName: 'Unsafe', avatarUrl: 'javascript:alert(1)' });
      return { replaced, fallback, unsafeImages: row.querySelectorAll('img').length,
        unsafeFallback: row.querySelector('.avatar').textContent };
    });
    assert.deepEqual(result.replaced, { sameRow: true, changedImage: true, replacementSurvives: true,
      sameOtherImage: true, source: 'https://avatars.test/changed.svg' });
    assert.equal(result.fallback, 'C');
    assert.equal(result.unsafeImages, 0);
    assert.equal(result.unsafeFallback, 'U');
  });
});
