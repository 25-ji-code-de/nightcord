/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readBrowserScript } from '../scripts/browser-source.mjs';

function fixture() {
  const context = vm.createContext({ console, TextEncoder, TextDecoder, atob, btoa });
  for (const file of ['event-bus.js', 'js/services/message-commands.js', 'js/services/ai-conversation.js', 'js/renderer/resources.js', 'js/renderer/parser.js']) {
    vm.runInContext(readBrowserScript(file), context);
  }
  const bus = vm.runInContext('new EventBus()', context);
  const Commands = vm.runInContext('MessageCommands', context);
  const sent = [], asks = [], errors = [], notices = [];
  let accepts = true;
  const aiConfig = {
    getAllDisplayNames: () => ['Nako'],
    detectAITrigger: text => /^\/nako(?:\s|$)/i.test(text)
      ? { persona: 'nako', displayName: 'Nako', prompt: text.slice(5).trim() } : null
  };
  bus.on('nako:ask', data => asks.push(data));
  bus.on('error', data => errors.push(data.message));
  bus.on('message:notice', data => notices.push(data.message));
  const commands = new Commands({
    eventBus: bus, aiConfig, typeSource: '[A-Za-z][A-Za-z0-9-]*',
    send: message => { if (!accepts) return false; sent.push(message); return true; },
    spacing: text => text.replaceAll('中文English', '中文 English')
  });
  return { context, bus, commands, sent, asks, errors, notices, aiConfig, reject: () => { accepts = false; } };
}

test('commands validate both raw and formatted length without losing rejected drafts', () => {
  const h = fixture();
  assert.equal(h.commands.submit('x'.repeat(257)), false);
  assert.equal(h.commands.submit('x'.repeat(247) + '中文English'), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.errors.length, 2);
  assert.equal(h.commands.submit('中文English [stamp_0001]'), true);
  assert.equal(h.sent[0], '中文 English [stamp:0001]');
});

test('formatting protects valid SEKAI tokens, multiline blocks and nested markdown', () => {
  const { commands } = fixture();
  for (const input of [
    '<$SEKAI:Format::中文English>',
    '<$SEKAI:Code:lang=js>\r\n中文English\r\n<&SEKAI>',
    '**中文English**', '`中文English`', '||中文English||', '__SEKAI_0__ <$SEKAI:Format::中文English>'
  ]) assert.equal(commands.format(input), input);
  assert.equal(commands.format('<$SEKAI:123::中文English>'), '<$SEKAI:123::中文 English>');
});

test('AI commands run once after successful broadcast and never on incoming messages', () => {
  const h = fixture();
  assert.equal(h.commands.submit('/nako'), false);
  assert.equal(h.asks.length, 0);
  assert.equal(h.commands.submit('/nako 你好'), true);
  assert.equal(h.sent[0], '/nako 你好');
  assert.equal(h.asks[0].prompt, '你好');
  h.bus.emit('message:received', { name: 'Peer', message: '/nako 你好' });
  assert.equal(h.asks.length, 1);
  h.reject();
  assert.equal(h.commands.submit('/nako 再见'), false);
  assert.equal(h.asks.length, 1);
});

test('clear resets context locally and requests input clearing without broadcasting', () => {
  const h = fixture();
  let clears = 0, sent = 0;
  h.bus.on('nako:clear', () => clears++);
  h.bus.on('message:sent', () => sent++);
  assert.equal(h.commands.submit('/CLEAR'), true);
  assert.equal(clears, 1);
  assert.equal(sent, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.notices.length, 1);
});

test('AI context survives preview confirmation, filters clears and changes rooms without UI state', () => {
  const h = fixture();
  const Conversation = vm.runInContext('AIConversation', h.context);
  const settings = new Map();
  let room = 'one';
  const user = { id: 'sekai:one' };
  const calls = [], forwarded = [];
  const conversation = new Conversation({
    eventBus: h.bus, aiConfig: h.aiConfig,
    loadMessages: () => [{ user: 'Peer', text: 'old', timestamp: 1 }],
    getUser: () => user, getRoom: () => room, getUsername: () => 'Me',
    settings: { getItem: key => settings.get(key), setItem: (key, value) => settings.set(key, value) },
    ask: (prompt, options) => calls.push({ prompt, options }), send: message => forwarded.push(message)
  });
  h.bus.emit('room:joining', { roomname: room });
  h.bus.emit('nako:stream:end', { messageId: 'preview', user: 'Nako', fullContent: ' hello ' });
  assert.equal(conversation.getRecentHistory().length, 2);
  assert.equal(forwarded[0], '[Nako]hello');
  const echo = { name: 'Nako', message: 'hello', timestamp: 100, sender: user, isNako: true };
  h.bus.emit('message:received', echo);
  h.bus.emit('message:received', echo);
  assert.equal(conversation.getRecentHistory().length, 2);
  assert.equal(conversation.pending.size, 0);
  h.bus.emit('nako:ask', { prompt: 'next' });
  assert.equal(calls[0].options.history[1].isBot, true);
  h.bus.emit('nako:clear');
  assert.equal(conversation.getRecentHistory().length, 0);
  assert.ok(settings.has('nightcord-nako-clear-timestamp'));
  conversation.clearTimestamp = 0;
  room = 'two'; h.bus.emit('room:joining', { roomname: room });
  assert.equal(conversation.getRecentHistory().length, 1);
});

test('SEKAI parser runs without a renderer and retains tolerant decoding and token limits', () => {
  const { context } = fixture();
  const Parser = vm.runInContext('SekaiParser', context);
  const parser = new Parser({ maxTokensPerMessage: 1 });
  const tokens = parser.tokenize('<$SEKAI:Mention:type=user;display=A+B%ZZ:id> <$SEKAI:Stamp::stamp0001>');
  assert.equal(tokens.filter(token => token.type === 'sekai').length, 1);
  assert.equal(tokens[0].desc.display, 'A B%ZZ');
  assert.equal(new Parser().tokenize('<$SEKAI:Format:enc=base64:aGk=>')[0].payload, 'hi');
});
