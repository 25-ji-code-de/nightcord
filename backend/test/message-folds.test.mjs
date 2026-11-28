/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { readBrowserScript, readBrowserStyle } from '../../scripts/browser-source.mjs';

test('message folding preserves content, chronology, keyboard controls and reply targets', { timeout: 45000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  async function fixture(t, width = 600) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>
      :root { --nc-text: 230 230 240; --nc-accent: 170 140 230; }
      body { background: #201e28; color: #eee; }
      #messages { width: 100%; height: 400px; overflow-y: auto; }
      .message { display: flex; padding: 8px; position: relative; }
      .message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
      ${readBrowserStyle('css/app-shell/messages.css')}
      </style><div id="messages"></div><textarea id="messageInput"></textarea>
      <div id="online-users"></div><div id="voice-users"></div><div id="offline-users"></div>` }));
    await page.goto('http://nightcord-folding.test/');
    for (const file of ['purify.js', 'sekai-escape.js', 'performance-optimizer.js', 'event-bus.js', 'ai-config.js',
      'storage-manager.js', 'file-upload-service.js', 'sekai-renderer.js', 'user-profile.js', 'ui-manager.js']) {
      await page.addScriptTag({ content: readBrowserScript(file) });
    }
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus()); ui.currentRoom = 'fold-tests';
      window.done = async () => { do { await new Promise(requestAnimationFrame); } while (ui.messageRenderFrame !== null || ui.messageBuild); };
      window.row = (text, i, actor = 'user0') => ({ ...ui.createMessageData('同名用户', text, 1700000000000 + i * 1000),
        profile: { id: 'sekai:' + actor, displayName: '同名用户', authenticated: true } });
    });
    return page;
  }

  await t.test('long text, braille and emoji prose fold, while short emoji and normal replies stay visible on mobile', async t => {
    const page = await fixture(t, 390);
    await page.evaluate(async () => {
      ui.messages = [row('今天很开心😊', 0), row('文'.repeat(72) + '💃🏻'.repeat(8), 1),
        row('⣿'.repeat(24), 2), row('一\n二\n三\n四\n五\n六\n七', 3), row('正常的长消息'.repeat(35), 4)];
      ui.renderMessages(); await done();
    });
    assert.equal(await page.locator('.message-fold').count(), 4);
    assert.equal(await page.locator('.message').first().locator('.message-text').isVisible(), true);
    const emoji = page.locator('.message-fold').first();
    assert.equal(await emoji.locator('.message-text').isVisible(), false);
    await emoji.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await emoji.locator('.message-text').isVisible(), true);
    assert.equal(await emoji.locator('.message-text').textContent(), '文'.repeat(72) + '💃🏻'.repeat(8));
    await page.evaluate(async () => { ui.renderMessages(); await done(); });
    assert.equal(await page.locator('.message-fold').first().getAttribute('open'), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('reply-jump', { detail: { timestamp: 1700000003000 } })));
    assert.equal(await page.locator('.message[data-timestamp="1700000003000"] details').getAttribute('open'), '');
    await page.evaluate(async () => { ui.currentRoom = 'other-room'; ui.messages = ui.messages.map(message => ({ ...message })); ui.renderMessages(); await done(); });
    assert.equal(await page.locator('.message-fold[open]').count(), 0);
  });

  await t.test('live group collapse retains interleaved conversation, expansion and reply indexes', async t => {
    const page = await fixture(t);
    await page.evaluate(async () => {
      ui.messages = Array.from({ length: 7 }, (_, i) => row('67'.repeat(i + 1), i, 'user' + Math.floor(i / 2)));
      ui.messages.splice(3, 0, row('正常提问：头像在哪里修改？', 2.5, 'question'));
      ui.renderMessages(); await done();
    });
    assert.equal(await page.locator('.message-repeat-summary').count(), 0);
    await page.evaluate(async () => {
      const message = row('⑥⑦！', 8, 'user3'); ui.messages.push(message); ui.appendMessageToDOM(message); await done();
    });
    const control = page.locator('.message-repeat-summary button');
    assert.equal(await control.textContent(), '8 条相似消息 · 4 人 · 展开');
    assert.equal(await page.locator('.message[hidden]').count(), 8);
    assert.equal(await page.getByText('正常提问：头像在哪里修改？', { exact: true }).isVisible(), true);
    await control.focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('.message[hidden]').count(), 0);
    assert.deepEqual(await page.locator('.message-text').allTextContents(),
      ['67', '6767', '676767', '正常提问：头像在哪里修改？', '67676767', '6767676767', '676767676767', '67676767676767', '⑥⑦！']);
    await page.evaluate(async () => { ui.renderMessages(); await done(); });
    assert.equal(await control.getAttribute('aria-expanded'), 'true');
    await control.click();
    assert.equal(await page.locator('.message[hidden]').count(), 8);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('reply-jump', { detail: { timestamp: 1700000001000 } })));
    assert.equal(await page.locator('.message[hidden]').count(), 0);
    assert.equal(await page.locator('.message[data-timestamp="1700000001000"] .message-reply-btn').count(), 1);
  });

  await t.test('history groups expire, same names do not supply identities, and room switches reset expansion', async t => {
    const page = await fixture(t);
    const result = await page.evaluate(async () => {
      ui.messages = Array.from({ length: 8 }, (_, i) => row('67', i, 'user' + i % 3));
      ui.renderMessages(); await done();
      const fewerSenders = document.querySelectorAll('.message-repeat-summary').length;
      ui.messages = Array.from({ length: 8 }, (_, i) => row('67', i * 20, 'user' + i));
      ui.renderMessages(); await done();
      const expired = document.querySelectorAll('.message-repeat-summary').length;
      ui.messages = Array.from({ length: 8 }, (_, i) => row('67', i, 'user' + Math.floor(i / 2)));
      ui.renderMessages(); await done();
      document.querySelector('.message-repeat-summary button').click();
      ui.currentRoom = 'another-room'; ui.messages = ui.messages.map(message => ({ ...message }));
      ui.renderMessages(); await done();
      return { fewerSenders, expired, hidden: document.querySelectorAll('.message[hidden]').length };
    });
    assert.deepEqual(result, { fewerSenders: 0, expired: 0, hidden: 8 });
  });

  await t.test('collapsed batches leave no empty spacer and later ordinary messages stay visible', async t => {
    const page = await fixture(t);
    await page.evaluate(async () => {
      ui.messages = Array.from({ length: 24 }, (_, i) => row('6767', i, 'user' + Math.floor(i / 2)));
      ui.renderMessages(); await done();
    });
    assert.equal(await page.locator('.message-batch[hidden]').count(), 1);
    await page.evaluate(async () => {
      const message = row('这是接下来正常的一条消息', 25, 'new-user');
      ui.messages.push(message); ui.appendMessageToDOM(message); await done();
    });
    assert.equal(await page.getByText('这是接下来正常的一条消息', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.message-batch').last().evaluate(batch => batch.style.getPropertyValue('--message-batch-height')), '72px');
    await page.locator('.message-repeat-summary button').click();
    assert.equal(await page.locator('.message-batch[hidden]').count(), 0);
    assert.equal(await page.locator('.message[hidden]').count(), 0);
  });
});
