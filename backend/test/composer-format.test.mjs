/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const origin = 'http://composer.nightcord.test';
const scripts = ['purify.js', 'sekai-escape.js', 'event-bus.js', 'ai-config.js', 'storage-manager.js',
  'file-upload-service.js', 'sekai-renderer.js', 'ui-autocomplete.js', 'composer-format.js',
  'user-profile.js', 'ui-manager.js', 'pangu.js'];

test('text tools insert into the draft and round-trip through the message renderer', async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: await readFile(new URL('.' + url.pathname, root)) });
  });
  await page.goto(origin);
  for (const file of scripts) await page.addScriptTag({ content: await readFile(new URL(file, root), 'utf8') });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => {
    window.ui = new UIManager(new EventBus());
    window.sent = [];
    ui.setupChatRoom(message => sent.push(message));
  });
  const input = page.locator('#messageInput');
  const trigger = page.locator('#formatBtn');
  const panel = page.locator('#formatPanel');
  const field = name => panel.locator('[name="' + name + '"]');
  async function open(text = '', start = 0, end = text.length) {
    await input.fill(text);
    await input.evaluate((el, range) => el.setSelectionRange(...range), [start, end]);
    await trigger.click();
  }
  async function sendAndRender(selector) {
    await input.press('Enter');
    return page.evaluate(selector => {
      const fragment = ui.sekaiRenderer.render(sent.at(-1));
      const el = fragment.querySelector(selector);
      return el?.textContent ?? null;
    }, selector);
  }

  for (const [mark, selector] of Object.entries({ bold: 'strong', italic: 'em', strike: 'del', spoiler: '.sekai-spoiler', inline: 'code', quote: 'blockquote' })) {
    await open('前文字后', 1, 3);
    await panel.locator('[data-mark="' + mark + '"]').click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await sendAndRender(selector), '文字', mark);
    const wire = await page.evaluate(() => sent.at(-1));
    assert.ok(wire.startsWith('前') && wire.endsWith('后'));
  }
  await open('前后', 1, 1);
  await panel.locator('[data-mark=bold]').click();
  await page.keyboard.insertText('新');
  assert.equal(await input.inputValue(), '前**新**后');

  const code = 'if (a > b) {\n  // 🎵 [stamp0042]\n}';
  await open(code);
  await panel.locator('[data-editor=code]').click();
  assert.equal(await field('content').inputValue(), code);
  await field('lang').fill('C++');
  await field('collapse').check();
  await panel.locator('summary').click();
  await field('codeName').fill('Main.cpp');
  await panel.locator('[type=submit]').click();
  assert.equal(await sendAndRender('.collapsed code[data-lang="C++"]'), code);

  await open('一段文字');
  await panel.locator('[data-editor=color]').click();
  await field('ink').fill('#eab0dc');
  const preserve = panel.getByRole('checkbox', { name: 'TrueColor 原色模式' });
  const tip = panel.getByRole('tooltip');
  await panel.locator('.format-truecolor-mark').hover();
  assert.ok(await tip.isVisible());
  await preserve.focus();
  await preserve.press('Escape');
  assert.ok(await panel.isVisible());
  assert.equal(await tip.isVisible(), false);
  await preserve.press('Space');
  assert.ok(await preserve.isChecked());
  await panel.locator('summary').press('Enter');
  assert.ok(await field('spoiler').isVisible());
  await field('spoiler').check();
  await panel.locator('[type=submit]').click();
  assert.equal(await sendAndRender('.sekai-spoiler .sekai-truecolor'), '一段文字');

  await open('曲名 + 🎵');
  await panel.locator('[data-editor=link]').click();
  assert.equal(await field('collapse').isVisible(), false);
  assert.equal(await field('hideImage').isVisible(), false);
  await field('url').fill('ftp://example.org');
  await panel.locator('[type=submit]').click();
  assert.match(await panel.locator('[role=status]').innerText(), /https/);
  await field('url').fill('https://example.org/song');
  await panel.locator('summary').click();
  await field('description').fill('新歌');
  await field('source').fill('作品库');
  await field('tint').check();
  await field('accent').fill('#eeaa99');
  await panel.locator('[type=submit]').click();
  assert.equal(await sendAndRender('a[href="https://example.org/song"] .sekai-link-title'), '曲名 + 🎵');
  assert.deepEqual(await page.evaluate(() => {
    const node = ui.sekaiRenderer.render(sent.at(-1));
    return [node.querySelector('.sekai-link-desc').textContent, node.querySelector('.sekai-link-site').textContent, node.querySelector('.sekai-link-accent').style.backgroundColor];
  }), ['新歌', '作品库', 'rgb(238, 170, 153)']);

  for (const [kind, selector] of Object.entries({ image: '.sekai-image-spoiler img[alt="封面"]', sticker: 'img.sekai-sticker',
    file: '.sekai-file-card', audio: '.sekai-audio-player-simple', music: '.sekai-audio-player' })) {
    await open('https://example.org/track.ogg');
    await panel.locator('[data-editor=media]').click();
    await field('kind').selectOption(kind);
    if (kind === 'image') {
      await field('alt').fill('封面');
      await field('hideImage').check();
    }
    if (kind === 'music') await field('track').fill('曲目');
    await panel.locator('[type=submit]').click();
    assert.notEqual(await sendAndRender(selector), null, kind);
  }
  const full = '满'.repeat(255);
  await open(full, 100, 100);
  await panel.locator('[data-mark=bold]').click();
  assert.match(await panel.locator('[role=status]').innerText(), /256/);
  assert.equal(await input.inputValue(), full);
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  await page.setViewportSize({ width: 360, height: 640 });
  await open('草稿');
  const box = await panel.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 360 && box.y >= 0);
  await panel.locator('[data-editor=color]').click();
  await panel.locator('[data-back]').click();
  await page.locator('#attachmentBtn').click();
  assert.equal(await panel.isVisible(), false);
  assert.equal(await input.inputValue(), '草稿');
  assert.equal(await page.evaluate(() => sent.length), 14);
  assert.deepEqual(errors, []);
});
