/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MessagePolicy as policy } from '../js/services/message-policy.js';

test('emoji folding counts graphemes, not UTF-16 units, numbers or protocol metadata', () => {
  assert.deepEqual(policy.analyze('💃🏻👨‍👩‍👧‍👦🇨🇳1️⃣'), { length: 4, emojis: 4, lines: 1, reason: null });
  assert.equal(policy.analyze('今天很开心😊').reason, null);
  assert.equal(policy.analyze('1'.repeat(100)).emojis, 0);
  const ratio = '文'.repeat(72) + '😊'.repeat(8);
  assert.equal(policy.analyze(ratio).reason, '表情较多的长消息');
  assert.equal(policy.analyze('文'.repeat(71) + '😊'.repeat(8)).reason, null);
  assert.equal(policy.analyze('文'.repeat(180) + '😊'.repeat(15)).reason, '表情较多的长消息');
  assert.equal(policy.analyze(`<$SEKAI:Reply::123> ${ratio}`).length, 80);
  assert.equal(policy.analyze(`<$SEKAI:Files:name=${'😊'.repeat(100)}:file-id>`).reason, null);
  assert.equal(policy.analyze('[emu_Wonderhoi]').length, 0);
  assert.equal(policy.analyze(`<$SEKAI:Format:color=red:${ratio}>`).reason, '表情较多的长消息');
  assert.equal(policy.analyze(`<$SEKAI:Format:enc=base64:${Buffer.from(ratio).toString('base64')}>`).reason, '表情较多的长消息');
  assert.equal(policy.fingerprint(`<$SEKAI:Format:bold=1:${ratio}>`), policy.fingerprint(ratio));
  assert.equal(policy.fingerprint('[re:123|preview] 6767'), policy.fingerprint('67'));
});

test('long prose, line floods and braille are folded independently of emoji', () => {
  assert.equal(policy.analyze('文字'.repeat(90)).reason, '较长的消息');
  assert.equal(policy.analyze('一\n二\n三\n四\n五\n六').reason, null);
  assert.equal(policy.analyze('一\n二\n三\n四\n五\n六\n七').reason, '较长的消息');
  assert.equal(policy.analyze('⣿'.repeat(24)).reason, '字符画');
});

test('repeat fingerprints ignore decoration and reply wrappers without conflating short conversations', () => {
  const key = policy.fingerprint.bind(policy);
  assert.equal(key('<$SEKAI:Reply::123> ⑥⑦！'), key('676767'));
  assert.equal(key('6...7 💙'), key('６７'));
  assert.equal(key('hello'), key('HELLO!'));
  assert.equal(policy.similar(key('今天下雨'), key('今天下雪')), false);
  assert.notEqual(key('😊'), key('😢'));
  assert.equal(key('？！'), '');
  const text = '今天我们一起去公园看看春天的花朵再沿着湖边散步欣赏沿途的风景然后回家一起准备晚饭聊聊最近发生的事情';
  assert.equal(policy.similar(key(text), key(text.replace('公园', '公园里面'))), true);
});

test('third personal repeat is rejected across tabs and the original window expires without extensions', () => {
  const entries = [1000, 5000].map(timestamp => ({ actor: 'account', content: '67', timestamp }));
  assert.deepEqual(policy.decide(entries, 'account', '67', 6000), { allowed: false, retryAfter: 55, repeated: false });
  assert.equal(policy.decide(entries, 'account', '67', 61000).allowed, true);
  assert.equal(policy.decide(entries, 'other-account', '67', 6000).allowed, true);
  assert.equal(policy.decide(entries, 'account', 'different', 6000).allowed, true);
});

test('group repeat needs both eight messages and four distinct identities in the rolling minute', () => {
  const entries = Array.from({ length: 7 }, (_, i) => ({ actor: `user${Math.floor(i / 2)}`, content: '67', timestamp: i * 1000 }));
  assert.equal(policy.decide(entries, 'user3', '67', 8000).repeated, true);
  assert.equal(policy.decide(entries.slice(1), 'user3', '67', 8000).repeated, false);
  assert.equal(policy.decide(entries.map(item => ({ ...item, actor: 'same' })), 'other', '67', 8000).repeated, false);
  assert.equal(policy.decide(entries, 'user3', '67', 68000).repeated, false);
});
