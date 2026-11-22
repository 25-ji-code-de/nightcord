/* SPDX-License-Identifier: AGPL-3.0-only */
import { readBrowserScript } from '../scripts/browser-source.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 提醒路由的静态夹具：只跑 ui-manager 及其组件，不建 DOM。
 * 路由判断必须能脱离浏览器验证，否则只能靠点。
 */
function fixture() {
  const context = vm.createContext({ window: {}, console, TextEncoder, TextDecoder, atob, btoa });
  for (const file of ['sekai-renderer.js', 'mention-service.js', 'ui-manager.js']) {
    vm.runInContext(readBrowserScript(file), context);
  }
  const ui = vm.runInContext('Object.create(UIManager.prototype)', context);
  ui.messageMeta = new Map();
  ui.currentUser = { id: 'sekai:me', displayName: '我' };
  ui.mentions = new context.window.NightcordMentions(vm.runInContext('new SekaiRenderer()', context));
  return { context, ui };
}

/** vm 里的数组属于另一个 realm，转成本地数组再比较。 */
const targets = (ui, text) => Array.from(ui.replyTargets(text));

const ME = { id: 'sekai:me', displayName: '我' };

/** 记一条「被回复的消息」的元数据，模拟渲染时写进 messageMeta 的记录。 */
function rememberMessage(ui, timestamp, profileId) {
  const meta = { user: '我', text: '六点半到', profileId };
  ui.messageMeta.set(timestamp, meta);
  ui.messageMeta.set(Number(timestamp), meta);
}

test('reply targets parse both v2 and legacy v1 tokens', () => {
  const { ui } = fixture();
  assert.deepEqual(targets(ui, '<$SEKAI:Reply::1700000000000> 好的'), [1700000000000]);
  assert.deepEqual(targets(ui, '[re:1700000000000|六点半到] 好的'), [1700000000000]);
  // 同一条消息里重复引用只算一次
  assert.deepEqual(
    targets(ui, '<$SEKAI:Reply::1700000000000> <$SEKAI:Reply::1700000000000>'),
    [1700000000000],
  );
  // 没有回复、畸形 token 都不是回复
  assert.deepEqual(targets(ui, '就是普通消息'), []);
  assert.deepEqual(targets(ui, '<$SEKAI:Reply::> 空的'), []);
  assert.deepEqual(targets(ui, '<$SEKAI:Reply::abc> 不是时间戳'), []);
  assert.deepEqual(targets(ui, '<$SEKAI:123:x> 畸形类型'), []);
});

test('a reply only counts when it targets my own message identity', () => {
  const { ui } = fixture();
  rememberMessage(ui, 1700000000000, ME.id);
  const token = '<$SEKAI:Reply::1700000000000> 好的';

  assert.equal(ui.isReplyToMe(token, ME), true);
  // 别人的 id 不算，哪怕同一个显示名
  assert.equal(ui.isReplyToMe(token, { id: 'sekai:other', displayName: '我' }), false);
  // 没有身份就不认，宁可漏报也不误报
  assert.equal(ui.isReplyToMe(token, { displayName: '我' }), false);
  assert.equal(ui.isReplyToMe(token, null), false);
  // 回复了一条不认识的消息（不在本地元数据里）
  assert.equal(ui.isReplyToMe('<$SEKAI:Reply::1699999999999> 嗯', ME), false);
});

test('legacy messages without an author id never claim a reply', () => {
  const { ui } = fixture();
  rememberMessage(ui, 1700000000000, null);
  assert.equal(ui.isReplyToMe('<$SEKAI:Reply::1700000000000> 好的', ME), false);
});

test('mentions win over replies when a message does both', () => {
  const { ui } = fixture();
  rememberMessage(ui, 1700000000000, ME.id);
  const both = `<$SEKAI:Reply::1700000000000> ${ui.mentions.format({ id: ME.id, name: '我' })} 下午就画完了`;
  assert.equal(ui.isReplyToMe(both, ME), true);
  assert.equal(ui.noticeFor(both), 'mention');

  assert.equal(ui.noticeFor('<$SEKAI:Reply::1700000000000> 好的'), 'reply');
  assert.equal(ui.noticeFor('随便说说'), null);
});

test('reply detection degrades quietly without the mention tokenizer', () => {
  const { ui } = fixture();
  rememberMessage(ui, 1700000000000, ME.id);
  ui.mentions = null;
  assert.deepEqual(targets(ui, '<$SEKAI:Reply::1700000000000> 好的'), []);
  assert.equal(ui.isReplyToMe('<$SEKAI:Reply::1700000000000> 好的', ME), false);
});
