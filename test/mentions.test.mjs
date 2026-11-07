/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function fixture() {
  const context = vm.createContext({ window: {}, console, TextEncoder, TextDecoder, atob, btoa });
  for (const file of ['sekai-renderer.js', 'mention-service.js', 'ai-config.js', 'ui-manager.js']) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  }
  const renderer = vm.runInContext('new SekaiRenderer()', context);
  const mentions = new context.window.NightcordMentions(renderer);
  return { context, mentions, detect: text => context.window.AIConfig.detectAITrigger(text, mentions) };
}

test('personal mentions target identities through name collisions and renames', () => {
  const { mentions } = fixture();
  const token = mentions.format({ id: 'sekai:one', name: '同名用户' });
  assert.equal(mentions.isMentioned(token, { id: 'sekai:one', displayName: '改名后' }), true);
  assert.equal(mentions.isMentioned(token, { id: 'sekai:two', displayName: '同名用户' }), false);
  assert.equal(mentions.isMentioned(token), false);
});

test('everyone reaches all users while role stays reserved', () => {
  const { mentions } = fixture();
  for (const user of [null, { id: 'guest:one' }, { id: 'sekai:one' }]) {
    assert.equal(mentions.isMentioned('<$SEKAI:Mention:type=all:>', user), true);
    assert.equal(mentions.isMentioned('@everyone 请看这里', user), true);
    assert.equal(mentions.isMentioned('<$SEKAI:Mention:type=role;display=everyone:admin>', user), false);
  }
});

test('legacy mentions respect boundaries, code examples, URLs and literal punctuation in names', () => {
  const { mentions } = fixture();
  const user = { displayName: 'Ann' };
  assert.equal(mentions.isMentioned('你好 @Ann！', user), true);
  assert.equal(mentions.isMentioned('请看 @a.b+ (消息)', { displayName: 'a.b+' }), true);
  for (const text of ['@Annabelle', '@Ann_2', '@Ann-other', 'mail@Ann.com', '`@Ann`', '```\n@Ann\n```', 'https://example.test/@Ann', '@everyoneElse']) {
    assert.equal(mentions.isMentioned(text, user), false, text);
  }
  assert.equal(mentions.isMentioned('<$SEKAI:Code::@Ann>', user), false);
});

test('mention descriptions round trip without truncating Unicode or delimiters', () => {
  const { mentions, context } = fixture();
  const name = '汤川唯 + 空格 : ; % > < = 😀';
  const token = mentions.format({ id: 'guest:one', name });
  const [part] = mentions.parts(token);
  assert.equal(part.payload, 'guest:one');
  assert.equal(part.desc.display, name);
  assert.equal(mentions.prompt(token), `@${name}`);
  const ui = vm.runInContext('Object.create(UIManager.prototype)', context);
  assert.equal(ui.extractPlainTextForReply(token), `@${name}`);
  assert.equal(ui.extractPlainTextForReply('<$SEKAI:Mention:type=all:>'), '@everyone');
});

test('structured AI mentions select by payload, remove wire syntax and preserve other names', () => {
  const { mentions, detect } = fixture();
  const ai = mentions.format({ type: 'ai', id: 'yui', name: 'Misleading Nako' });
  const user = mentions.format({ id: 'sekai:one', name: '小雨' });
  const result = detect(`${ai} 请和 ${user} 打招呼`);
  assert.equal(result.persona, 'yui');
  assert.equal(result.prompt, '请和 @小雨 打招呼');
  for (const text of [
    '<$SEKAI:Mention:type=user;display=@Nako:sekai:one> 你好',
    '<$SEKAI:Mention:type=role;display=@Nako:nako> 你好',
    '<$SEKAI:Mention:type=ai;display=Nako:unknown> 你好',
    '<$SEKAI:Code::@Nako> 你好',
  ]) assert.equal(detect(text), null, text);
});

test('AI commands and legacy mentions work at the start, inline and across lines', () => {
  const { detect } = fixture();
  for (const [text, persona, prompt] of [
    ['/nako 你好', 'nako', '你好'],
    ['/YUI 第一行\n第二行', 'yui', '第一行\n第二行'],
    ['请问 @miku，今天好吗', 'miku', '请问 ，今天好吗'],
    ['@汤川唯 你好', 'yui', '你好'],
    ['@Nako', 'nako', ''],
  ]) {
    assert.equal(detect(text)?.persona, persona, text);
    assert.equal(detect(text)?.prompt, prompt, text);
  }
  for (const text of ['@Nakotest 你好', '`@Nako`', 'https://example.test/@Nako']) assert.equal(detect(text), null);
});

test('autocomplete candidates preserve same-name identities and prefer current names', () => {
  const { context } = fixture();
  const ui = vm.runInContext('Object.create(UIManager.prototype)', context);
  Object.assign(ui, {
    roster: [{ name: 'Same', profile: { id: 'sekai:one', displayName: 'Same' } }],
    messages: [
      { user: 'Old', profile: { id: 'sekai:one', displayName: 'Old' } },
      { user: 'Same', profile: { id: 'guest:two', displayName: 'Same' } },
      { user: 'Same', text: 'Legacy message without identity' },
      { user: 'Old', text: 'An old alias is not a new person' },
      { user: 'Nako', text: 'An AI speaker is not a user candidate' },
      { user: 'Unknown', text: 'No ID to target' },
    ],
  });
  const users = ui.getAllUsers();
  assert.equal(users.length, 2);
  assert.deepEqual(Array.from(users, u => u.profile.id), ['sekai:one', 'guest:two']);
  assert.deepEqual(Array.from(users, u => u.name), ['Same', 'Same']);
});

test('room synchronization signals readiness after every reconnect without repeating welcomes', () => {
  const { context } = fixture();
  context.WebSocketManager = class {};
  vm.runInContext(readFileSync(new URL('../nightcord-mgr.js', import.meta.url), 'utf8'), context);
  const Manager = vm.runInContext('NightcordManager', context);
  const events = [];
  const manager = new Manager({ eventBus: { emit: name => events.push(name) } });
  manager.roomname = 'mention-test';
  manager.handleMessage({ ready: true });
  manager.handleReconnect();
  manager.handleMessage({ ready: true });
  assert.equal(events.filter(name => name === 'room:synced').length, 2);
  assert.equal(events.filter(name => name === 'room:ready').length, 1);
});
