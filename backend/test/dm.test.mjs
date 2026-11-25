/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { createRuntime } from './runtime.mjs';
import { instrumentCosts } from './dm-cost-fixture.mjs';

const origin = 'https://nightcord.de5.net';
const profiles = Object.fromEntries(['alice', 'bob', 'eve'].map(name => [name, {
  id: 'sekai:' + name, sub: name, issuer: 'https://id.nightcord.de5.net', authenticated: true,
  displayName: name, username: name, avatarUrl: null, bio: '', isMobile: false,
}]));
const keyFor = (a = 'alice', b = 'bob') => createHash('sha256').update(JSON.stringify(['nightcord:dm:v1', ...[profiles[a].id, profiles[b].id].sort()])).digest('hex');
async function until(check, message = 'condition', timeout = 12000) {
  const end = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(30); } while (Date.now() < end);
  assert.fail('Timed out: ' + message);
}
async function fixture(t, bindings = {}, persistencePath, script) {
  const state = {};
  const runtime = createRuntime(state, { inspectDurableObjects: true, persistencePath, script, bindings: { DM_MODE: 'on', ...bindings },
    identities: Object.fromEntries(Object.keys(profiles).map(name => ['Bearer ' + name, name])) });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const rooms = await runtime.getDurableObjectNamespace('DM_ROOMS');
  const inboxes = await runtime.getDurableObjectNamespace('DM_INBOXES');
  const room = rooms.get(rooms.idFromName(keyFor()));
  const inbox = who => inboxes.get(inboxes.idFromName(profiles[who].id));
  const storage = (className, name) => runtime.unsafeGetDurableObjectStorage('nightcord-chat', className, { name });
  const api = async (who, path, data, extraHeaders = {}) => {
    const response = await fetch(base + '/api/dm/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(who ? { Authorization: 'Bearer ' + who } : {}), 'Content-Type': 'application/json', ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const connect = async (path, first) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + path, { headers: { Origin: origin, 'CF-Connecting-IP': crypto.randomUUID() } });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    t.after(() => { if (ws.readyState < 2) ws.close(); });
    await once(ws, 'open');
    if (first) ws.send(JSON.stringify(first));
    return { ws, messages };
  };
  const initialize = async () => {
    const result = await room.handle(profiles.alice, 'initialize', {}, { id: keyFor(), peer: profiles.bob });
    assert.equal(result.status, 200, JSON.stringify(result));
    await until(async () => (await inbox('alice').handle(profiles.alice, 'list', {})).data.conversations.length === 1);
  };
  return { runtime, state, base, room, inbox, rooms, inboxes, storage, api, connect, initialize };
}
const send = (f, who, text, clientMessageId = crypto.randomUUID()) => f.room.handle(profiles[who], 'send', { text, clientMessageId });
const list = async (f, who) => (await f.inbox(who).handle(profiles[who], 'list', {})).data.conversations;

test('repeated state commands do not write, but still enforce permissions and preserve explicit repair', async t => {
  const script = instrumentCosts(await readFile('dist/chat.js', 'utf8'));
  const f = await fixture(t, {}, undefined, script); await f.initialize();
  await send(f, 'alice', 'Request');
  const storage = await f.storage('DirectRoom', keyFor());
  for (const [action, input] of [['reject', {}], ['accept', {}], ['refuse', { refuseIncoming: true }], ['refuse', { refuseIncoming: false }]]) {
    const result = await f.room.handle(profiles.bob, action, input);
    await until(async () => !(await storage.exec('SELECT * FROM dm_outbox')).length);
    await delay(30); await f.room.costs(true);
    const again = await f.room.handle(profiles.bob, action, input);
    assert.equal(again.data.conversation.version, result.data.conversation.version);
    const costs = await f.room.costs();
    assert.equal(costs.rowsWritten, 0); assert.equal(costs.setAlarm || 0, 0); assert.equal(costs.deleteAlarm || 0, 0);
    assert.equal((await f.room.handle(profiles.eve, action, input)).status, 404);
  }
  assert.equal((await f.room.handle(profiles.alice, 'accept', {})).data.code, 'request_not_yours');
  assert.equal((await f.room.handle(profiles.bob, 'reject', {})).data.code, 'request_already_accepted');
  assert.equal((await f.room.handle(profiles.bob, 'refuse', {})).status, 400);
  const before = (await f.room.handle(profiles.bob, 'checkpoint', { seq: 0 })).data.conversation.version;
  assert.equal((await f.room.handle(profiles.bob, 'sync', {})).data.conversation.version, before + 1);
});

test('one drain owns in-flight deliveries and an old acknowledgement cannot erase newer work', async t => {
  let script = await readFile('dist/chat.js', 'utf8');
  script = script.replace(/(var DirectRoom = class extends \w+ \{)/, `$1
    testHold() { this.testGate = new Promise(resolve => { this.testRelease = resolve; }); this.testCalls = 0; }
    testCount() { return this.testCalls || 0; }
    testResume() { this.testRelease(); this.testGate = null; }
    testHoldFinish() { this.testFinishing = false; this.testFinishGate = new Promise(resolve => { this.testFinishRelease = resolve; }); }
    testAtFinish() { return !!this.testFinishing; }
    testResumeFinish() { this.testFinishRelease(); this.testFinishGate = null; }
    async testFinish() { this.testFinishing = true; if (this.testFinishGate) await this.testFinishGate; }
    async testApply(row) {
      if (row.owner_id === 'sekai:bob') { this.testCalls = (this.testCalls || 0) + 1; if (this.testGate) await this.testGate; }
      await this.env.DM_INBOXES.getByName(row.owner_id).apply(JSON.parse(row.snapshot));
    }
  `).replace('await this.env.DM_INBOXES.getByName(row.owner_id).apply(JSON.parse(row.snapshot));\n        this.ctx.storage.sql.exec',
    'await this.testApply(row);\n        this.ctx.storage.sql.exec')
    .replace('await this.ctx.storage.transaction(() => this.schedule());', '$&\n await this.testFinish();');
  const f = await fixture(t, {}, undefined, script); await f.initialize();
  await send(f, 'alice', 'Request'); await f.room.handle(profiles.bob, 'accept', {});
  const storage = await f.storage('DirectRoom', keyFor());
  await until(async () => !(await storage.exec('SELECT * FROM dm_outbox')).length); await delay(30);
  await f.room.testHold();
  await send(f, 'alice', 'Held delivery');
  await until(async () => await f.room.testCount() === 1);
  await send(f, 'alice', 'New version while old RPC waits');
  await send(f, 'alice', 'Newest version');
  assert.equal(await f.room.testCount(), 1, 'concurrent commands share one drain');
  await f.room.testResume();
  await until(async () => (await list(f, 'bob'))[0]?.lastSeq === 4);
  await until(async () => !(await storage.exec('SELECT * FROM dm_outbox')).length);
  assert.equal(await f.room.testCount(), 2, 'the next batch merges intermediate snapshots');
  assert.equal((await list(f, 'bob'))[0].incoming, 4);
  await delay(30); await f.room.testHoldFinish();
  await send(f, 'alice', 'Drain finishes');
  await until(() => f.room.testAtFinish());
  await send(f, 'alice', 'Arrives after scheduling but before drain exits');
  await f.room.testResumeFinish();
  await until(async () => (await list(f, 'bob'))[0]?.lastSeq === 6);
  await until(async () => !(await storage.exec('SELECT * FROM dm_outbox')).length);
});

test('HTTP authenticates participants, derives a unique room, and never trusts browser identity', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const preflight = await fetch(f.base + '/api/dm/conversations', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-max-age'), '86400');
  for (const who of Object.keys(profiles)) {
    const connection = await f.connect('/api/room/dm-fixture/websocket', { accessToken: who });
    await until(() => connection.messages.some(message => message.ready));
    connection.ws.close();
  }
  const [created, reverse] = await Promise.all([
    f.api('alice', 'conversations', { sourceRoom: 'dm-fixture', peerId: profiles.bob.id, senderId: profiles.eve.id }),
    f.api('bob', 'conversations', { sourceRoom: 'dm-fixture', peerId: profiles.alice.id }),
  ]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.conversation.id, keyFor());
  assert.equal(reverse.data.conversation.id, keyFor());
  assert.equal((await f.api(null, 'conversations')).status, 401);
  assert.equal((await f.api('forged', 'conversations')).status, 401);
  assert.equal((await f.api('eve', 'conversations/' + keyFor() + '/messages')).status, 404);
  assert.equal((await f.api('eve', 'conversations/' + keyFor() + '/hide', { hidden: true })).status, 404);
  const first = await f.api('alice', 'conversations/' + keyFor() + '/messages', { clientMessageId: crypto.randomUUID(), text: 'Private introduction', senderId: profiles.eve.id });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.message.senderId, profiles.alice.id);
  assert.equal((await f.api('alice', 'conversations/' + keyFor() + '/messages', { clientMessageId: crypto.randomUUID(), text: 'Cannot continue yet' })).data.code, 'request_pending');
  assert.equal((await f.api('alice', 'conversations/' + keyFor() + '/accept', {})).status, 403);
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/accept', {})).status, 200);
  const history = await f.api('bob', 'conversations/' + keyFor() + '/messages');
  assert.equal(history.data.messages[0].text, 'Private introduction');
  assert.equal(history.headers.get('cache-control'), 'no-store');
  const publicRoom = await f.connect('/api/room/' + keyFor() + '/websocket', { accessToken: 'eve' }).catch(() => null);
  if (publicRoom) {
    await until(() => publicRoom.messages.some(message => message.ready));
    assert.ok(!publicRoom.messages.some(message => message.message === 'Private introduction'));
  }
  f.state.revoked = true;
  assert.equal((await f.api('alice', 'conversations/' + keyFor() + '/messages')).status, 401);
});

test('requests, directional refusal, hidden delivery and monotonic read progress survive repeats', { timeout: 45000 }, async t => {
  const f = await fixture(t); await f.initialize();
  assert.equal((await list(f, 'bob')).length, 0, 'opening a profile does not create a request for the peer');
  const first = await send(f, 'alice', 'Hello');
  assert.equal(first.status, 200);
  assert.equal((await send(f, 'bob', 'Simultaneous request')).data.code, 'request_pending');
  assert.equal((await f.room.handle(profiles.bob, 'reject', {})).status, 200);
  assert.equal((await send(f, 'alice', 'Again')).data.code, 'request_rejected');
  assert.equal((await f.room.handle(profiles.bob, 'accept', {})).status, 200);
  await until(async () => (await list(f, 'bob'))[0].state === 'accepted');
  await f.inbox('bob').handle(profiles.bob, 'hide', { id: keyFor(), hidden: true });
  const clientMessageId = crypto.randomUUID();
  const one = await send(f, 'alice', 'Hidden but retained', clientMessageId);
  const retries = await Promise.all(Array.from({ length: 4 }, () => send(f, 'alice', 'Hidden but retained', clientMessageId)));
  assert.ok(retries.every(result => result.status === 200 && result.data.message.seq === one.data.message.seq));
  assert.equal((await send(f, 'alice', 'Changed body', clientMessageId)).data.code, 'message_id_conflict');
  await until(async () => (await list(f, 'bob'))[0].incoming === 2);
  let entry = (await list(f, 'bob'))[0];
  assert.equal(entry.hidden, true); assert.equal(entry.unread, 0);
  await f.room.handle(profiles.bob, 'refuse', { refuseIncoming: true });
  assert.equal((await send(f, 'alice', 'Refused')).data.code, 'recipient_refused');
  assert.equal((await send(f, 'alice', 'Hidden but retained', clientMessageId)).data.message.seq, one.data.message.seq);
  assert.equal((await send(f, 'bob', 'Other direction works')).status, 200);
  await f.room.handle(profiles.bob, 'refuse', { refuseIncoming: false });
  await until(async () => (await list(f, 'bob'))[0].lastSeq === 3);
  await f.inbox('bob').handle(profiles.bob, 'hide', { id: keyFor(), hidden: false });
  entry = (await list(f, 'bob'))[0];
  assert.equal(entry.unread, 2);
  const checkpoint = (await f.room.handle(profiles.bob, 'checkpoint', { seq: 3 })).data;
  await f.inbox('bob').handle(profiles.bob, 'read', { id: keyFor(), seq: checkpoint.seq, incoming: checkpoint.incoming });
  await f.inbox('bob').handle(profiles.bob, 'read', { id: keyFor(), seq: 1, incoming: 1 });
  assert.equal((await list(f, 'bob'))[0].unread, 0);
  assert.equal((await list(f, 'bob'))[0].readSeq, 3);
  const old = (await f.room.handle(profiles.bob, 'checkpoint', { seq: 0 })).data.conversation;
  await send(f, 'alice', 'Newest');
  await until(async () => (await list(f, 'bob'))[0].incoming === 3);
  await f.inbox('bob').apply(old);
  assert.equal((await list(f, 'bob'))[0].unread, 1);
  const history = await f.room.handle(profiles.bob, 'history', { limit: 2 });
  assert.deepEqual(history.data.messages.map(message => message.seq), [3, 4]);
  assert.equal(history.data.more, true);
  assert.deepEqual((await f.room.handle(profiles.bob, 'history', { before: 3 })).data.messages.map(message => message.seq), [1, 2]);
  assert.equal((await f.room.handle(profiles.eve, 'history', {})).status, 404);
});

test('persisted outbox retries a failed inbox after a full restart without losing message history', { timeout: 45000 }, async t => {
  const prefix = join(tmpdir(), 'nightcord-dm-');
  const persist = await mkdtemp(prefix);
  let f = await fixture(t, {}, persist); await f.initialize();
  const bobStorage = await f.storage('UserInbox', profiles.bob.id);
  await bobStorage.exec('ALTER TABLE dm_conversations RENAME TO broken_conversations');
  assert.equal((await send(f, 'alice', 'Survives receiver failure')).status, 200);
  const roomStorage = await f.storage('DirectRoom', keyFor());
  await until(async () => (await roomStorage.exec('SELECT attempts FROM dm_outbox WHERE owner_id=?', profiles.bob.id))[0]?.attempts > 0, 'persisted retry');
  await bobStorage.exec('ALTER TABLE broken_conversations RENAME TO dm_conversations');
  await f.runtime.dispose();
  f = await fixture(t, {}, persist);
  await until(async () => (await list(f, 'bob'))[0]?.incoming === 1, 'alarm after restart');
  assert.equal((await f.room.handle(profiles.bob, 'history', {})).data.messages[0].text, 'Survives receiver failure');
  const restored = await f.storage('DirectRoom', keyFor());
  await until(async () => (await restored.exec('SELECT * FROM dm_outbox')).length === 0);
  assert.equal((await list(f, 'bob'))[0].unread, 1);
  await f.runtime.dispose();
  assert.ok(resolve(persist).startsWith(resolve(prefix)));
  await rm(persist, { recursive: true, force: true });
});

test('account WebSocket authenticates before notification and rejects another account token', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.initialize();
  await f.inbox('bob').handle(profiles.bob, 'list', {});
  const path = '/api/dm/events?account=' + encodeURIComponent(profiles.bob.id);
  const unauthorized = await f.connect(path);
  await send(f, 'alice', 'Secret');
  await delay(100);
  assert.deepEqual(unauthorized.messages, []);
  const rejected = once(unauthorized.ws, 'close');
  unauthorized.ws.send(JSON.stringify({ type: 'auth', accessToken: 'eve' }));
  assert.equal((await rejected)[0], 4001);
  const authenticated = await f.connect(path, { type: 'auth', accessToken: 'bob' });
  await until(() => authenticated.messages.some(message => message.type === 'dm:ready'));
  assert.ok(!JSON.stringify(authenticated.messages).includes('Secret'));
  await f.inbox('bob').handle(profiles.bob, 'hide', { id: keyFor(), hidden: true });
  await until(() => authenticated.messages.some(message => message.type === 'dm:changed' && message.silent));
  const hiddenEvent = authenticated.messages.find(message => message.type === 'dm:changed' && message.silent);
  assert.equal(hiddenEvent.conversation.ownerId, profiles.bob.id);
  assert.equal(hiddenEvent.conversation.hidden, true);
  assert.equal(hiddenEvent.conversation.unread, 0);
  assert.ok(!JSON.stringify(authenticated.messages).includes('Secret'), 'notifications contain no message bodies');
  const revision = hiddenEvent.revision;
  await f.inbox('bob').handle(profiles.bob, 'hide', { id: keyFor(), hidden: true });
  assert.equal((await f.inbox('bob').handle(profiles.bob, 'get', { id: keyFor() })).data.revision, revision, 'repeated preferences do not write or broadcast');
  f.state.revoked = true;
  await delay(1050);
  const closed = once(authenticated.ws, 'close');
  authenticated.ws.send(JSON.stringify({ type: 'auth', accessToken: 'bob' }));
  assert.equal((await closed)[0], 4001);
});

test('read checkpoints count only incoming messages at or before the supplied sequence', async t => {
  const f = await fixture(t); await f.initialize();
  await send(f, 'alice', 'First');
  await f.room.handle(profiles.bob, 'accept', {});
  await send(f, 'bob', 'Reply');
  await send(f, 'alice', 'Second');
  await send(f, 'bob', 'Another reply');
  for (const [who, expected] of [['bob', [0, 1, 1, 2, 2]], ['alice', [0, 0, 1, 1, 2]]]) {
    for (let seq = 0; seq < expected.length; seq++) {
      const result = await f.room.handle(profiles[who], 'checkpoint', { seq });
      assert.equal(result.data.incoming, expected[seq], who + ' checkpoint ' + seq);
    }
  }
  assert.equal((await f.room.handle(profiles.bob, 'checkpoint', { seq: 5 })).data.code, 'invalid_sequence');
  const result = await f.api('bob', 'conversations/' + keyFor() + '/read', { seq: 2, incoming: 999,
    snapshot: { ownerId: profiles.bob.id, id: keyFor(), incoming: 999 } });
  assert.equal(result.status, 200);
  assert.equal(result.data.conversation.readIncoming, 1, 'router ignores forged counts and snapshots');
  assert.equal(result.data.conversation.unread, 1);
});

test('expired receive leases close passive sockets without delivering later account events', { timeout: 15000 }, async t => {
  // Test-only shortened lease in the disposable bundle; production retains five minutes.
  const bundle = await readFile('dist/chat.js', 'utf8');
  const script = bundle.replace(/var AUTH_LEASE_MS = [^;]+;/, 'var AUTH_LEASE_MS = 700;');
  assert.notEqual(script, bundle);
  const f = await fixture(t, {}, undefined, script); await f.initialize();
  const receiver = await f.connect('/api/dm/events?account=' + encodeURIComponent(profiles.bob.id), { type: 'auth', accessToken: 'bob' });
  await until(() => receiver.messages.some(message => message.type === 'dm:ready'));
  const closed = once(receiver.ws, 'close');
  await delay(800);
  await send(f, 'alice', 'After lease expiry');
  assert.equal((await closed)[0], 4001);
  assert.equal(receiver.messages.filter(message => message.type === 'dm:changed').length, 0);
});

test('a transaction failure rolls back message, state and delivery records together', async t => {
  const f = await fixture(t); await f.initialize();
  const storage = await f.storage('DirectRoom', keyFor());
  await until(async () => !(await storage.exec('SELECT * FROM dm_outbox')).length);
  await storage.exec("CREATE TRIGGER fail_dm_outbox BEFORE INSERT ON dm_outbox BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const failed = await send(f, 'alice', 'Must roll back');
  assert.equal(failed.status, 503);
  assert.equal((await storage.exec('SELECT * FROM dm_messages')).length, 0);
  const state = JSON.parse((await storage.exec('SELECT data FROM dm_meta'))[0].data);
  assert.equal(state.state, 'none'); assert.equal(state.lastSeq, 0);
  await storage.exec('DROP TRIGGER fail_dm_outbox');
  assert.equal((await send(f, 'alice', 'Retry after repair')).status, 200);
});

test('limits reject writes without deleting history and request quotas count distinct peers', async t => {
  const f = await fixture(t, { DM_MAX_BYTES: '270', DM_REQUESTS_HOUR: '1' }); await f.initialize();
  assert.equal((await send(f, 'alice', 'Too large for this configured quota')).data.code, 'conversation_full');
  assert.deepEqual((await f.room.handle(profiles.alice, 'history', {})).data.messages, []);
  assert.equal((await f.inbox('alice').handle(profiles.alice, 'reserve', { peerId: profiles.bob.id })).status, 200);
  assert.equal((await f.inbox('alice').handle(profiles.alice, 'reserve', { peerId: profiles.bob.id })).status, 200);
  assert.equal((await f.inbox('alice').handle(profiles.alice, 'reserve', { peerId: profiles.eve.id })).data.code, 'request_rate_limited');
  for (const data of [
    { text: 'x'.repeat(257) }, { text: 'file', kind: 'attachment' },
    { text: '../secret', kind: 'sticker' }, { text: 'hello', replyTo: 99 },
  ]) assert.equal((await f.room.handle(profiles.alice, 'send', { clientMessageId: crypto.randomUUID(), ...data })).status, 400);
});

test('deployment modes fail closed and read-only disallows creating a conversation', async t => {
  for (const mode of ['off', 'read-only']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { DM_MODE: mode });
      const config = await f.api(null, 'config');
      assert.equal(config.data.mode, mode);
      assert.equal((await f.room.handle(profiles.alice, 'initialize', {}, { id: keyFor(), peer: profiles.bob })).status, 503);
      if (mode === 'off') assert.equal((await f.api('alice', 'conversations')).data.code, 'dm_disabled');
    });
  }
});

test('switching an existing deployment to read-only or off preserves history and enforces the gate', { timeout: 45000 }, async t => {
  const prefix = join(tmpdir(), 'nightcord-dm-mode-');
  const persist = await mkdtemp(prefix);
  let f = await fixture(t, {}, persist); await f.initialize();
  await send(f, 'alice', 'Retained through maintenance');
  await f.room.handle(profiles.bob, 'accept', {});
  await until(async () => (await list(f, 'bob'))[0]?.state === 'accepted');
  await f.runtime.dispose();
  f = await fixture(t, { DM_MODE: 'read-only' }, persist);
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/messages')).data.messages[0].text, 'Retained through maintenance');
  assert.equal((await f.api('alice', 'conversations/' + keyFor() + '/messages', { text: 'No new writes', clientMessageId: crypto.randomUUID() })).data.code, 'dm_read_only');
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/hide', { hidden: true })).data.conversation.hidden, true);
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/read', { seq: 1 })).data.conversation.readSeq, 1);
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/refuse', { refuseIncoming: true })).status, 200);
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/accept', {})).data.code, 'dm_read_only');
  await f.runtime.dispose();
  f = await fixture(t, { DM_MODE: 'off' }, persist);
  assert.equal((await f.api('bob', 'conversations/' + keyFor() + '/messages')).data.code, 'dm_disabled');
  const storage = await f.storage('DirectRoom', keyFor());
  assert.equal((await storage.exec('SELECT * FROM dm_messages')).length, 1);
  await f.runtime.dispose();
  assert.ok(resolve(persist).startsWith(resolve(prefix)));
  await rm(persist, { recursive: true, force: true });
});
