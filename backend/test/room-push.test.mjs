/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { generateVAPIDKeys } from 'web-push';
import ece from 'http_ece';
import { createRuntime } from './runtime.mjs';

const origin = 'https://nightcord.de5.net';
const prefs = { message: true, mention: true, reply: true, everyone: true, pausedUntil: 0 };
async function until(check) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail('Timed out');
}
async function fixture(t, managed = false, beforeSend) {
  let script = await readFile('dist/chat.js', 'utf8');
  for (const name of ['ChatRoom', 'ManagedRoom']) script = script.replace(new RegExp('(var ' + name + ' = class extends \\w+ \\{)'), `$1
    testAlarm() { return this.alarm(); }
    testEnqueue(sender, text, replyTo) { return this.ctx.storage.transaction(async () => {
      const added = this.roomPush.enqueue(sender, text, id => id === 10 ? 'sekai:bob' : undefined, replyTo);
      if (added) await this.roomPush.schedule(); return added;
    }); }
    testBudget(attempts) { const day = new Date().toISOString().slice(0,10);
      this.roomPush.budget = { day, attempts }; this.ctx.storage.sql.exec('INSERT INTO room_push_budget VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,attempts=excluded.attempts', day, attempts); }
  `);
  const vapid = generateVAPIDKeys(), sent = [];
  const runtime = createRuntime({}, { script, inspectDurableObjects: true,
    identities: { 'Bearer alice': 'alice', 'Bearer bob': 'bob' }, profiles: { alice: { name: 'Alice' }, bob: { name: 'Bob' } },
    bindings: { DM_MODE: 'on', ROOMS_MODE: 'on', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: origin },
    outboundService: async request => {
      sent.push({ url: request.url, body: Buffer.from(await request.arrayBuffer()) });
      await beforeSend?.();
      return new Response(null, { status: request.url.includes('retry') ? 503 : 201 });
    } });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const api = async (path, data, user = 'bob') => {
    const response = await fetch(base + '/api/' + path, { method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer ' + user, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, ...await response.json() };
  };
  let id = 'push-test';
  if (managed) {
    const db = await runtime.getD1Database('ROOM_DIRECTORY');
    await db.exec((await readFile('migrations/0001_rooms.sql', 'utf8')).replace(/\n/g, ' '));
    const created = await api('rooms', { name: 'Push test', description: '', discoverability: 'listed', joinPolicy: 'open', requestId: crypto.randomUUID() }, 'alice');
    assert.equal(created.status, 200); id = created.room.id;
    assert.equal((await api('rooms/' + id + '/join', {})).status, 200);
  }
  const ns = await runtime.getDurableObjectNamespace(managed ? 'MANAGED_ROOMS' : 'ROOMS'), room = ns.get(ns.idFromName(id));
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', managed ? 'ManagedRoom' : 'ChatRoom', { name: id });
  async function connect(user) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/' + (managed ? 'rooms/' : 'room/') + id + '/websocket',
      { headers: { Origin: origin, 'CF-Connecting-IP': crypto.randomUUID() } });
    const frames = []; ws.on('message', raw => frames.push(JSON.parse(String(raw)))); t.after(() => ws.terminate());
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', name: user, accessToken: user, requestId: crypto.randomUUID() }));
    const ready = await until(() => frames.find(frame => managed ? frame.type === 'ready' : frame.ready));
    return { ws, frames, user: ready.user };
  }
  const a = await connect('alice'), b = await connect('bob');
  const key = createECDH('prime256v1'); key.generateKeys(); const auth = randomBytes(16);
  const subscription = { endpoint: 'https://fcm.googleapis.com/test/device', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const subscribe = async (preferences = prefs) => {
    assert.equal((await api('push/subscribe', { subscription })).status, 200);
    const result = await api('push/room', { room: id, endpoint: subscription.endpoint, preferences });
    assert.equal(result.status, 200, JSON.stringify(result));
  };
  const settings = preferences => room.roomPushSettings(b.user, id, subscription.endpoint, preferences);
  const pending = () => storage.exec('SELECT * FROM room_push_pending');
  const drain = async () => { await storage.exec('UPDATE room_push_pending SET due=0'); await room.testAlarm(); };
  return { runtime, id, room, storage, api, a, b, subscription, subscribe, settings, pending, drain, sent, key, auth, managed };
}

for (const managed of [false, true]) test(`${managed ? 'managed' : 'legacy'} room sends offline encrypted push, coalesces bursts and retains cooldown`, async t => {
  const f = await fixture(t, managed);
  assert.equal((await f.storage.exec("SELECT name FROM sqlite_master WHERE name LIKE 'room_push_%'")).length, 0);
  await f.subscribe();
  f.b.ws.close(); await until(() => f.b.ws.readyState === WebSocket.CLOSED);
  const text = 'Message body stays private';
  f.a.ws.send(JSON.stringify(managed ? { type: 'send', requestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), text } : { message: text }));
  await until(async () => (await f.pending()).length === 1);
  const first = await f.pending();
  for (let i = 0; i < 30; i++) assert.equal(await f.room.testEnqueue('sekai:alice', 'burst ' + i), false);
  assert.deepEqual(await f.pending(), first, 'coalesced messages do not rewrite the pending record');
  await f.drain(); assert.equal(f.sent.length, 1);
  assert.deepEqual(JSON.parse(ece.decrypt(f.sent[0].body, { version: 'aes128gcm', privateKey: f.key, authSecret: f.auth })),
    { type: 'room', ownerId: 'sekai:bob', room: f.id });
  assert.equal((await f.pending()).length, 0);
  assert.equal(await f.room.testEnqueue('sekai:bob', 'own message'), false);
  assert.equal(await f.room.testEnqueue('sekai:alice', 'next burst'), true);
  assert.ok((await f.pending())[0].due >= Date.now() + 58000);
  assert.equal((await f.storage.exec('SELECT attempts FROM room_push_budget'))[0].attempts, 1);
});

test('room API checks membership, device ownership and preference types', async t => {
  const f = await fixture(t); await f.subscribe();
  assert.equal((await f.api('push/room', { room: f.id, endpoint: f.subscription.endpoint, preferences: prefs }, 'alice')).status, 400);
  assert.equal((await f.api('push/room', { room: 'never-joined', endpoint: f.subscription.endpoint, preferences: prefs })).status, 404);
  assert.equal((await f.api('push/room', { room: f.id, endpoint: f.subscription.endpoint, preferences: { ...prefs, message: 'yes' } })).status, 400);
});

test('classification shares code/token rules, replies and disabled categories never fall back to new messages', async t => {
  const f = await fixture(t); await f.subscribe({ ...prefs, message: false, reply: false, everyone: false });
  const at = '<$SEKAI:Mention:type=user;display=Bob:sekai:bob>';
  for (const text of ['ordinary', '`' + at + '`', '> ' + at, '<$SEKAI:Code::@Bob>', '<$SEKAI:Code:>\n@Bob\n<&SEKAI>', 'https://example.com/@Bob', '@Bobby']) {
    assert.equal(await f.room.testEnqueue('sekai:alice', text), false, text);
  }
  assert.equal(await f.room.testEnqueue('sekai:alice', at), true);
  await f.settings({ ...prefs, message: true, mention: false, reply: false, everyone: false });
  for (const text of [at, '[re:10|preview]', '<$SEKAI:Reply::10>', '@everyone']) assert.equal(await f.room.testEnqueue('sekai:alice', text), false, text);
  await f.settings({ ...prefs, message: false, mention: false, everyone: false });
  assert.equal(await f.room.testEnqueue('sekai:alice', '[re:10|preview]'), true);
  await f.settings({ ...prefs, pausedUntil: Number.MAX_SAFE_INTEGER });
  assert.equal(await f.room.testEnqueue('sekai:alice', at), false);
});

test('reading cancels pending pushes; leaving and device pause/unsubscribe are rechecked before sending', async t => {
  const f = await fixture(t); await f.subscribe();
  assert.equal(await f.room.testEnqueue('sekai:alice', 'before reading'), true);
  f.b.ws.send(JSON.stringify({ type: 'push:attention', device: createHash('sha256').update(f.subscription.endpoint).digest('hex'), viewing: true }));
  await until(async () => (await f.pending()).length === 0);
  assert.equal(await f.room.testEnqueue('sekai:alice', 'while reading'), false);
  f.b.ws.close(); await until(() => f.b.ws.readyState === WebSocket.CLOSED);
  assert.equal(await f.room.testEnqueue('sekai:alice', 'away'), true);
  await f.api('push/subscribe', { subscription: f.subscription, pausedUntil: Date.now() + 3600000 });
  await f.drain(); assert.equal(f.sent.length, 0); assert.equal((await f.pending()).length, 0);
  await f.room.testEnqueue('sekai:alice', 'another');
  await f.api('push/unsubscribe', { endpoint: f.subscription.endpoint });
  await f.drain(); assert.equal(f.sent.length, 0);
  assert.equal((await f.storage.exec('SELECT * FROM room_push_watch')).length, 0);
});

test('managed room access revocation cancels offline delivery', async t => {
  const f = await fixture(t, true); await f.subscribe();
  assert.equal(await f.room.testEnqueue('sekai:alice', 'before ban'), true);
  const result = await f.room.handle(f.a.user, 'ban', { accountId: f.b.user.id }); assert.equal(result.status, 200);
  await f.drain(); assert.equal(f.sent.length, 0); assert.equal((await f.pending()).length, 0);
});

test('daily budget bounds RPC and outbound attempts; retries stop after three attempts', async t => {
  const f = await fixture(t); f.subscription.endpoint += '-retry'; await f.subscribe();
  await f.room.testEnqueue('sekai:alice', 'retry');
  for (let i = 0; i < 3; i++) await f.drain();
  assert.equal(f.sent.length, 3); assert.equal((await f.pending()).length, 0);
  await f.room.testEnqueue('sekai:alice', 'last allowed'); await f.room.testBudget(499);
  await f.drain(); assert.equal(f.sent.length, 4);
  await f.drain(); assert.equal(f.sent.length, 4); assert.equal((await f.pending()).length, 0);
  assert.equal(await f.room.testEnqueue('sekai:alice', 'over budget'), false);
});

test('a queued preference change cancels a later device in an in-flight batch', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, false, () => waiting); await f.subscribe();
  const second = { ...f.subscription, endpoint: f.subscription.endpoint + '-second' };
  assert.equal((await f.api('push/subscribe', { subscription: second })).status, 200);
  assert.equal((await f.api('push/room', { room: f.id, endpoint: second.endpoint, preferences: prefs })).status, 200);
  await f.room.testEnqueue('sekai:alice', 'two devices');
  const draining = f.drain();
  try {
    await until(() => f.sent.length === 1);
    const other = f.sent[0].url === second.endpoint ? f.subscription.endpoint : second.endpoint;
    assert.equal((await f.room.roomPushSettings(f.b.user, f.id, other, { message: false, mention: false, reply: false, everyone: false, pausedUntil: 0 })).status, 200);
  } finally { release(); }
  await draining;
  assert.equal(f.sent.length, 1); assert.equal((await f.pending()).length, 0);
});
