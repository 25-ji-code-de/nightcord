/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('entry audio recovers from browser autoplay blocking on touch and keyboard', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({
    executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined,
    args: ['--autoplay-policy=user-gesture-required']
  });
  t.after(() => browser.close());
  const root = new URL('../../', import.meta.url);
  const files = new Map(await Promise.all([
    ['event-bus.js', 'text/javascript'],
    ['js/ui/voice-sounds.js', 'text/javascript'],
    ['se_nightcord_enter.opus', 'audio/ogg'],
    ['se_nightcord_enter.mp3', 'audio/mpeg']
  ].map(async ([path, contentType]) => [path, { contentType, body: await readFile(new URL(path, root)) }])));

  for (const touch of [true, false]) {
    const context = await browser.newContext({ hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('http://nightcord-audio.test/**', route => {
      const path = new URL(route.request().url()).pathname.slice(1);
      if (files.has(path)) return route.fulfill(files.get(path));
      if (path) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <button>Continue</button>
        <script>
          window.attempts = []; window.playbacks = 0;
          const nativePlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () {
            const attempt = { audio: this, outcome: 'pending' };
            attempts.push(attempt);
            const result = nativePlay.call(this);
            result.then(() => { attempt.outcome = 'playing'; playbacks++; },
              error => { attempt.outcome = error.name; });
            return result;
          };
          ${touch ? '' : "HTMLMediaElement.prototype.canPlayType = () => '';"}
        </script>
        <script src="/event-bus.js"></script>
        <script src="/js/ui/voice-sounds.js"></script>
        <script>
          window.bus = new EventBus(); window.sounds = new VoiceSounds(bus);
          bus.emit('room:joining'); bus.emit('room:ready');
        </script>` });
    });
    await page.goto('http://nightcord-audio.test/');
    await page.waitForFunction(() => attempts[0]?.outcome === 'NotAllowedError');
    assert.equal(await page.evaluate(() => playbacks), 0);
    // A dispatched DOM event must not masquerade as permission to play audio.
    await page.evaluate(() => document.querySelector('button').click());
    assert.equal(await page.evaluate(() => attempts.length), 1);
    if (touch) await page.locator('button').tap();
    else await page.keyboard.press('Tab');
    await page.waitForFunction(() => playbacks === 1 && attempts.at(-1).audio.currentTime > 0);
    assert.equal(await page.evaluate(() => attempts.length), 2);
    assert.equal(await page.evaluate(() => attempts[0].audio === attempts[1].audio), true);
    assert.match(await page.evaluate(() => attempts[1].audio.src), touch ? /\.opus$/ : /\.mp3$/);
    await page.waitForFunction(() => attempts.at(-1).audio.ended);
    await page.evaluate(() => {
      bus.emit('connection:close'); bus.emit('room:synced'); bus.emit('room:ready');
    });
    if (touch) await page.locator('button').tap();
    else await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => attempts.length), 2);
    // Explicitly entering another room plays immediately after interaction.
    await page.evaluate(() => { bus.emit('room:joining'); bus.emit('room:ready'); });
    await page.waitForFunction(() => playbacks === 2);
    await page.evaluate(() => sounds.destroy());
    assert.equal(await page.evaluate(() => attempts.at(-1).audio.paused), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
