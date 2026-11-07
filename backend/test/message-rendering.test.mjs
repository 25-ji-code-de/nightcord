/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const scripts = [
  'purify.js', 'sekai-escape.js', 'performance-optimizer.js', 'event-bus.js',
  'storage-manager.js', 'file-upload-service.js', 'sekai-renderer.js',
  'user-profile.js', 'ui-manager.js',
];

test('message rendering batches updates without losing or duplicating messages', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const sources = await Promise.all(scripts.map(async file => ({
    file, content: await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'),
  })));

  async function fixture(t, { optimizer = true } = {}) {
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
      <div class="channel"><span></span></div>
      <div id="messages"></div><textarea id="messageInput"></textarea>
      <div id="voice-users"></div>` }));
    await page.goto('http://nightcord-rendering.test/');
    for (const { file, content } of sources) {
      if (!optimizer && file === 'performance-optimizer.js') continue;
      await page.addScriptTag({ content });
    }
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus());
      window.nextFrame = () => new Promise(requestAnimationFrame);
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
      await nextFrame();
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
      ui.renderMessages(); await nextFrame();
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
});
