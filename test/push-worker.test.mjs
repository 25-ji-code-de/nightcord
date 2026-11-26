/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function worker() {
  const handlers = {}, cache = new Map(), notices = [], opened = [], posted = [];
  let windows = [], focused = 0;
  const storage = { match: async key => cache.get(key)?.clone(), put: async (key, value) => cache.set(key, value), delete: async key => cache.delete(key) };
  const self = { location: { origin: 'https://nightcord.de5.net' }, addEventListener: (key, fn) => { handlers[key] = fn; },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url) },
    registration: { showNotification: async (title, options) => notices.push({ title, ...options }), getNotifications: async () => [] }, navigator: {} };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), {
    self, URL, Response, Set, Date, console, MessageChannel, setTimeout, clearTimeout, caches: { open: async () => storage },
  });
  const emit = async (name, data) => { const tasks = []; handlers[name]({ ...data, waitUntil: promise => tasks.push(promise) }); await Promise.all(tasks); };
  return { notices, opened, posted, emit,
    state: state => emit('message', { data: { type: 'PUSH_STATE', state }, source: { url: self.location.origin + '/' }, ports: [{ postMessage: value => assert.equal(value.ok, true) }] }),
    push: payload => emit('push', { data: { json: () => payload } }),
    window: (visible, acknowledge = true) => { windows = [{ url: self.location.origin + '/', visibilityState: visible ? 'visible' : 'hidden', focused: visible,
      postMessage: (message, ports) => { posted.push(message); if (acknowledge) ports[0].postMessage({ ok: true }); ports[0].close(); }, focus: async () => { focused++; } }]; },
    focused: () => focused,
  };
}
const payload = { type: 'dm', ownerId: 'sekai:bob', conversation: 'a'.repeat(64) };
test('worker enforces account and pause while honoring userVisibleOnly in the foreground', async () => {
  const w = worker();
  await w.push(payload); assert.equal(w.notices.length, 0);
  await w.state({ ownerId: 'sekai:alice' }); await w.push(payload); assert.equal(w.notices.length, 0);
  await w.state({ ownerId: payload.ownerId, pausedUntil: Date.now() + 10000 }); await w.push(payload); assert.equal(w.notices.length, 0);
  await w.state({ ownerId: payload.ownerId }); w.window(true); await w.push(payload); assert.equal(w.notices.length, 1);
  w.window(false); await w.push(payload); assert.equal(w.notices.length, 2);
  assert.equal(w.notices[0].tag, 'dm:' + payload.conversation);
  assert.equal(w.notices[0].body, '您有新的私信，请打开 Nightcord 查看。');
  await w.state(null); await w.push(payload); assert.equal(w.notices.length, 2);
});
test('a loading or older app cannot swallow a notification click or lose its draft through navigation', async () => {
  const w = worker(); await w.state({ ownerId: payload.ownerId }); w.window(false, false);
  await w.emit('notificationclick', { notification: { data: payload, close() {} } });
  assert.deepEqual(w.opened, ['/?dm=' + payload.conversation]); assert.equal(w.focused(), 1);
});
test('notification click focuses existing app without navigating drafts, or opens a validated conversation URL', async () => {
  const w = worker(); let closed = 0;
  await w.state({ ownerId: payload.ownerId });
  const notification = { data: payload, close: () => { closed++; } };
  await w.emit('notificationclick', { notification });
  assert.deepEqual(w.opened, ['/?dm=' + payload.conversation]);
  w.window(false); await w.emit('notificationclick', { notification });
  assert.equal(w.posted[0].type, 'OPEN_DM'); assert.equal(w.focused(), 1); assert.equal(closed, 2);
  await w.emit('notificationclick', { notification: { data: { ...payload, conversation: '//evil.example' }, close() {} } });
  assert.equal(w.opened.length, 1);
  await w.state(null); await w.emit('notificationclick', { notification }); assert.equal(w.focused(), 1);
});

test('room push obeys room choices, pause and account ownership, and opens the correct room URL', async () => {
  const w = worker(), room = 'nightcord-default', data = { type: 'room', ownerId: 'sekai:bob', room };
  await w.state({ ownerId: data.ownerId }); await w.push(data); assert.equal(w.notices.length, 0);
  await w.state({ ownerId: data.ownerId, rooms: { [room]: { message: true } } });
  await w.push(data); assert.equal(w.notices.length, 1); assert.equal(w.notices[0].tag, 'room:' + room);
  await w.emit('notificationclick', { notification: { data, close() {} } });
  assert.deepEqual(w.opened, ['/?chat=nightcord-default']);
  const managed = 'r_' + 'a'.repeat(32);
  await w.emit('notificationclick', { notification: { data: { ...data, room: managed }, close() {} } });
  assert.equal(w.opened.at(-1), '/?room=' + managed);
  await w.push({ ...data, room: '../bad' }); assert.equal(w.notices.length, 1);
  await w.state({ ownerId: data.ownerId, rooms: { [room]: { message: true, pausedUntil: Date.now() + 10000 } } });
  await w.push(data); assert.equal(w.notices.length, 1);
  await w.state(null); await w.push(data); assert.equal(w.notices.length, 1);
});
