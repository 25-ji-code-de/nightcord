/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readBrowserScript } from '../scripts/browser-source.mjs';

const ROOM = 'nightcord-roleplay';

function fixture({ room = ROOM, stored = {}, failWrites = false } = {}) {
  const values = new Map(Object.entries(stored));
  const state = { room };
  const context = vm.createContext({ console, TextEncoder, TextDecoder, WebSocketManager: class {} });
  for (const file of ['event-bus.js', 'js/services/roleplay.js', 'js/services/message-commands.js', 'nightcord-mgr.js']) {
    vm.runInContext(readBrowserScript(file), context);
  }
  const make = () => vm.runInContext(`new Roleplay({
    settings: { getItem: key => store.get(key) ?? null, setItem: (key, value) => { if (fail()) throw Error('blocked'); store.set(key, value); } },
    getRoom: () => state.room, reserved: () => ['Nako', 'Asagi']
  })`, Object.assign(context, { store: values, state, fail: () => failWrites }));
  return { context, values, state, make, roleplay: make() };
}

function manager(roleplay, room = ROOM) {
  const events = [];
  const f = fixture({ room });
  const Manager = vm.runInContext('NightcordManager', f.context);
  const instance = new Manager({
    createTransport: () => ({}), roleplay,
    eventBus: { emit: (type, data) => events.push({ type, data }) },
    aiConfig: { getAllDisplayNames: () => ['Nako'] }
  });
  instance.roomname = room;
  return { instance, events };
}

const user = { id: 'sekai:one', displayName: 'Alice', authenticated: true };

test('默认提供 K、雪、えななん、Amia，且默认不以角色发言', () => {
  const { roleplay } = fixture();
  assert.deepEqual(Array.from(roleplay.roles), ['K', '雪', 'えななん', 'Amia']);
  assert.equal(roleplay.active, null);
  assert.equal(roleplay.encode('hello'), 'hello');
});

test('添加角色会校验名称，并在刷新后保留；默认角色不能删除', () => {
  const f = fixture();
  assert.equal(f.roleplay.add('  Mafuyu ').name, 'Mafuyu');
  for (const bad of ['', '   ', 'k', '雪', 'えななん', 'mafuyu', 'Nako', 'asagi', '系统', 'a[b', 'a]b', 'x'.repeat(17), 'a\nb', 42]) {
    assert.equal(f.roleplay.add(bad).ok, false, String(bad));
  }
  assert.deepEqual(Array.from(f.roleplay.roles), ['K', '雪', 'えななん', 'Amia', 'Mafuyu']);
  assert.deepEqual(Array.from(f.make().roles), Array.from(f.roleplay.roles));
  assert.equal(f.roleplay.remove('K'), false);
  assert.equal(f.roleplay.remove('Mafuyu'), true);
  assert.equal(f.make().roles.length, 4);
});

test('自定义角色数量有上限', () => {
  const { roleplay } = fixture();
  for (let i = 0; i < 16; i++) assert.equal(roleplay.add(`角色${i}`).ok, true);
  assert.equal(roleplay.add('多一个').ok, false);
});

test('损坏或被篡改的本地数据会被过滤，不影响默认角色', () => {
  const bad = fixture({ stored: { 'nightcord-roleplay-roles': '{not json' } });
  assert.equal(bad.roleplay.roles.length, 4);
  const dirty = fixture({ stored: { 'nightcord-roleplay-roles': JSON.stringify(['Ok', 'K', 'Nako', 5, 'a[b', 'ok', null]) } });
  assert.deepEqual(Array.from(dirty.roleplay.roles), ['K', '雪', 'えななん', 'Amia', 'Ok']);
});

test('选中的角色刷新后恢复；被删除的角色不会恢复', () => {
  const f = fixture();
  f.roleplay.add('Mafuyu'); f.roleplay.select('Mafuyu');
  assert.equal(f.make().active, 'Mafuyu');
  f.roleplay.remove('Mafuyu');
  assert.equal(f.roleplay.active, null);
  assert.equal(f.make().active, null);
  assert.equal(f.roleplay.select('不存在'), null);
  for (const [previous, current] of [['Yuki', '雪'], ['Enanan', 'えななん']]) {
    const restored = fixture({ stored: { 'nightcord-roleplay-active': previous } });
    assert.equal(restored.roleplay.active, current);
    assert.equal(restored.values.get('nightcord-roleplay-active'), current);
    assert.equal(restored.make().active, current);
    const custom = fixture({ stored: {
      'nightcord-roleplay-roles': JSON.stringify([previous]), 'nightcord-roleplay-active': previous
    } });
    assert.equal(custom.roleplay.active, previous);
    assert.equal(custom.values.get('nightcord-roleplay-active'), previous);
  }
});

test('存储不可用时仍能在当前页面使用角色', () => {
  const f = fixture({ failWrites: true });
  assert.equal(f.roleplay.add('Mafuyu').ok, true);
  assert.equal(f.roleplay.select('Mafuyu'), 'Mafuyu');
  assert.equal(f.roleplay.encode('hi'), '[角色:Mafuyu]hi');
});

test('只在语C编码，其他房间原样发送', () => {
  const f = fixture();
  f.roleplay.select('雪');
  assert.equal(f.roleplay.encode('你好'), '[角色:雪]你好');
  f.state.room = 'nightcord-default';
  assert.equal(f.roleplay.encode('你好'), '你好');
});

test('接收端只在语C解析合法角色消息', () => {
  const { roleplay } = fixture();
  assert.deepEqual({ ...roleplay.decode('[角色:Amia]早上好', ROOM) }, { name: 'Amia', text: '早上好' });
  assert.deepEqual({ ...roleplay.decode('[角色:Amia]第一行\n第二行', ROOM) }, { name: 'Amia', text: '第一行\n第二行' });
  assert.equal(roleplay.decode('[角色:Amia]早上好', 'nightcord-default'), null);
  for (const text of ['[角色:Amia]', '[角色:]x', '[角色:Nako]x', '[角色:系统]x', '[角色: Amia ]x', '[角色:a[b]x', ' [角色:Amia]x', '普通消息']) {
    assert.equal(roleplay.decode(text, ROOM), null, text);
  }
});

test('收到角色消息时显示为真实发送者转发，但不当作 AI 消息', () => {
  const f = fixture();
  const { instance, events } = manager(f.roleplay);
  instance.handleMessage({ name: 'Alice', message: '[角色:K]25 点见', timestamp: 10, user });
  const data = events.at(-1).data;
  assert.equal(data.name, 'K');
  assert.equal(data.message, '25 点见');
  assert.equal(data.user, null);
  assert.equal(data.sender.id, user.id);
  assert.equal(data.isNako, false);
  assert.equal(data.isRoleplay, true);
});

test('AI 前缀优先，非语C与普通消息不受影响', () => {
  const f = fixture();
  const ai = manager(f.roleplay);
  ai.instance.handleMessage({ name: 'Alice', message: '[Nako][角色:K]x', timestamp: 10, user });
  assert.equal(ai.events.at(-1).data.name, 'Nako');
  assert.equal(ai.events.at(-1).data.isRoleplay, false);
  const other = manager(f.roleplay, 'nightcord-default');
  other.instance.handleMessage({ name: 'Alice', message: '[角色:K]x', timestamp: 10, user });
  const data = other.events.at(-1).data;
  assert.equal(data.name, 'Alice'); assert.equal(data.user.id, user.id); assert.equal(data.sender, null);
  const plain = manager(f.roleplay);
  plain.instance.handleMessage({ name: 'Alice', message: 'hi', timestamp: 10, user });
  assert.equal(plain.events.at(-1).data.user.id, user.id);
});

test('没有注入角色服务时行为与以前一致', () => {
  const { instance, events } = manager(null);
  instance.handleMessage({ name: 'Alice', message: '[角色:K]x', timestamp: 10, user });
  assert.equal(events.at(-1).data.message, '[角色:K]x');
});

test('发送时加角色前缀，前缀计入 256 字符上限且不被格式化改写', () => {
  const f = fixture();
  f.roleplay.select('えななん');
  const sent = [], errors = [];
  const bus = vm.runInContext('new EventBus()', f.context);
  bus.on('error', data => errors.push(data.message));
  const Commands = vm.runInContext('MessageCommands', f.context);
  const commands = new Commands({
    eventBus: bus, aiConfig: { detectAITrigger: () => null }, typeSource: '[A-Za-z][A-Za-z0-9-]*',
    send: message => { sent.push(message); return true; }, encode: message => f.roleplay.encode(message)
  });
  assert.equal(commands.submit('你好'), true);
  assert.equal(sent[0], '[角色:えななん]你好');
  const room = '[角色:えななん]'.length;
  assert.equal(commands.submit('x'.repeat(256 - room)), true);
  assert.equal(sent[1].length, 256);
  assert.equal(commands.submit('x'.repeat(257 - room)), false);
  assert.match(errors.at(-1), /角色前缀/);
  assert.equal(sent.length, 2);
  f.roleplay.select(null);
  assert.equal(commands.submit('x'.repeat(256)), true);
  assert.equal(sent[2].length, 256);
});

test('在语C中提问 AI 不加角色前缀，避免 AI 回复被误认', () => {
  const f = fixture();
  f.roleplay.select('K');
  const sent = [], asks = [];
  const bus = vm.runInContext('new EventBus()', f.context);
  bus.on('nako:ask', data => asks.push(data));
  const Commands = vm.runInContext('MessageCommands', f.context);
  const commands = new Commands({
    eventBus: bus, typeSource: '[A-Za-z][A-Za-z0-9-]*',
    aiConfig: { detectAITrigger: text => text.startsWith('/nako') ? { persona: 'nako', displayName: 'Nako', prompt: text.slice(5).trim() } : null },
    send: message => { sent.push(message); return true; }, encode: message => f.roleplay.encode(message)
  });
  assert.equal(commands.submit('/nako 你好'), true);
  assert.equal(sent[0], '/nako 你好');
  assert.equal(asks.length, 1);
});
