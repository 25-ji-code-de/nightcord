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
let EmojiService;

before(() => {
  const window = {};
  const load = (file) => new Function('window', readFileSync(join(root, file), 'utf8'))(window);
  load('emoji-data.js');
  load('emoji-service.js');
  EmojiService = window.EmojiService;
});

describe('EmojiService', () => {
  test('loads the complete hosted catalog', () => {
    const service = new EmojiService();
    assert.equal(service.getEmojis().length, 2366);
  });

  test('resolves exact catalog names without aliases', () => {
    const service = new EmojiService();
    assert.match(service.resolve('joy').url, /smileys_%26_emotion\/joy\.png$/);
    assert.match(service.resolve('curaçao').url, /cura%C3%A7ao\.png$/);
    assert.equal(service.resolve('smile'), null);
    assert.equal(service.resolve('curacao'), null);
    assert.equal(service.resolve('does_not_exist'), null);
  });

  test('tokenizes known shortcodes and preserves unknown ones', () => {
    const service = new EmojiService();
    const tokens = service.tokenize('hello :grinning_face_with_smiling_eyes: :unknown: :joy:');
    assert.deepEqual(tokens.map((token) => token.type), ['text', 'emoji', 'text', 'emoji']);
    assert.equal(tokens[1].raw, ':grinning_face_with_smiling_eyes:');
    assert.equal(tokens[2].content, ' :unknown: ');
    assert.equal(tokens[3].emoji.shortcode, 'joy');
  });

  test('supports non-ASCII catalog filenames as exact shortcodes', () => {
    const service = new EmojiService();
    const tokens = service.tokenize(':piñata: :curaçao:');
    assert.deepEqual(
      tokens.filter((token) => token.type === 'emoji').map((token) => token.emoji.shortcode),
      ['piñata', 'curaçao']
    );
  });
});
