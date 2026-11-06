/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
  const socket = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie, ...(options.ip ? { 'CF-Connecting-IP': options.ip } : {}) } });
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
      alice.send({ message: 'rate-limit-check' });
      await alice.waitFor((value) => value.error?.includes('rate-limited'));
      assert.ok(!bob.messages.some((value) => value.message === 'rate-limit-check'));
    }

    bob.socket.close(1000, 'Reconnect verification');
    await once(bob.socket, 'close');
    await alice.waitFor((value) => value.quit === 'verification-bob');
    // Let one shared-IP action refill before reconnecting to replay history.
    await delay(5500);
    const reconnected = await connect(room, 'verification-bob');
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
  const identity = await bootstrap();
  for (let i = 0; i < 6; i++) {
    const peer = await connect(`budget-${i}`, 'Same visitor', null, { cookie: identity.cookie, ip: `budget-ip-${i}` });
    peer.send({ message: `budget-message-${i}` });
    if (i < 5) await peer.waitFor(v => v.message === `budget-message-${i}`);
    else {
      await peer.waitFor(v => v.code === 'rate_limited');
      assert.ok(!peer.messages.some(v => v.message === `budget-message-${i}`));
    }
  }
});
