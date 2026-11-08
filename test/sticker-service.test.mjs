/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const window = {};
runInNewContext(readFileSync(new URL('../ui-sticker-service.js', import.meta.url), 'utf8'), {
  window, console: { warn() {}, error() {} },
});
const direct = 'https://sticker.nightcord.de5.net/autocomplete.json';
const gateway = 'https://api.nightcord.de5.net/sekai/stickers/autocomplete.json';
const catalog = { sample: { '你好': 'nihao' } };

for (const [primary, backup] of [[gateway, direct], [direct, gateway]]) {
  test(`sticker autocomplete recovers from ${primary} using the other host`, async () => {
    const requested = [];
    const service = new window.StickerService({ fetcher: async url => {
      requested.push(url);
      if (url === primary) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => catalog };
    } });
    const stickers = await service.loadAutocompleteData(primary);
    assert.deepEqual(requested, [primary, backup]);
    assert.equal(stickers.length, 1);
    assert.equal(stickers[0].label, '你好');
    assert.equal(stickers[0].pinyin, 'nihao');
    assert.match(stickers[0].url, /\/sample\/%E4%BD%A0%E5%A5%BD\.png$/);
    assert.equal(service.getStickers(), stickers);
  });
}

test('a healthy primary loads once and HTTP failures try the fallback', async () => {
  const requested = [];
  let failPrimary = false;
  const service = new window.StickerService({ fetcher: async url => {
    requested.push(url);
    return { ok: !(failPrimary && url === direct), status: 503, json: async () => catalog };
  } });
  await service.loadAutocompleteData();
  assert.deepEqual(requested, [direct]);
  requested.length = 0;
  failPrimary = true;
  await service.loadAutocompleteData();
  assert.deepEqual(requested, [direct, gateway]);
  assert.equal(service.getStickers().length, 1);
});

test('both hosts failing clears stale suggestions and stops after two requests', async () => {
  const requested = [];
  const service = new window.StickerService({ fetcher: async url => {
    requested.push(url);
    throw new TypeError('Failed to fetch');
  } });
  service.stickers = [{ label: 'stale' }];
  const stickers = await service.loadAutocompleteData(gateway);
  assert.deepEqual(requested, [gateway, direct]);
  assert.equal(stickers.length, 0);
  assert.equal(service.getStickers().length, 0);
});
