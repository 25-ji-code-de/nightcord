/*
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let AutocompleteManager;

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

before(() => {
  const window = {};
  const document = { addEventListener() {} };
  const source = readFileSync(join(root, 'ui-autocomplete.js'), 'utf8');
  new Function('window', 'document', 'escapeHtml', source)(window, document, escapeHtml);
  AutocompleteManager = window.AutocompleteManager;
});

function createFixture(value, { emojis = [], stickers = [] } = {}) {
  const classes = new Set(['hidden']);
  const listeners = new Map();
  const input = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  };
  const list = {
    innerHTML: '',
    contains() { return false; },
    querySelectorAll() { return []; },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    }
  };
  const manager = new AutocompleteManager({
    input,
    list,
    getEmojis: () => emojis,
    getStickers: () => stickers
  });
  return { manager, input, list };
}

describe('emoji and sticker pickers', () => {
  const emojis = [
    { shortcode: 'joy', category: 'smileys_&_emotion', url: 'https://emojis.example/joy.png' },
    { shortcode: 'joystick', category: 'activities', url: 'https://emojis.example/joystick.png' }
  ];
  const stickers = [
    { code: 'mzk_test', label: '瑞希贴纸', category: 'mzk', searchKey: 'ruixi', url: 'https://stickers.example/mzk.png' },
    { code: 'miku_test', label: '未来贴纸', category: 'miku', searchKey: 'weilai', url: 'https://stickers.example/miku.png' },
    { code: 'ick_test', label: '一歌贴纸', category: 'ick', searchKey: 'yige', url: 'https://stickers.example/ick.png' }
  ];

  test('empty colons open the categorized emoji grid', () => {
    const { manager, input, list } = createFixture('::', { emojis });
    input.dispatchEvent(new Event('input'));
    assert.equal(manager.autocompleteType, 'emoji');
    assert.equal(manager.autocompleteStart, 0);
    assert.equal(list.classList.contains('picker-mode'), true);
    assert.match(list.innerHTML, /class="picker-categories"/);
    assert.match(list.innerHTML, /data-shortcode="joy"/);
  });

  test('empty brackets open the categorized sticker grid', () => {
    const { manager, input, list } = createFixture('[]', { stickers });
    input.dispatchEvent(new Event('input'));
    assert.equal(manager.autocompleteType, 'sticker');
    assert.equal(list.classList.contains('picker-mode'), true);
    assert.match(list.innerHTML, /data-code="ick_test"/);
    assert.match(list.innerHTML, />\s*星乃一歌\s*</);
  });

  test('orders sticker characters from Ichika through Mizuki, then Virtual Singers', () => {
    const { manager, list } = createFixture('[]', { stickers });
    manager.handleInput({ target: manager.input, key: ']' });
    const ichika = list.innerHTML.indexOf('data-category="ick"');
    const mizuki = list.innerHTML.indexOf('data-category="mzk"');
    const miku = list.innerHTML.indexOf('data-category="miku"');
    assert.ok(ichika !== -1 && ichika < mizuki && mizuki < miku);
    assert.match(list.innerHTML, />\s*晓山瑞希\s*</);
    assert.match(list.innerHTML, />\s*初音未来\s*</);
  });

  test('typed emoji queries use the compact result list', () => {
    const { manager, input, list } = createFixture('hello :jo', { emojis });
    manager.handleInput({ target: input, key: 'o' });
    assert.equal(manager.autocompleteType, 'emoji');
    assert.equal(manager.autocompleteStart, 6);
    assert.equal(list.classList.contains('picker-mode'), false);
    assert.match(list.innerHTML, /class="active mention-item emoji-autocomplete-item"/);
  });

  test('completes emoji queries with closing colons', () => {
    const { manager, input } = createFixture('hello :jo', { emojis });
    manager.handleInput({ target: input, key: 'o' });
    manager.completeEmoji('joy');
    assert.equal(input.value, 'hello :joy:');
    assert.equal(input.selectionStart, input.value.length);
  });

  test('does not treat URL schemes or completed shortcodes as queries', () => {
    const urlFixture = createFixture('https:', { emojis });
    urlFixture.manager.handleInput({ target: urlFixture.input, key: ':' });
    assert.notEqual(urlFixture.manager.autocompleteType, 'emoji');

    const closedFixture = createFixture(':joy:', { emojis });
    closedFixture.manager.handleInput({ target: closedFixture.input, key: ':' });
    assert.notEqual(closedFixture.manager.autocompleteType, 'emoji');
  });
});
