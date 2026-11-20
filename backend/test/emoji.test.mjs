import { readBrowserScript } from '../../scripts/browser-source.mjs';
import { readBrowserStyle } from '../../scripts/browser-source.mjs';
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
    await page.addScriptTag({ content: readBrowserScript(file) });
  }
  await page.addStyleTag({ content: readBrowserStyle('css/renderer.css') });
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
      await page.addScriptTag({ content: readBrowserScript(file) });
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

    const stickerCases = [
      '你好 [mfy_虚无的脸阴暗表情]',
      '**[mfy_虚无的脸阴暗表情]**',
      '__SEKAI_0__ [mfy_虚无的脸阴暗表情]',
    ];
    for (let index = 0; index < stickerCases.length; index++) {
      await input.fill(stickerCases[index]);
      await input.press('Enter');
      await page.waitForFunction(expectedCount => sent.length === expectedCount, index + 2);
    }
    assert.deepEqual(await page.evaluate(() => sent.slice(1)), stickerCases);

    const manyNestedStickers = Array.from({ length: 12 }, (_, index) => `**[sticker_${index}]**`).join(' ');
    const protectedCases = [
      { label: 'italic around a sticker', text: '*[sticker]*' },
      { label: 'strikethrough around a sticker', text: '~~[sticker]~~' },
      { label: 'spoiler around a sticker', text: '||[sticker]||' },
      { label: 'inline code around a sticker', text: '`[sticker]`' },
      { label: 'nested markdown around a sticker', text: '**||`[sticker]`||**' },
      { label: 'markdown and a separate sticker', text: '**bold** [sticker]' },
      { label: 'literal replacement patterns in nested placeholders', text: "**[price $& $$ $` $']**" },
      { label: 'multiple stickers', text: '[first] [second] [third]' },
      { label: 'sticker adjacent to punctuation', text: '([first]),[second]!' },
      { label: 'sticker across line breaks', text: 'before\n[sticker]\nafter' },
      { label: 'literal default placeholder beside a sticker', text: '__SEKAI_0__ [sticker]' },
      { label: 'several literal placeholder prefixes beside a sticker', text: '__SEKAI_0__ ___SEKAI_0__ ____SEKAI_0__ [sticker]' },
      { label: 'literal placeholder without protected syntax', text: '__SEKAI_0__ ___SEKAI_12__' },
      { label: 'SEKAI v2 token', text: '<$SEKAI:Stamp::stamp0042>' },
      { label: 'markdown around SEKAI v2 token', text: '**<$SEKAI:Stamp::stamp0042>**' },
      { label: 'SEKAI v2 token and sticker', text: '<$SEKAI:Stamp::stamp0042> [sticker]' },
      { label: 'SEKAI v2 multiline block', text: '<$SEKAI:Format:preserve=true>\nline one\n<&SEKAI>' },
      { label: 'SEKAI v2 multiline block containing sticker syntax', text: '<$SEKAI:Format:preserve=true>\n[sticker]\n<&SEKAI>' },
      { label: 'multiple SEKAI v2 multiline blocks', text: '<$SEKAI:Format:preserve=true>\none\n<&SEKAI>\n<$SEKAI:Format:preserve=true>\ntwo\n<&SEKAI>' },
      { label: 'nested markdown across many placeholder indices', text: manyNestedStickers },
      { label: '256-character message containing a protected sticker', text: `${'a'.repeat(250)}[x]bbb` },
    ];
    for (let index = 0; index < protectedCases.length; index++) {
      const { label, text: message } = protectedCases[index];
      await input.fill(message);
      await input.press('Enter');
      await page.waitForFunction(expectedCount => sent.length === expectedCount, index + stickerCases.length + 2);
      assert.equal(await page.evaluate(() => sent.at(-1)), message, label);
    }

    await page.evaluate(() => ui.eventBus.emit('room:ready', {
      roomname: 'emoji-test', messages: [{ user: 'User', text: sent[0], timestamp: Date.now() }]
    }));
    await page.waitForFunction(() => document.querySelectorAll('#messages .nightcord-emoji').length === 128);
    assert.equal(await page.locator('#messages .message-text').first().textContent(), text);
  });
});
