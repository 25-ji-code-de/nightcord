/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test, { beforeEach, afterEach } from 'node:test';
import { createRuntime } from './runtime.mjs';
import WebSocket from 'ws';

let base = process.env.CHAT_BASE_URL;
let runtime;
const state = {};
const sockets = [];
const origin = 'https://nightcord.de5.net';
const apiFetch = (url, options = {}) => fetch(url, { ...options, headers: { Origin: origin, ...options.headers } });

async function bootstrap(cookie = '', ip = '') {
  const result = await apiFetch(`${base}/api/guest/session`, { method: 'POST', headers: { Cookie: cookie, ...(ip ? { 'CF-Connecting-IP': ip } : {}) } });
  assert.equal(result.status, 200);
  return { cookie: result.headers.get('set-cookie')?.split(';')[0] || cookie, ...await result.json() };
}

beforeEach(async () => {
  if (process.env.CHAT_BASE_URL) return;
  state.revoked = false;
  state.passCalls = 0;
  delete state.name;
  runtime = createRuntime(state);
  base = String(await runtime.ready).replace(/\/$/, '');
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await runtime?.dispose();
});

async function connect(room, name, firstFrame, options = {}) {
  const url = new URL(`/api/room/${room}/websocket`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const cookie = options.cookie || (!firstFrame?.accessToken ? (await bootstrap('', options.ip)).cookie : '');
  const socket = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie, ...(options.ip ? { 'CF-Connecting-IP': options.ip } : {}), ...options.headers } });
  sockets.push(socket);
  const messages = [];
  const watchers = new Set();
  socket.on('message', (raw) => {
    const value = JSON.parse(String(raw));
    messages.push(value);
    for (const watcher of watchers) watcher();
  });
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(new Error(`Timed out waiting for chat frame: ${JSON.stringify(messages)}`));
      }, 15_000);
      function check() {
        const value = messages.find(predicate);
        if (!value) return;
        clearTimeout(timer);
        watchers.delete(check);
        resolve(value);
      }
      watchers.add(check);
      check();
    });
  }
  await once(socket, 'open');
  socket.send(JSON.stringify(firstFrame || { name }));
  await waitFor((value) => value.ready);
  return { socket, messages, waitFor, cookie, send: (value) => socket.send(JSON.stringify(value)) };
}

test('chat protocol, private-room isolation, replay, validation, IP limiting, and reconnect', { timeout: 90_000 }, async () => {
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'nightcord-chat');
    const preflight = await apiFetch(`${base}/api/room`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal((await apiFetch(`${base}/api/room`)).status, 405);
    assert.equal((await apiFetch(`${base}/api/room/${'x'.repeat(33)}/websocket`)).status, 404);
    assert.equal((await apiFetch(`${base}/api/room/test/websocket`)).status, 426);

    const privateResponse = await apiFetch(`${base}/api/room`, { method: 'POST' });
    assert.equal(privateResponse.headers.get('access-control-allow-origin'), origin);
    const privateRoom = await privateResponse.text();
    assert.match(privateRoom, /^[0-9a-f]{64}$/);
    const anotherRoom = await (await apiFetch(`${base}/api/room`, { method: 'POST' })).text();
    assert.notEqual(privateRoom, anotherRoom);

    const room = `verify-${crypto.randomUUID().slice(0, 12)}`;
    const alice = await connect(room, 'verification-alice');
    const bob = await connect(room, 'verification-bob');
    const isolated = await connect(privateRoom, 'verification-private');
    await alice.waitFor((value) => value.joined === 'verification-bob');
    assert.ok(bob.messages.some((value) => value.joined === 'verification-alice'));

    const text = `chat-check-${crypto.randomUUID()}`;
    alice.send({ message: text });
    const echoed = await alice.waitFor((value) => value.message === text);
    const received = await bob.waitFor((value) => value.message === text);
    assert.equal(received.name, 'verification-alice');
    assert.equal(received.timestamp, echoed.timestamp);
    assert.ok(Number.isSafeInteger(received.timestamp));

    const privateText = `private-check-${crypto.randomUUID()}`;
    isolated.send({ message: privateText });
    await isolated.waitFor((value) => value.message === privateText);
    assert.ok(!isolated.messages.some((value) => value.message === text));
    assert.ok(!bob.messages.some((value) => value.message === privateText));

    alice.socket.send('{');
    await alice.waitFor((value) => value.error === 'Invalid JSON.');
    alice.send({ message: 'x'.repeat(257) });
    await alice.waitFor((value) => value.error?.includes('at most 256'));
    // Exact bucket exhaustion is deterministic locally; WAN latency may refill
    // a token between actions during production smoke tests.
    if (!process.env.CHAT_BASE_URL) {
      alice.send({ message: 'second guest message' });
      await alice.waitFor((value) => value.message === 'second guest message');
      alice.send({ message: 'rate-limit-check' });
      await alice.waitFor((value) => value.code === 'rate_limited');
      assert.ok(!bob.messages.some((value) => value.message === 'rate-limit-check'));
    }

    bob.socket.close(1000, 'Reconnect verification');
    await once(bob.socket, 'close');
    await alice.waitFor((value) => value.quit === 'verification-bob');
    // Let one shared-IP action refill before reconnecting to replay history.
    await delay(5500);
    const reconnected = await connect(room, 'verification-bob', null, { cookie: bob.cookie });
    assert.ok(reconnected.messages.some((value) => value.message === text && value.timestamp === received.timestamp));
    assert.ok(!reconnected.messages.some((value) => value.message === privateText));
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Verification complete');
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }
});

test('server verifies account identity, ignores forged claims, and preserves subjects across connections', { skip: !!process.env.CHAT_BASE_URL, timeout: 45_000 }, async () => {
  const room = `identity-${crypto.randomUUID().slice(0, 12)}`;
  const guest = await connect(room, 'Shared name', { name: 'Shared name', user: { id: 'sekai:stable-subject', authenticated: true } });
  const guestSession = guest.messages.find(value => value.type === 'session');
  assert.equal(guestSession.user.authenticated, false);
  assert.match(guestSession.user.id, /^guest:/);
  const alice = await connect(room, 'ignored', { name: 'Forged name', accessToken: 'local-test-token', user: { id: 'forged' } });
  const session = alice.messages.find(value => value.type === 'session');
  assert.equal(session.user.id, 'sekai:stable-subject');
  assert.equal(session.user.displayName, 'Shared name');
  assert.equal(session.user.username, 'unique-handle');
  assert.equal(session.user.bio, '<img onerror=alert(1)> signature');
  assert.equal(session.user.authenticated, true);
  assert.ok(session.authExpiresAt > Date.now());
  assert.notEqual(session.user.id, guestSession.user.id);
  const second = await connect(room, 'ignored', { accessToken: 'local-test-token' });
  assert.equal(second.messages.find(value => value.type === 'session').user.id, session.user.id);
  alice.send({ message: 'verified-message', name: 'Fake', user: guestSession.user });
  const entry = await guest.waitFor(value => value.message === 'verified-message');
  assert.equal(entry.user.id, session.user.id);
  assert.equal(entry.name, 'Shared name');
  assert.equal(JSON.stringify(entry).includes('local-test-token'), false);
  alice.socket.close(1000, 'close one tab');
  await once(alice.socket, 'close');
  await delay(100);
  assert.ok(!guest.messages.some(value => value.userId === session.user.id && value.quit));
  state.revoked = true;
  second.send({ type: 'auth', accessToken: 'local-test-token' });
  await second.waitFor(value => value.code === 'auth_invalid');
  await guest.waitFor(value => value.quit && value.userId === session.user.id);
});

test('room members retain verified Pass visitors without messages and exclude guests and other rooms', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const room = `members-${crypto.randomUUID().slice(0, 12)}`;
  const account = await connect(room, 'ignored', { accessToken: 'local-test-token', isMobile: true }, { ip: 'members-account' });
  const sameAccount = await connect(room, 'ignored', { accessToken: 'local-test-token' }, { ip: 'members-second-tab' });
  state.name = 'Latest member name';
  sameAccount.send({ type: 'auth', accessToken: 'local-test-token' });
  await sameAccount.waitFor(frame => frame.type === 'profile' && frame.user.displayName === state.name);
  account.socket.close(); sameAccount.socket.close();
  await Promise.all([once(account.socket, 'close'), once(sameAccount.socket, 'close')]);
  const visitor = await connect(room, 'Guest', undefined, { ip: 'members-visitor' });
  const members = (await visitor.waitFor(frame => frame.type === 'room:members')).users;
  assert.equal(members.length, 1);
  assert.equal(members[0].id, 'sekai:stable-subject');
  assert.equal(members[0].displayName, state.name);
  assert.equal(members[0].isMobile, false, 'offline members have no live device state');
  assert.equal(JSON.stringify(members).includes('local-test-token'), false);
  const otherRoom = await connect('members-other-room', 'Guest', undefined, { ip: 'members-other' });
  assert.deepEqual((await otherRoom.waitFor(frame => frame.type === 'room:members')).users, []);
  delete state.name;
});

test('existing rooms backfill the latest verified profiles once and retain members after history is removed', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  await runtime.dispose();
  runtime = createRuntime(state, { inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const room = `backfill-${crypto.randomUUID().slice(0, 12)}`;
  const seed = await connect(room, 'Seed', undefined, { ip: 'backfill-seed' });
  seed.socket.close(); await once(seed.socket, 'close');
  const [id] = await runtime.listDurableObjectIds('ROOMS');
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'ChatRoom', { id });
  await storage.exec('DROP TABLE room_members');
  const old = { id: 'sekai:past', displayName: 'Old name', authenticated: true };
  for (const profile of [old, { ...old, displayName: 'Latest name' }, { id: 'guest:past', displayName: 'Past guest', authenticated: false }]) {
    await storage.exec('INSERT INTO messages (name, message, timestamp, profile) VALUES (?, ?, ?, ?)', profile.displayName, 'History', Date.now(), JSON.stringify(profile));
  }
  await runtime.unsafeEvictDurableObject('nightcord-chat', 'ChatRoom', { id });
  const visitor = await connect(room, 'Visitor', undefined, { ip: 'backfill-visitor' });
  const members = (await visitor.waitFor(frame => frame.type === 'room:members')).users;
  assert.deepEqual(members.map(profile => [profile.id, profile.displayName]), [['sekai:past', 'Latest name']]);
  visitor.socket.close(); await once(visitor.socket, 'close');
  await storage.exec('DELETE FROM messages');
  await runtime.unsafeEvictDurableObject('nightcord-chat', 'ChatRoom', { id });
  const later = await connect(room, 'Later', undefined, { ip: 'backfill-later' });
  assert.deepEqual((await later.waitFor(frame => frame.type === 'room:members')).users, members);
});

test('visibility changes recheck authentication after waiting for the limiter', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  await runtime.dispose();
  let script = await readFile('dist/chat.js', 'utf8');
  const pattern = /var ChatRoom = class extends \w+ \{/;
  assert.match(script, pattern);
  script = script.replace(pattern, match => match + `
    testExpiresSoon() {
      for (const ws of this.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment(); s.authExpiresAt = Date.now() + 100; ws.serializeAttachment(s);
      }
    }
  `);
  assert.ok(script.includes('  check() {'));
  script = script.replace('  check() {', '  async check() { await new Promise(resolve => setTimeout(resolve, 350));');
  runtime = createRuntime(state, { script, inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const peer = await connect('visibility-expiry', '', { accessToken: 'local-test-token' });
  const ns = await runtime.getDurableObjectNamespace('ROOMS'), [id] = await runtime.listDurableObjectIds('ROOMS');
  await ns.get(ns.idFromString(id)).testExpiresSoon();
  peer.send({ type: 'room:visibility', visibility: 'hidden', requestId: 'expires-in-flight' });
  const result = await peer.waitFor(frame => frame.requestId === 'expires-in-flight');
  assert.equal(result.code, 'auth_required');
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'ChatRoom', { id });
  assert.equal((await storage.exec('SELECT * FROM room_visibility')).length, 0);
});

test('room visibility synchronizes tabs, filters live and offline lists, and preserves messaging and room isolation', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const room = `visibility-${crypto.randomUUID().slice(0, 12)}`;
  const observer = await connect(room, 'Observer', null, { ip: 'visibility-observer' });
  const account = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'visibility-account' });
  const tab = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'visibility-tab' });
  const id = account.messages.find(v => v.type === 'session').user.id;
  assert.equal(account.messages.find(v => v.type === 'session').visibility, 'online');
  const set = async (peer, visibility, requestId) => {
    peer.send({ type: 'room:visibility', visibility, requestId, userId: 'guest:forged-target' });
    return peer.waitFor(v => v.type === 'room:visibility' && v.requestId === requestId);
  };
  assert.equal((await set(account, 'offline', 'offline-1')).visibility, 'offline');
  await tab.waitFor(v => v.type === 'room:visibility' && v.visibility === 'offline');
  await observer.waitFor(v => v.quit && v.userId === id && v.silent);
  const offline = await observer.waitFor(v => v.type === 'room:members' && v.users.some(u => u.id === id));
  assert.equal(offline.users.find(u => u.id === id).isMobile, false);
  const mark = observer.messages.length;
  assert.equal((await set(tab, 'hidden', 'hidden-1')).visibility, 'hidden');
  await observer.waitFor(v => observer.messages.indexOf(v) >= mark && v.type === 'room:members' && !v.users.some(u => u.id === id));
  account.send({ message: 'Still chatting while hidden' });
  assert.equal((await observer.waitFor(v => v.message === 'Still chatting while hidden')).user.id, id);
  tab.send({ type: 'auth', accessToken: 'local-test-token' });
  await tab.waitFor(v => v.type === 'session' && v.visibility === 'hidden');
  assert.ok(!observer.messages.slice(mark).some(v => v.joined || v.quit || v.type === 'profile' || v.type === 'room:visibility'));
  const newcomer = await connect(room, 'Newcomer', null, { ip: 'visibility-newcomer' });
  assert.ok(!newcomer.messages.some(v => v.joined && v.user.id === id));
  assert.ok(!newcomer.messages.find(v => v.type === 'room:members').users.some(u => u.id === id));
  const otherRoom = await connect('visibility-other-room', '', { accessToken: 'local-test-token' }, { ip: 'visibility-other' });
  assert.equal(otherRoom.messages.find(v => v.type === 'session').visibility, 'online');
  assert.ok(otherRoom.messages.some(v => v.joined && v.user.id === id));
  const hiddenMark = observer.messages.length;
  account.socket.close(); tab.socket.close();
  await Promise.all([once(account.socket, 'close'), once(tab.socket, 'close')]);
  const reconnected = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'visibility-reconnected' });
  assert.equal(reconnected.messages.find(v => v.type === 'session').visibility, 'hidden');
  assert.ok(!observer.messages.slice(hiddenMark).some(v => v.userId === id || v.user?.id === id));
  assert.equal((await set(reconnected, 'online', 'online-1')).visibility, 'online');
  await observer.waitFor(v => v.joined && v.user.id === id && v.silent);
  reconnected.socket.close(); await once(reconnected.socket, 'close');
  await observer.waitFor(v => v.quit && v.userId === id && !v.silent);
});

test('guest visibility persists by cookie, does not affect another guest, and rejects invalid changes', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const room = 'visibility-guests';
  const guest = await connect(room, 'Guest', null, { ip: 'visibility-guest' });
  const id = guest.messages.find(v => v.type === 'session').user.id;
  guest.send({ type: 'room:visibility', visibility: 'invisible', requestId: 'bad' });
  assert.equal((await guest.waitFor(v => v.requestId === 'bad')).code, 'invalid_visibility');
  guest.send({ type: 'room:visibility', visibility: 'hidden', requestId: 'hide-guest' });
  await guest.waitFor(v => v.requestId === 'hide-guest' && v.visibility === 'hidden');
  guest.socket.close(); await once(guest.socket, 'close');
  const renamed = await connect(room, 'Renamed', null, { cookie: guest.cookie, ip: 'visibility-renamed' });
  assert.equal(renamed.messages.find(v => v.type === 'session').visibility, 'hidden');
  assert.equal(renamed.messages.find(v => v.type === 'session').user.id, id);
  const stranger = await connect(room, 'Renamed', null, { ip: 'visibility-stranger' });
  assert.equal(stranger.messages.find(v => v.type === 'session').visibility, 'online');
  assert.ok(!stranger.messages.some(v => v.joined && v.user.id === id));
  const otherRoom = await connect('visibility-guest-other', 'Renamed', null, { cookie: guest.cookie, ip: 'visibility-guest-other' });
  assert.equal(otherRoom.messages.find(v => v.type === 'session').visibility, 'online');
});

test('visibility survives Durable Object eviction and rejects unauthenticated or revoked clients', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  await runtime.dispose();
  runtime = createRuntime(state, { inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const room = 'visibility-persist';
  const account = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'visibility-persist-account' });
  account.send({ type: 'room:visibility', visibility: 'offline', requestId: 'persist' });
  await account.waitFor(v => v.requestId === 'persist' && v.visibility === 'offline');
  account.socket.close(); await once(account.socket, 'close');
  const [id] = await runtime.listDurableObjectIds('ROOMS');
  await runtime.unsafeEvictDurableObject('nightcord-chat', 'ChatRoom', { id });
  const observer = await connect(room, 'Observer', null, { ip: 'visibility-persist-observer' });
  const reconnected = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'visibility-persist-return' });
  assert.equal(reconnected.messages.find(v => v.type === 'session').visibility, 'offline');
  assert.ok(!observer.messages.some(v => v.joined && v.user.id === 'sekai:stable-subject'));
  assert.ok(observer.messages.find(v => v.type === 'room:members').users.some(u => u.id === 'sekai:stable-subject'));
  const url = new URL(`/api/room/${room}/websocket`, base); url.protocol = 'ws:';
  const socket = new WebSocket(url, { headers: { Origin: origin } }); sockets.push(socket);
  await once(socket, 'open');
  const reply = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'room:visibility', userId: 'sekai:stable-subject', visibility: 'hidden', requestId: 'forged' }));
  assert.equal(JSON.parse(String((await reply)[0])).code, 'auth_required');
  state.revoked = true;
  reconnected.send({ type: 'auth', accessToken: 'local-test-token' });
  await reconnected.waitFor(v => v.code === 'auth_invalid');
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'ChatRoom', { id });
  const stored = await storage.exec('SELECT visibility FROM room_visibility WHERE id = ?', 'sekai:stable-subject');
  assert.match(JSON.stringify(stored), /offline/);
});

test('invalid bearer token cannot receive history or claim an authenticated session', { timeout: 20_000 }, async () => {
  const url = new URL(`/api/room/reject-${crypto.randomUUID().slice(0, 12)}/websocket`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  sockets.push(socket);
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(String(raw))));
  await once(socket, 'open');
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ accessToken: 'invalid-token', name: 'Imposter', authenticated: true }));
  const [code] = await closed;
  assert.equal(code, 4001);
  assert.ok(messages.some(value => value.code === 'auth_invalid'));
  assert.ok(!messages.some(value => value.ready || value.type === 'session' || value.message));
});

test('mobile hints support browsers, native clients and old clients for guest and Pass sessions', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const devices = [
    [{}, {}, false],
    [{ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, { isMobile: 'true' }, false],
    [{ 'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile' }, { isMobile: false }, true],
    [{ 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, {}, true],
    [{ 'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }, {}, true],
    [{ 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 15)' }, {}, true],
    [{ 'User-Agent': 'Reduced browser UA', 'Sec-CH-UA-Mobile': '?1' }, {}, true],
    [{ 'User-Agent': 'okhttp/4.12.0' }, { isMobile: true }, true],
  ];
  for (const [index, [headers, hint, expected]] of devices.entries()) {
    for (const authenticated of [false, true]) {
      const frame = { ...(authenticated ? { accessToken: 'local-test-token' } : { name: 'Visitor' }), ...hint };
      const peer = await connect(`device-${index}-${authenticated}`, 'Visitor', frame, { headers, ip: `device-${index}-${authenticated}` });
      for (const value of peer.messages.filter(v => v.type === 'session' || v.ready || v.joined)) {
        assert.equal(value.user.isMobile, expected, JSON.stringify({ headers, hint, authenticated }));
      }
    }
  }
});

test('mobile account metadata survives refresh, aggregates presence and stays specific to the sender', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const room = `mobile-${crypto.randomUUID().slice(0, 12)}`;
  const desktop = await connect(room, 'ignored', { accessToken: 'local-test-token' }, { ip: 'mobile-desktop' });
  assert.equal(desktop.messages.find(v => v.type === 'session').user.isMobile, false);
  const mobile = await connect(room, 'ignored', { accessToken: 'local-test-token', isMobile: true }, { ip: 'mobile-native', headers: { 'User-Agent': 'okhttp/4.12.0' } });
  const initialSession = mobile.messages.find(v => v.type === 'session');
  assert.equal(initialSession.user.isMobile, true);
  await desktop.waitFor(v => v.type === 'profile' && v.user.isMobile === true);
  mobile.send({ type: 'auth', accessToken: 'local-test-token', isMobile: false });
  await mobile.waitFor(v => v.type === 'session' && v.user.isMobile && v !== initialSession);
  desktop.send({ message: 'from desktop', isMobile: true });
  assert.equal((await mobile.waitFor(v => v.message === 'from desktop')).user.isMobile, false);
  mobile.send({ message: 'from mobile', isMobile: false });
  assert.equal((await desktop.waitFor(v => v.message === 'from mobile')).user.isMobile, true);
  const observer = await connect(room, 'Observer', null, { ip: 'mobile-observer' });
  assert.equal(observer.messages.find(v => v.joined === 'Shared name').user.isMobile, true);
  assert.equal(observer.messages.find(v => v.message === 'from mobile').user.isMobile, true);
  assert.equal(observer.messages.find(v => v.message === 'from desktop').user.isMobile, false);
  mobile.socket.close(1000, 'mobile disconnected');
  await once(mobile.socket, 'close');
  await observer.waitFor(v => v.type === 'profile' && v.user.id === 'sekai:stable-subject' && v.user.isMobile === false);
  assert.ok(!observer.messages.some(v => v.quit && v.userId === 'sekai:stable-subject'));
  const beforeReconnect = observer.messages.length;
  const reconnected = await connect(room, 'ignored', { accessToken: 'local-test-token', isMobile: true }, { ip: 'mobile-reconnected' });
  assert.equal(reconnected.messages.find(v => v.type === 'session').user.isMobile, true);
  await observer.waitFor(v => v.type === 'profile' && v.user.isMobile === true && observer.messages.indexOf(v) >= beforeReconnect);
});

test('guest rename preserves device flags across mixed-device connections', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const identity = await bootstrap('', 'mobile-guest-bootstrap');
  const room = `mobile-guest-${crypto.randomUUID().slice(0, 12)}`;
  const mobile = await connect(room, 'Original', null, { cookie: identity.cookie, ip: 'mobile-guest', headers: { 'User-Agent': 'Android 15' } });
  const firstMessageAt = Date.now();
  mobile.send({ message: 'before rename' });
  await mobile.waitFor(v => v.message === 'before rename');
  const observer = await connect(room, 'Observer', null, { ip: 'mobile-guest-observer' });
  const desktop = await connect(room, 'Renamed', null, { cookie: identity.cookie, ip: 'desktop-guest' });
  assert.equal(desktop.messages.find(v => v.type === 'session').user.isMobile, false);
  assert.equal((await mobile.waitFor(v => v.type === 'session' && v.user.displayName === 'Renamed')).user.isMobile, true);
  assert.equal((await observer.waitFor(v => v.type === 'profile' && v.user.displayName === 'Renamed')).user.isMobile, true);
  desktop.send({ message: 'guest desktop' });
  assert.equal((await mobile.waitFor(v => v.message === 'guest desktop')).user.isMobile, false);
  // The two tabs share a guest identity and its two-message burst allowance.
  await delay(Math.max(0, firstMessageAt + 10100 - Date.now()));
  mobile.send({ message: 'guest mobile' });
  assert.equal((await desktop.waitFor(v => v.message === 'guest mobile')).user.isMobile, true);
  assert.equal(desktop.messages.find(v => v.message === 'before rename').user.isMobile, true);
  mobile.socket.close(1000, 'mobile guest disconnected');
  await once(mobile.socket, 'close');
  await observer.waitFor(v => v.type === 'profile' && v.user.id === identity.id && v.user.isMobile === false);
});

test('guest credential survives rename, tabs, rooms and Pass login without rewriting historical identity', { skip: !!process.env.CHAT_BASE_URL, timeout: 30_000 }, async () => {
  const identity = await bootstrap('', 'bootstrap-stable');
  const room = `stable-${crypto.randomUUID().slice(0, 12)}`;
  const first = await connect(room, 'Original visitor', null, { cookie: identity.cookie, ip: 'stable-first' });
  assert.equal(first.messages.find(v => v.type === 'session').user.id, identity.id);
  first.send({ message: 'original guest message' });
  await first.waitFor(v => v.message === 'original guest message');
  const renamed = await connect(room, 'Renamed visitor', null, { cookie: identity.cookie, ip: 'stable-second' });
  await first.waitFor(v => v.type === 'session' && v.user.displayName === 'Renamed visitor');
  first.send({ message: 'after rename' });
  const updated = await renamed.waitFor(v => v.message === 'after rename');
  assert.equal(updated.name, 'Renamed visitor');
  assert.equal(updated.user.id, identity.id);
  const old = renamed.messages.find(v => v.message === 'original guest message');
  assert.equal(old.name, 'Original visitor');
  assert.equal(old.user.authenticated, false);
  const otherRoom = await connect(`other-${crypto.randomUUID().slice(0, 12)}`, 'Renamed visitor', null, { cookie: identity.cookie, ip: 'stable-room' });
  assert.equal(otherRoom.messages.find(v => v.type === 'session').user.id, identity.id);
  const otherPerson = await connect(room, 'Renamed visitor', null, { ip: 'stable-stranger' });
  assert.notEqual(otherPerson.messages.find(v => v.type === 'session').user.id, identity.id);
  const account = await connect(room, 'ignored', { accessToken: 'local-test-token' }, { cookie: identity.cookie, ip: 'stable-account' });
  assert.equal(account.messages.find(v => v.type === 'session').user.id, 'sekai:stable-subject');
  assert.equal(account.messages.find(v => v.message === 'original guest message').user.authenticated, false);
  first.socket.close();
  await once(first.socket, 'close');
  await delay(30);
  assert.ok(!otherPerson.messages.some(v => v.quit && v.userId === identity.id));
  renamed.socket.close();
  await once(renamed.socket, 'close');
  await otherPerson.waitFor(v => v.quit && v.userId === identity.id);
  const restored = await connect(room, 'Renamed visitor', null, { cookie: identity.cookie, ip: 'stable-restored' });
  assert.equal(restored.messages.find(v => v.type === 'session').user.id, identity.id);
});

test('missing or forged guest cookies cannot claim IDs or receive room history', { skip: !!process.env.CHAT_BASE_URL, timeout: 25_000 }, async () => {
  const identity = await bootstrap('', 'reject-bootstrap');
  for (const [index, cookie] of ['', identity.cookie.replace(/.$/, c => c === 'a' ? 'b' : 'a')].entries()) {
    const url = new URL('/api/room/guest-rejection/websocket', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie, 'CF-Connecting-IP': `reject-${index}`, 'X-Guest-Id': identity.id } });
    sockets.push(socket);
    const messages = [];
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ name: 'Imposter', id: identity.id, user: { id: identity.id, authenticated: true } }));
    assert.equal((await closed)[0], 4002);
    assert.ok(messages.some(v => v.code === 'guest_session_required'));
    assert.ok(!messages.some(v => v.ready || v.user || v.message || v.joined));
  }
});

test('foreign origins cannot initialize cookies or open cookie-bearing WebSockets', { skip: !!process.env.CHAT_BASE_URL, timeout: 20_000 }, async () => {
  for (const denied of ['', 'null', 'https://evil.example', 'https://evil.nightcord.de5.net']) {
    const res = await fetch(`${base}/api/guest/session`, { method: 'POST', headers: denied ? { Origin: denied } : {} });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  const identity = await bootstrap();
  const url = new URL('/api/room/origin-rejection/websocket', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { Origin: 'https://evil.example', Cookie: identity.cookie } });
  sockets.push(socket);
  socket.on('error', () => {});
  const [, res] = await once(socket, 'unexpected-response');
  assert.equal(res.statusCode, 403);
  res.resume();
  socket.terminate();
});

test('reconnects and different rooms cannot reset a guest ID message budget', { skip: !!process.env.CHAT_BASE_URL, timeout: 25_000 }, async () => {
  await runtime.dispose();
  runtime = createRuntime(state, { inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const identity = await bootstrap();
  for (let i = 0; i < 3; i++) {
    if (i === 2) await runtime.unsafeEvictDurableObject('nightcord-chat', 'RateLimiter', { name: `user:${identity.id}` });
    const peer = await connect(`budget-${i}`, 'Same visitor', null, { cookie: identity.cookie, ip: `budget-ip-${i}` });
    peer.send({ message: `budget-message-${i}` });
    if (i < 2) await peer.waitFor(v => v.message === `budget-message-${i}`);
    else {
      const limit = await peer.waitFor(v => v.code === 'rate_limited');
      assert.ok(limit.retryAfter > 0 && limit.retryAfter <= 10);
      assert.ok(!peer.messages.some(v => v.message === `budget-message-${i}`));
    }
  }
});

test('new guest identities are limited atomically while a valid cookie can still be reused', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  const ip = 'identity-budget';
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => apiFetch(`${base}/api/guest/session`, {
    method: 'POST', headers: { 'CF-Connecting-IP': ip, 'X-Forwarded-For': `forged-${i}` },
  })));
  assert.equal(responses.filter(r => r.status === 200).length, 3);
  for (const limited of responses.filter(r => r.status !== 200)) {
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.code, 'rate_limited');
    assert.ok(body.retryAfter > 0 && body.retryAfter <= 60);
    assert.equal(limited.headers.get('retry-after'), String(body.retryAfter));
    assert.equal(limited.headers.get('set-cookie'), null);
  }
  const issued = responses.find(r => r.status === 200);
  const cookie = issued.headers.get('set-cookie').split(';')[0];
  assert.equal((await bootstrap(cookie, ip)).id, (await issued.json()).id);
  for (let i = 0; i < 5; i++) await bootstrap(cookie, ip);
  const exhausted = await apiFetch(`${base}/api/guest/session`, { method: 'POST', headers: { Cookie: cookie, 'CF-Connecting-IP': ip } });
  assert.equal(exhausted.status, 429, 'valid-cookie requests also have a bounded budget');
  await bootstrap('', 'another-network');
});

test('legacy anonymous room creation has a separate IP budget', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  const headers = { 'CF-Connecting-IP': 'room-create-budget' };
  const results = await Promise.all(Array.from({ length: 3 }, () => apiFetch(`${base}/api/room`, { method: 'POST', headers })));
  assert.equal(results.filter(r => r.status === 200).length, 2);
  const denied = results.find(r => r.status === 429);
  assert.ok(denied); assert.ok(Number(denied.headers.get('retry-after')) > 0);
  assert.equal((await apiFetch(`${base}/api/room`, { method: 'OPTIONS', headers })).status, 204);
});

test('guest IP budgets survive switching cookies without consuming verified account message limits', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  const ip = 'shared-guest-network';
  for (let i = 0; i < 3; i++) {
    const guest = await connect('guest-ip-budget', `Guest ${i}`, null, { ip });
    for (let j = 0; j < 2; j++) {
      const message = `guest-${i}-${j}`;
      guest.send({ message, user: { authenticated: true, id: 'sekai:forged' } });
      if (i < 2) await guest.waitFor(v => v.message === message);
      else {
        await guest.waitFor(v => v.code === 'rate_limited');
        assert.ok(!guest.messages.some(v => v.message === message));
      }
    }
  }
  const account = await connect('guest-ip-budget', '', { accessToken: 'local-test-token' }, { ip });
  for (let i = 0; i < 5; i++) {
    account.send({ message: `verified-${i}` });
    await account.waitFor(v => v.message === `verified-${i}` && v.user.authenticated);
  }
});

test('connection floods are rejected before creating another room and limits survive eviction', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  await runtime.dispose(); runtime = createRuntime(state, { inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const headers = { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': 'upgrade-budget' };
  for (let i = 0; i < 20; i++) {
    const result = await runtime.dispatchFetch(`${base}/api/room/connection-source/websocket`, { headers });
    assert.equal(result.status, 101);
    result.webSocket.accept(); result.webSocket.close(1000);
  }
  assert.equal((await runtime.listDurableObjectIds('ROOMS')).length, 1);
  await runtime.unsafeEvictDurableObject('nightcord-chat', 'RateLimiter', { name: 'connect:upgrade-budget' });
  const denied = await runtime.dispatchFetch(`${base}/api/room/never-created/websocket`, { headers });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('retry-after')) > 0);
  assert.equal((await runtime.listDurableObjectIds('ROOMS')).length, 1);
  assert.equal(state.passCalls || 0, 0);
});

test('guest join budgets follow the signed identity across IPs, nicknames and rooms', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  const identity = await bootstrap('', 'join-bootstrap');
  for (let i = 0; i < 6; i++) await connect(`join-${i}`, `Guest ${i}`, null, { cookie: identity.cookie, ip: `join-${i}` });
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/room/join-7/websocket`, {
    headers: { Origin: origin, Cookie: identity.cookie, 'CF-Connecting-IP': 'join-7' },
  });
  sockets.push(socket);
  const messages = []; socket.on('message', raw => messages.push(JSON.parse(String(raw))));
  await once(socket, 'open'); const closed = once(socket, 'close');
  socket.send(JSON.stringify({ name: 'Another nickname', user: { authenticated: true, id: 'sekai:fake' } }));
  assert.equal((await closed)[0], 1013);
  assert.ok(messages.some(v => v.code === 'rate_limited' && v.retryAfter > 0));
  assert.ok(!messages.some(v => v.ready || v.message || v.joined || v.type === 'session'));
});

test('guests that ignore message cooldowns are disconnected without more limiter calls', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  await runtime.dispose(); runtime = createRuntime(state, { inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const guest = await connect('cooldown-test', 'Guest', null, { ip: 'cooldown-ip' });
  for (let i = 0; i < 2; i++) { guest.send({ message: `allowed-${i}` }); await guest.waitFor(v => v.message === `allowed-${i}`); }
  guest.send({ message: 'denied' });
  const rejected = await guest.waitFor(v => v.code === 'rate_limited');
  assert.equal(rejected.reconnectAfter, undefined, 'a message cooldown allows the guest to keep reading');
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'RateLimiter', { name: 'ip:cooldown-ip' });
  const rows = await storage.exec('SELECT * FROM rate_windows ORDER BY policy');
  const closed = once(guest.socket, 'close');
  for (let i = 0; i < 3; i++) guest.send({ message: `ignore-cooldown-${i}` });
  assert.equal((await closed)[0], 1013);
  assert.ok(guest.messages.some(v => v.reconnectAfter > 0));
  assert.deepEqual(await storage.exec('SELECT * FROM rate_windows ORDER BY policy'), rows);
  assert.ok(!guest.messages.some(v => v.message?.startsWith('ignore-cooldown')));
});

test('malformed guest frames cannot bypass the per-connection flood limit', { skip: !!process.env.CHAT_BASE_URL }, async () => {
  const guest = await connect('malformed-flood', 'Guest');
  const closed = once(guest.socket, 'close');
  for (let i = 0; i < 25; i++) guest.socket.send('{');
  assert.equal((await closed)[0], 1013);
  assert.ok(guest.messages.some(v => v.code === 'rate_limited'));
  assert.ok(guest.messages.filter(v => v.error === 'Invalid JSON.').length <= 19);
});

test('personal repeats survive renamed tabs and hibernation; retries never create extra messages', { skip: !!process.env.CHAT_BASE_URL, timeout: 30000 }, async () => {
  await runtime.dispose();
  runtime = createRuntime(state, { inspectDurableObjects: true });
  base = String(await runtime.ready).replace(/\/$/, '');
  const room = 'repeat-check';
  const alice = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'repeat-alice' });
  const id = crypto.randomUUID();
  alice.send({ message: '6767', clientMessageId: id });
  const first = await alice.waitFor(value => value.message === '6767');
  const receipt = once(alice.socket, 'message');
  alice.send({ message: '6767', clientMessageId: id });
  assert.equal(JSON.parse(String((await receipt)[0])).timestamp, first.timestamp);
  alice.send({ message: 'different text', clientMessageId: id });
  await alice.waitFor(value => value.code === 'message_id_conflict');
  state.name = 'Renamed';
  const tab = await connect(room, '', { accessToken: 'local-test-token' }, { ip: 'repeat-tab' });
  tab.send({ message: '⑥⑦！', clientMessageId: crypto.randomUUID() });
  await tab.waitFor(value => value.message === '⑥⑦！');
  const [roomId] = await runtime.listDurableObjectIds('ROOMS');
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'ChatRoom', { id: roomId });
  assert.equal((await storage.exec('SELECT id FROM messages')).length, 2);
  await runtime.unsafeEvictDurableObject('nightcord-chat', 'ChatRoom', { id: roomId });
  tab.send({ message: '6...7', clientMessageId: crypto.randomUUID() });
  const denied = await tab.waitFor(value => value.code === 'message_repeated');
  assert.ok(denied.retryAfter > 0 && denied.retryAfter <= 60);
  assert.equal((await storage.exec('SELECT id FROM messages')).length, 2);
  assert.equal((await storage.exec('SELECT id FROM chat_moderation')).length, 2);
  const other = await connect(room, 'Other', undefined, { ip: 'repeat-other' });
  other.send({ message: '67' });
  await other.waitFor(value => value.message === '67');
  // Expiring the recorded window makes the same content eligible again.
  await storage.exec('UPDATE chat_moderation SET timestamp=?', Date.now() - 60001);
  tab.send({ message: '676767', clientMessageId: crypto.randomUUID() });
  await tab.waitFor(value => value.message === '676767');
});

test('group-repeat metadata starts at eight messages from four identities', { skip: !!process.env.CHAT_BASE_URL, timeout: 30000 }, async () => {
  const peers = [];
  for (let i = 0; i < 4; i++) peers.push(await connect('repeat-group', `Same name`, undefined, { ip: `repeat-group-${i}` }));
  for (let i = 0; i < 8; i++) {
    const peer = peers[Math.floor(i / 2)], message = '67'.repeat(i + 1);
    peer.send({ message, clientMessageId: crypto.randomUUID() });
    const entry = await peer.waitFor(value => value.message === message);
    assert.equal(entry.repeated === true, i === 7);
  }
});
