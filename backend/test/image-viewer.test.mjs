/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { readBrowserScript, readBrowserStyle } from '../../scripts/browser-source.mjs';

const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#776392"/></svg>';

test('image previews hide idle controls and show spoiler hints only after loading', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const styles = readBrowserStyle('styles.css');
  const scripts = ['sekai-escape.js', 'sekai-renderer.js', 'sekai-image-viewer.js'].map(readBrowserScript);

  async function fixture(t, { mobile = false, reducedMotion = 'no-preference', deferred = false } = {}) {
    const context = await browser.newContext({ viewport: { width: mobile ? 375 : 1280, height: 812 },
      isMobile: mobile, hasTouch: mobile, reducedMotion, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let release;
    const ready = deferred ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    t.after(() => release?.());
    await page.route('**/*', async route => {
      if (route.request().url().endsWith('/picture.svg')) {
        await ready;
        return route.fulfill({ contentType: 'image/svg+xml', body: picture });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="images"></main>' });
    });
    await page.goto('http://nightcord-images.test/');
    await page.addStyleTag({ content: styles });
    await page.addStyleTag({ content: 'body { display: block; padding: 24px; box-sizing: border-box; } #images { width: 100%; }' });
    for (const content of scripts) await page.addScriptTag({ content });
    await page.evaluate(spoiler => {
      const renderer = new SekaiRenderer();
      document.querySelector('#images').append(renderer.renderImageV2({ w: '640', h: '400', alt: '测试图片', spoiler: String(spoiler) }, 'http://nightcord-images.test/picture.svg'));
    }, deferred);
    const image = page.locator('.sekai-image-container');
    const viewer = page.locator('.sekai-image-viewer');
    if (!deferred) await page.waitForFunction(() => !document.querySelector('.sekai-image-container').classList.contains('loading'));
    return { page, image, viewer, release };
  }

  async function idle(page) {
    // Keep the production three-second timeout; check the rendered opacity too.
    await page.waitForFunction(() => document.querySelector('.sekai-image-viewer').classList.contains('ui-hidden'), null, { timeout: 5000 });
    await page.waitForFunction(() => ['.sekai-viewer-toolbar', '.sekai-viewer-info', '.sekai-viewer-close-fixed']
      .every(selector => getComputedStyle(document.querySelector(selector)).opacity === '0'), null, { timeout: 2000 });
  }

  await t.test('mouse opening and clicking toolbar buttons both allow idle hiding', async t => {
    const { page, image, viewer } = await fixture(t);
    await image.locator('img').click();
    assert.equal(await viewer.evaluate(el => el.contains(document.activeElement)), true);
    await idle(page);
    await page.mouse.move(500, 300);
    assert.equal(await viewer.evaluate(el => el.classList.contains('ui-hidden')), false);
    await viewer.getByRole('button', { name: '放大', exact: true }).click();
    assert.ok(await page.evaluate(() => sekaiImageViewer.scale > 1));
    await idle(page);
    await page.keyboard.press('Escape');
    assert.equal(await image.evaluate(el => el === document.activeElement), true);
    await image.locator('img').click();
    await idle(page);
  });

  await t.test('Tab restores hidden controls and keeps keyboard focus visible', async t => {
    const { page, image, viewer } = await fixture(t);
    await image.locator('img').click();
    await idle(page);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(3400);
    assert.equal(await viewer.evaluate(el => el.classList.contains('ui-hidden')), false);
    assert.equal(await viewer.evaluate(el => el.contains(document.activeElement) && document.activeElement.matches(':focus-visible')), true);
    await viewer.locator('button').last().focus();
    await page.keyboard.press('Tab');
    assert.equal(await viewer.locator('button').first().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await image.evaluate(el => el === document.activeElement), true);
    await image.press('Enter');
    await page.waitForTimeout(3400);
    assert.equal(await viewer.evaluate(el => el.classList.contains('ui-hidden')), false, 'keyboard opening keeps the initial close button visible');
  });

  await t.test('touch opening, waking and using controls all return to idle', async t => {
    const { page, image, viewer } = await fixture(t, { mobile: true });
    await image.locator('img').tap();
    await idle(page);
    await page.locator('.sekai-viewer-image').tap();
    assert.equal(await viewer.evaluate(el => el.classList.contains('ui-hidden')), false);
    await viewer.getByRole('button', { name: '放大', exact: true }).tap();
    await idle(page);
    await page.locator('.sekai-viewer-image').tap();
    await viewer.locator('.sekai-viewer-close-fixed').tap();
    assert.equal(await viewer.evaluate(el => el.open), false);
  });

  for (const mobile of [false, true]) {
    await t.test(`loading shows only a placeholder, then the spoiler can be revealed (${mobile ? 'touch' : 'keyboard'})`, async t => {
      const { page, image, viewer, release } = await fixture(t, { mobile, deferred: true,
        reducedMotion: mobile ? 'reduce' : 'no-preference' });
      const hint = image.locator('.sekai-image-spoiler-label');
      const before = await image.boundingBox();
      assert.equal(await hint.isVisible(), false);
      assert.equal(await image.locator('img').isVisible(), false, 'partial image contents must stay hidden');
      assert.equal(await image.locator('img').evaluate(el => getComputedStyle(el).filter), 'none');
      await page.waitForTimeout(550);
      assert.equal(await hint.isVisible(), false, 'the loading shimmer must not reveal the hint');
      assert.equal(await image.evaluate(el => getComputedStyle(el, '::after').content), '""', 'shimmer has no reveal text');
      if (mobile) assert.equal(await image.evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'reduced motion disables the shimmer');
      assert.equal(await image.getAttribute('aria-label'), '查看剧透图片');
      if (mobile) await image.tap();
      else await image.press('Enter');
      assert.equal(await image.evaluate(el => el.classList.contains('revealed')), false, 'loading clicks must not pre-reveal the image');
      assert.equal(await viewer.evaluate(el => el.open), false);
      release();
      await page.waitForFunction(() => !document.querySelector('.sekai-image-container').classList.contains('loading'));
      assert.deepEqual(await image.boundingBox(), before, 'known image dimensions preserve the placeholder size');
      assert.equal(await hint.isVisible(), true);
      assert.equal(await hint.innerText(), '查看图片');
      assert.equal(await image.locator('img').evaluate(el => getComputedStyle(el).filter), 'blur(18px)', 'loaded image starts blurred without a clear flash');
      if (mobile) await image.tap();
      else await image.press('Enter');
      assert.equal(await viewer.evaluate(el => el.open), false, 'first activation only reveals');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sekai-image-content')).filter === 'none');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sekai-image-spoiler-cover')).visibility === 'hidden');
      if (mobile) await image.locator('img').tap();
      else await image.press('Enter');
      assert.equal(await viewer.evaluate(el => el.open), true, 'second activation opens the preview');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
  }
});
