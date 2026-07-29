import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const read = (path) => readFileSync(join(root, path), 'utf8');

describe('SEKAI Design chat components', () => {
  for (const [file, source] of [
    ['chat.css', 'css/layout/chat.css'],
    ['modal.css', 'css/components/modal.css'],
  ]) {
    test(`${file} is pinned to the tagged source`, () => {
      assert.match(
        read(`vendor/sekai-design/${file}`),
        new RegExp(`^/\\* @sekai-vendor @sekai/design@v0\\.1\\.0 ${source.replaceAll('/', '\\/')} \\*/`),
      );
    });
  }

  test('markup composes upstream and compatibility classes', () => {
    const html = read('index.html');
    for (const className of ['sekai-or', 'sekai-window-dots', 'sekai-messages', 'sekai-composer__actions', 'sekai-message__text']) {
      assert.match(html, new RegExp(`\\b${className}\\b`));
    }
  });

  test('local CSS does not duplicate adopted component rules', () => {
    const css = read('css/app-shell.css');
    for (const selector of ['message-text', 'input-btns', 'auth-divider']) {
      assert.doesNotMatch(css, new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{`));
    }
    assert.doesNotMatch(css, /\.window-btn\s*\{[^}]*\b(?:width|height|border-radius)\s*:/s);
    assert.doesNotMatch(css, /\.window-buttons\s*\{[^}]*\b(?:margin-left|gap)\s*:/s);
  });
});
