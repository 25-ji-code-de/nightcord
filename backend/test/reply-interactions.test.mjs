/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { readBrowserScript, readBrowserStyle } from '../../scripts/browser-source.mjs';

test('message replies support touch swipes, tap controls and desktop input', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const scripts = ['purify.js', 'sekai-escape.js', 'event-bus.js', 'ai-config.js', 'storage-manager.js',
    'file-upload-service.js', 'sekai-renderer.js', 'user-profile.js', 'ui-manager.js'].map(readBrowserScript);
  const styles = ['css/app-shell.css', 'css/appearance.css'].map(readBrowserStyle);

  async function fixture(t, { mobile = true, reducedMotion = 'reduce', managed = false } = {}) {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 844 },
      isMobile: mobile, hasTouch: mobile, reducedMotion, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <div class="main"><div id="messages" class="messages"></div><textarea id="messageInput"></textarea></div>` }));
    await page.goto('http://nightcord-replies.test/');
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({ content: `:root { --nc-sidebar: 63 53 91; --nc-text: 255 255 255; --nc-accent: 182 161 242; }
      body { margin: 0; } .main { display: block; width: 100%; } #messages { margin-top: 60px; height: 300px; overflow: auto; }
      .message { min-height: 64px; } #messageInput { margin: 20px; width: 280px; height: 80px; }` });
    for (const content of scripts) await page.addScriptTag({ content });
    await page.evaluate(managed => {
      window.ui = new UIManager(new EventBus());
      ui.currentRoom = managed ? 'managed-test' : 'nightcord-default';
      const messages = [
        { user: '小夜', text: '明天见，带上笔记本。', timestamp: 1700000000001, ...(managed ? { replyKey: 7 } : {}) },
        { user: '遥', text: '好的，下午见。', timestamp: 1700000000002 },
      ];
      ui.elements.chatlog.replaceChildren(...messages.map(message => ui.createMessageElement(message)));
    }, managed);
    const first = page.locator('.message').first(), text = first.locator('.message-text');
    return { page, first, text, button: first.locator('.message-reply-btn'), input: page.locator('#messageInput') };
  }

  // Real browser touch input exercises scrolling, cancellation and compatibility clicks.
  async function touchPath(page, target, points, { finish = true } = {}) {
    const box = await target.boundingBox();
    assert.ok(box);
    const x = box.x + 30, y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const send = (type, dx = 0, dy = 0) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: x + dx, y: y + dy, id: 1 }],
    });
    await send('touchStart');
    for (const [dx, dy] of points) {
      await send('touchMove', dx, dy);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    if (finish) { await send('touchEnd'); await cdp.detach(); }
    return { send, cdp, x, y };
  }

  await t.test('tap reveals the original floating button and dismisses it on another tap or outside', async t => {
    const { page, first, text, button, input } = await fixture(t);
    assert.equal(await button.evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await button.evaluate(el => getComputedStyle(el).width), '32px');
    assert.equal(await first.evaluate(el => getComputedStyle(el).paddingRight), '12px');
    await text.tap();
    assert.equal(await button.evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await input.inputValue(), '');
    await text.tap();
    assert.equal(await button.evaluate(el => getComputedStyle(el).opacity), '0');
    await text.tap();
    await page.locator('.message').nth(1).locator('.message-text').tap();
    assert.equal(await first.evaluate(el => el.classList.contains('is-reply-selected')), false);
    await text.tap();
    await input.tap();
    assert.equal(await first.evaluate(el => el.classList.contains('is-reply-selected')), false);
    await text.tap();
    await button.tap();
    assert.equal(await input.inputValue(), '<$SEKAI:Reply::1700000000001> ');
  });

  await t.test('right swipe previews the threshold and inserts one reply at the draft selection', async t => {
    for (const managed of [false, true]) {
      const { page, first, text, input } = await fixture(t, { managed });
      await input.fill('前文后文');
      await input.evaluate(el => { el.setSelectionRange(2, 2); el.blur(); });
      const touch = await touchPath(page, text, [[16, 0], [32, 1]], { finish: false });
      assert.equal(await first.locator('.message-swipe-hint').textContent(), '右滑回复');
      assert.equal(await input.inputValue(), '前文后文');
      await touch.send('touchMove', 88, 2);
      assert.equal(await first.locator('.message-swipe-hint').textContent(), '松开回复');
      await touch.send('touchEnd');
      await touch.cdp.detach();
      assert.equal(await input.inputValue(), `前文<$SEKAI:Reply::${managed ? 7 : 1700000000001}> 后文`);
      assert.equal(await first.locator('.message-swipe-hint').count(), 0);
      assert.equal(await page.locator('.is-reply-selected, .is-reply-swiping').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  });

  await t.test('short, reversed, diagonal and cancelled swipes never reply', async t => {
    const { page, text, input } = await fixture(t);
    for (const points of [[[16, 0], [35, 0]], [[20, 0], [90, 0], [18, 0]], [[-18, 0], [-65, 0]], [[18, 26], [70, 60]]]) {
      await touchPath(page, text, points);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('.is-reply-selected, .is-reply-swiping, .message-swipe-hint').count(), 0);
    }
    const touch = await touchPath(page, text, [[20, 0], [80, 0]], { finish: false });
    await touch.send('touchCancel'); await touch.cdp.detach();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('.message-swipe-hint').count(), 0);
    await text.tap();
    assert.equal(await page.locator('.is-reply-selected').count(), 1, 'a cancelled swipe does not consume the next tap');
  });

  await t.test('vertical scrolling, selection and interactive content keep their native actions', async t => {
    const { page, first, text, input } = await fixture(t);
    await first.evaluate(row => {
      const extras = document.createElement('div');
      extras.innerHTML = '<a href="#kept">链接</a><pre style="width:150px;overflow:auto">' + 'code '.repeat(80) + '</pre>';
      row.querySelector('.message-content').append(extras);
    });
    await touchPath(page, first.locator('a'), [[20, 0], [80, 0]]);
    assert.equal(await input.inputValue(), '');
    await first.locator('a').tap();
    assert.ok(page.url().endsWith('#kept'));
    await touchPath(page, first.locator('pre'), [[-20, 0], [-60, 0]]);
    assert.ok(await first.locator('pre').evaluate(el => el.scrollLeft > 0));
    await text.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().addRange(range); });
    await touchPath(page, text, [[20, 0], [80, 0]]);
    assert.equal(await input.inputValue(), '');
    await page.evaluate(() => { getSelection().removeAllRanges();
      for (let i = 0; i < 12; i++) ui.elements.chatlog.append(ui.createMessageElement({ user: '遥', text: '历史消息', timestamp: 1700000000100 + i }));
    });
    await touchPath(page, page.locator('.message').nth(1).locator('.message-text'), [[1, -20], [2, -70], [2, -110]]);
    assert.ok(await page.locator('#messages').evaluate(el => el.scrollTop > 0));
    assert.equal(await input.inputValue(), '');
  });

  await t.test('multitouch, long press, disabled composer and navigation cancel a pending reply', async t => {
    const { page, text, input } = await fixture(t);
    const touch = await touchPath(page, text, [[20, 0], [80, 0]], { finish: false });
    await touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
      { x: touch.x + 80, y: touch.y, id: 1 }, { x: touch.x + 110, y: touch.y + 20, id: 2 },
    ] });
    await touch.send('touchEnd'); await touch.cdp.detach();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('.message-swipe-hint').count(), 0);
    const hold = await touchPath(page, text, [], { finish: false });
    await page.waitForTimeout(500);
    await hold.send('touchMove', 90, 0); await hold.send('touchEnd'); await hold.cdp.detach();
    assert.equal(await input.inputValue(), '');
    await page.evaluate(() => getSelection().removeAllRanges());
    await input.evaluate(el => { el.disabled = true; });
    await touchPath(page, text, [[20, 0], [80, 0]]);
    assert.equal(await input.inputValue(), '');
    await input.evaluate(el => { el.disabled = false; });
    const navigate = await touchPath(page, text, [[20, 0], [80, 0]], { finish: false });
    await page.evaluate(() => { ui.currentRoom = 'another-room'; });
    await navigate.send('touchEnd'); await navigate.cdp.detach();
    assert.equal(await input.inputValue(), '');
  });

  await t.test('desktop hover and keyboard activation retain the reply control', async t => {
    const { page, text, button, input } = await fixture(t, { mobile: false, reducedMotion: 'no-preference' });
    await text.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.message-reply-btn')).opacity === '1');
    await button.click();
    assert.equal(await input.inputValue(), '<$SEKAI:Reply::1700000000001> ');
    await input.fill('');
    await page.mouse.move(1200, 700);
    await button.focus();
    await button.press('Enter');
    assert.equal(await input.inputValue(), '<$SEKAI:Reply::1700000000001> ');
  });
});
