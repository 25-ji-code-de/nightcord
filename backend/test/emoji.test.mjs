/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('Unicode emoji rendering and native copying', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/*', route => route.request().resourceType() === 'image'
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>' })
    : route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <main class="main" id="message"></main><textarea id="paste"></textarea>
      <div class="channel"><span>Test</span></div><div id="messages"></div>
      <textarea id="messageInput" maxlength="256"></textarea><div id="voice-users"></div>` }));
  await page.goto('http://localhost/');
  for (const file of ['purify.js', 'emoji-data.js', 'emoji-unicode-data.js', 'emoji-service.js', 'sekai-renderer.js']) {
    await page.addScriptTag({ content: await readFile(new URL(`../../${file}`, import.meta.url), 'utf8') });
  }
  await page.addStyleTag({ content: await readFile(new URL('../../css/renderer.css', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    window.emojiService = new EmojiService();
    window.renderer = new SekaiRenderer({ emojiService });
    window.renderMessage = text => document.querySelector('#message').replaceChildren(renderer.render(text));
    window.selectMessage = () => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#message'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    };
  });

  await t.test('Unicode and shortcodes use identical images and keep accessible labels', async () => {
    await page.evaluate(() => renderMessage('前😂 :joy:🎉后'));
    const nodes = page.locator('#message .nightcord-emoji');
    assert.equal(await nodes.count(), 3);
    assert.equal(await nodes.nth(0).locator('img').getAttribute('src'), await nodes.nth(1).locator('img').getAttribute('src'));
    assert.equal(await nodes.nth(0).getAttribute('title'), ':joy:');
    assert.equal(await nodes.nth(0).getAttribute('aria-label'), '😂');
    assert.equal(await page.locator('#message').textContent(), '前😂 :joy:🎉后');
    await page.evaluate(() => emojiService.processElement(document.querySelector('#message')));
    assert.equal(await nodes.count(), 3);
  });

  await t.test('native copy and paste preserve emoji, source shortcodes, formatting and line breaks', async () => {
    await page.evaluate(() => {
      renderMessage('前**😂** :joy:🎉后\n🇨🇳👨‍👩‍👧‍👦1️⃣ 👍🏽');
      selectMessage();
    });
    await page.keyboard.press('ControlOrMeta+c');
    await page.locator('#paste').focus();
    await page.keyboard.press('ControlOrMeta+v');
    assert.equal(await page.locator('#paste').inputValue(), '前😂 :joy:🎉后\n🇨🇳👨‍👩‍👧‍👦1️⃣ 👍🏽');

    await page.evaluate(() => {
      const node = document.querySelector('#message .nightcord-emoji');
      const range = document.createRange();
      range.selectNode(node);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.keyboard.press('ControlOrMeta+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '😂');
  });

  await t.test('code, links and spoilers keep their literal contents', async () => {
    await page.evaluate(() => renderMessage('`😂 :joy:` https://example.com/😂 ||😂 :joy:|| **😂**'));
    assert.equal(await page.locator('#message code').textContent(), '😂 :joy:');
    assert.equal(await page.locator('#message a').textContent(), 'https://example.com/😂');
    assert.equal(await page.locator('#message .sekai-spoiler').textContent(), '😂 :joy:');
    assert.equal(await page.locator('#message .nightcord-emoji').count(), 1);
  });

  await t.test('failed images fall back to their original source text', async () => {
    await page.evaluate(() => {
      renderMessage('😂 :joy:');
      document.querySelectorAll('#message img').forEach(image => image.dispatchEvent(new Event('error')));
    });
    assert.equal(await page.locator('#message .nightcord-emoji').count(), 0);
    assert.equal(await page.locator('#message').textContent(), '😂 :joy:');
  });

  await t.test('sending and replaying messages preserve the original emoji and character budget', async () => {
    for (const file of ['sekai-escape.js', 'event-bus.js', 'ai-config.js', 'storage-manager.js',
      'file-upload-service.js', 'user-profile.js', 'ui-manager.js', 'pangu.js']) {
      await page.addScriptTag({ content: await readFile(new URL(`../../${file}`, import.meta.url), 'utf8') });
    }
    await page.evaluate(() => {
      window.ui = new UIManager(new EventBus());
      window.sent = [];
      ui.setupChatRoom(message => {
        sent.push(message);
        ui.eventBus.emit('message:sent', { message });
        ui.eventBus.emit('message:received', { name: 'User', message, timestamp: Date.now() });
        return true;
      });
    });
    const text = '😂'.repeat(128);
    const input = page.locator('#messageInput');
    await input.fill(text);
    await input.press('Enter');
    const nodes = page.locator('#messages .nightcord-emoji');
    await nodes.nth(127).waitFor();
    assert.deepEqual(await page.evaluate(() => sent), [text]);
    assert.equal(await input.inputValue(), '');
    assert.equal(await nodes.count(), 128);
    assert.equal(await page.locator('#messages .message-text').textContent(), text);

    await page.evaluate(() => ui.eventBus.emit('room:ready', {
      roomname: 'emoji-test', messages: [{ user: 'User', text: sent[0], timestamp: Date.now() }]
    }));
    await page.waitForFunction(() => document.querySelectorAll('#messages .nightcord-emoji').length === 128);
    assert.equal(await page.locator('#messages .message-text').first().textContent(), text);
  });
});
