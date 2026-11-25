/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateVAPIDKeys } from 'web-push';
import ece from 'http_ece';
import { createRuntime } from './runtime.mjs';

const origin = 'https://nightcord.de5.net';
const profile = name => ({ id: 'sekai:' + name, sub: name, issuer: 'https://id.nightcord.de5.net', authenticated: true,
  displayName: name, username: name, avatarUrl: null, bio: '', isMobile: false });
const alice = profile('alice'), bob = profile('bob');
const conversation = 'a'.repeat(64);
function device(name = 'device') {
  const key = createECDH('prime256v1'); key.generateKeys();
  const auth = randomBytes(16);
  return { key, auth, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + name,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
async function until(check) {
  const end = Date.now() + 12000;
  do { if (await check()) return; await delay(30); } while (Date.now() < end);
  assert.fail('Timed out');
}
async function setup(t, enabled = true, options = {}) {
  const vapid = generateVAPIDKeys(), sent = [];
  const runtime = createRuntime({}, { inspectDurableObjects: true, identities: { 'Bearer alice': 'alice', 'Bearer bob': 'bob' },
    bindings: { DM_MODE: 'on', ...(enabled ? { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: origin } : {}) },
    ...options,
    outboundService: async request => {
      sent.push({ url: request.url, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
      return new Response(null, { status: request.url.includes('expired') ? 410 : request.url.includes('retry') ? 503 : 201 });
    } });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const namespace = await runtime.getDurableObjectNamespace('DM_INBOXES');
  const inbox = namespace.get(namespace.idFromName(bob.id));
  const api = (path, data, token = 'bob', requestOrigin = origin) => fetch(base + '/api/push/' + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const storage = () => runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'UserInbox', { name: bob.id });
  const snapshot = (n, extra = {}) => ({ id: conversation, ownerId: bob.id, peer: alice, version: n,
    state: 'accepted', initiator: alice.id, refuseIncoming: false, lastSeq: n, incoming: n, updatedAt: Date.now(), lastSenderId: alice.id, ...extra });
  return { runtime, api, inbox, storage, snapshot, sent, vapid };
}

test('push requires origin, authentication, configuration and browser service endpoints', async t => {
  const f = await setup(t, false);
  assert.deepEqual(await (await f.api('config')).json(), { enabled: false, publicKey: null });
  assert.equal((await f.api('subscribe', {}, 'invalid')).status, 401);
  assert.equal((await f.api('subscribe', {}, 'bob', 'https://evil.example')).status, 403);
  assert.equal((await f.api('subscribe', { subscription: device().subscription })).status, 503);
  assert.equal((await f.api('unsubscribe', { endpoint: device().subscription.endpoint })).status, 200);
  const unconfiguredStorage = await f.storage();
  assert.equal((await unconfiguredStorage.exec("SELECT name FROM sqlite_master WHERE name LIKE 'push_%'")).length, 0);
  const on = await setup(t);
  const config = await on.api('config');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await config.json()).publicKey, on.vapid.publicKey);
  for (const endpoint of ['http://localhost/admin', 'https://fcm.googleapis.com.evil.example/push', 'https://user@fcm.googleapis.com/push', 'https://fcm.googleapis.com:8443/push']) {
    assert.equal((await on.api('subscribe', { subscription: { ...device().subscription, endpoint } })).status, 400);
  }
  const invalid = device().subscription; invalid.keys.p256dh = 'x'.repeat(87);
  assert.equal((await on.api('subscribe', { subscription: invalid })).status, 400);
});

test('an alarm write failure rolls back the inbox and push task, then redelivery recovers', async t => {
  const bundle = await readFile('dist/chat.js', 'utf8');
  const script = bundle.replace(/var UserInbox = class extends (\w+) \{/,
    'var UserInbox = class extends $1 { testFailAlarm() { this.failNextAlarm = true; } async testApply(snapshot) { try { await this.apply(snapshot); return "ok"; } catch (error) { return error.message; } }')
    .replace('await this.ctx.storage.setAlarm(next);',
      'if (this.failNextAlarm) { this.failNextAlarm = false; throw new Error("test alarm failure"); } else await this.ctx.storage.setAlarm(next);');
  assert.notEqual(script, bundle);
  const f = await setup(t, true, { script });
  await f.api('subscribe', { subscription: device().subscription });
  await f.inbox.testFailAlarm();
  assert.equal(await f.inbox.testApply(f.snapshot(1)), 'test alarm failure');
  const storage = await f.storage();
  assert.equal((await storage.exec('SELECT * FROM dm_conversations')).length, 0);
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 0);
  await f.inbox.apply(f.snapshot(1));
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 1);
  await until(() => f.sent.length === 1);
});

test('DM delivery produces decryptable aes128gcm with valid VAPID, coalesces and ignores replay', async t => {
  const f = await setup(t), d = device();
  assert.equal((await f.api('subscribe', { subscription: d.subscription })).status, 200);
  const rooms = await f.runtime.getDurableObjectNamespace('DM_ROOMS');
  const room = rooms.get(rooms.idFromName(conversation));
  assert.equal((await room.handle(alice, 'initialize', {}, { id: conversation, peer: bob })).status, 200);
  assert.equal((await room.handle(alice, 'send', { text: 'Private body must not be exposed', clientMessageId: crypto.randomUUID() })).status, 200);
  await until(() => f.sent.length === 1);
  const request = f.sent[0];
  assert.equal(request.headers['content-encoding'], 'aes128gcm');
  const payload = JSON.parse(ece.decrypt(request.body, { version: 'aes128gcm', privateKey: d.key, authSecret: d.auth }));
  assert.deepEqual(payload, { type: 'dm', ownerId: bob.id, conversation });
  assert.ok(!request.body.includes(Buffer.from('Private body')));
  const jwt = /t=([^, ]+)/.exec(request.headers.authorization)[1], parts = jwt.split('.');
  const pub = Buffer.from(f.vapid.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
  assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).aud, 'https://fcm.googleapis.com');
  await f.inbox.apply(f.snapshot(10)); await f.inbox.apply(f.snapshot(11)); await f.inbox.apply(f.snapshot(11));
  const storage = await f.storage();
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 1);
  await until(() => f.sent.length === 2);
  await f.inbox.apply(f.snapshot(11));
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 0);
});

test('read, hidden, refused, paused, account isolation and unsubscribe cancel delivery', async t => {
  const f = await setup(t), d = device();
  await f.api('subscribe', { subscription: d.subscription });
  const storage = await f.storage();
  const count = async () => (await storage.exec('SELECT * FROM push_outbox')).length;
  await f.inbox.apply(f.snapshot(1)); assert.equal(await count(), 1);
  await f.inbox.handle(bob, 'read', { id: conversation, seq: 1, incoming: 1 }); assert.equal(await count(), 0);
  await f.inbox.apply(f.snapshot(2));
  await f.inbox.handle(bob, 'hide', { id: conversation, hidden: true }); assert.equal(await count(), 0);
  await f.inbox.apply(f.snapshot(3)); assert.equal(await count(), 0);
  await f.inbox.handle(bob, 'hide', { id: conversation, hidden: false });
  await f.inbox.apply(f.snapshot(4, { refuseIncoming: true })); assert.equal(await count(), 0);
  await f.api('subscribe', { subscription: d.subscription, pausedUntil: Date.now() + 3600000 });
  await f.inbox.apply(f.snapshot(5)); assert.equal(await count(), 0);
  await f.api('subscribe', { subscription: d.subscription });
  await f.inbox.apply(f.snapshot(6)); assert.equal(await count(), 1);
  await f.api('unsubscribe', { endpoint: d.subscription.endpoint }, 'alice');
  assert.equal(await count(), 1, 'another account cannot delete a subscription');
  await f.api('unsubscribe', { endpoint: d.subscription.endpoint }); assert.equal(await count(), 0);
  assert.equal((await storage.exec('SELECT * FROM push_devices')).length, 0);
});

test('expired subscriptions are removed and transient failures retain bounded retries', async t => {
  const f = await setup(t);
  await f.api('subscribe', { subscription: device('expired').subscription });
  await f.api('subscribe', { subscription: device('retry').subscription });
  await f.inbox.apply(f.snapshot(1));
  const storage = await f.storage();
  await until(async () => (await storage.exec('SELECT * FROM push_outbox WHERE attempts=1')).length === 1);
  assert.equal(f.sent.length, 2);
  assert.equal((await storage.exec('SELECT * FROM push_devices')).length, 1);
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 1);
});

test('disabling push on an existing deployment discards queued notifications without deleting conversations', async t => {
  const prefix = join(tmpdir(), 'nightcord-push-review-'), persistencePath = await mkdtemp(prefix);
  let f = await setup(t, true, { persistencePath });
  await f.api('subscribe', { subscription: device().subscription });
  await f.inbox.apply(f.snapshot(1));
  let storage = await f.storage();
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 1);
  await f.runtime.dispose();
  f = await setup(t, false, { persistencePath });
  await f.inbox.handle(bob, 'list', {});
  storage = await f.storage();
  assert.equal((await storage.exec('SELECT * FROM push_outbox')).length, 0);
  assert.equal((await storage.exec('SELECT * FROM dm_conversations')).length, 1);
  assert.equal(f.sent.length, 0);
  await f.runtime.dispose();
  assert.ok(resolve(persistencePath).startsWith(resolve(prefix)));
  await rm(persistencePath, { recursive: true, force: true });
});
