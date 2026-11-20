/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { browserComponents } from '../scripts/browser-source.mjs';

const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const nested = directory => readdirSync(new URL(directory, root), { recursive: true })
  .filter(file => /\.(?:js|css)$/.test(file)).map(file => `${directory}/${file.replaceAll('\\', '/')}`);

test('classic script components load once and precede their public entry points', () => {
  const scripts = [...read('index.html').matchAll(/<script\b[^>]*src="\/([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(scripts).size, scripts.length);
  for (const [entry, components] of Object.entries(browserComponents)) {
    assert.ok(scripts.includes(entry), entry);
    for (const component of components) {
      assert.ok(scripts.includes(component), component);
      assert.ok(scripts.indexOf(component) < scripts.indexOf(entry), `${component} must precede ${entry}`);
    }
  }
  // Compile together as well: separate syntax checks miss duplicate global bindings.
  new vm.Script(scripts.map(read).join('\n'));
});

test('handwritten frontend files remain below the documented review threshold', () => {
  const generated = new Set(['emoji-data.js', 'emoji-unicode-data.js', 'purify.js', 'pangu.js']);
  const files = readdirSync(root).filter(file => file.endsWith('.js') && !generated.has(file));
  for (const file of [...files, ...nested('js'), ...nested('css')]) {
    assert.ok(read(file).trimEnd().split('\n').length <= 700, `${file}: split by responsibility before exceeding 700 lines`);
  }
});

test('business and transport modules do not reach into views or browser storage', () => {
  for (const file of ['nightcord-mgr.js', 'websocket-mgr.js', 'js/services/message-commands.js', 'js/services/ai-conversation.js', 'js/renderer/parser.js']) {
    assert.doesNotMatch(read(file), /\b(?:window|document|localStorage|UIManager)\b|\bthis\.(?:ui|app)\b/, file);
  }
  assert.doesNotMatch(read('websocket-mgr.js'), /guest_session|required|accessToken|auth_invalid|ChatSessionProtocol/);
  for (const file of nested('js/ui')) {
    assert.doesNotMatch(read(file), /\b(?:WebSocketManager|NightcordManager)\b|detectAITrigger|emit\('nako:ask'/, file);
  }
});

test('all split browser components are in the production page and offline cache', () => {
  const html = read('index.html');
  const context = vm.createContext({ self: { addEventListener() {} } });
  const precache = vm.runInContext(`${read('sw.js')}\nPRECACHE`, context);
  for (const file of nested('js')) {
    assert.ok(html.includes(`src="/${file}"`), file);
    assert.ok(precache.includes(`/${file}`), file);
  }
});
