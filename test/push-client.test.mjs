/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

async function fixture(options = {}) {
  const handlers = new Map(), storage = new Map(), calls = [], order = [], opened = [], states = [];
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  let sub = null, permission = options.permission || 'granted';
  const user = { id: 'sekai:bob', authenticated: true };
  const key = Buffer.alloc(65, 1).toString('base64url');
  const registration = {
    active: { postMessage: (message, ports) => { states.push(message.state); ports[0].postMessage({ ok: true }); ports[0].close(); } },
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async value => { order.push('subscribe'); assert.equal(value.userVisibleOnly, true);
        sub = { endpoint: 'https://fcm.googleapis.com/test', toJSON: () => ({ endpoint: sub.endpoint, keys: {} }),
          unsubscribe: async () => { order.push('unsubscribe'); await options.beforeUnsubscribe?.(); sub = null; return true; } }; return sub; },
    },
  };
  const app = { identity: { getAccessToken: async () => 'test-token' }, eventBus: { on: (name, fn) => handlers.set(name, fn) },
    directMessages: { base: 'https://chat.nightcord.de5.net/api/dm', user, ready: false, conversations: new Map() },
    directMessageView: { open: id => opened.push(id) } };
  const sandbox = { console, URL, URLSearchParams, Uint8Array, TextEncoder, atob, AbortSignal, MessageChannel, setTimeout, clearTimeout, crypto: globalThis.crypto,
    location: { search: options.search || '', href: 'https://nightcord.de5.net/' + (options.search || '') },
    history: { state: null, replaceState() {} }, localStorage, sessionStorage: localStorage,
    window: { PushManager: function () {}, Notification: {}, addEventListener() {} },
    Notification: { get permission() { return permission; }, requestPermission: async () => { order.push('permission'); return options.permissionResult ? options.permissionResult : permission; } },
    navigator: { serviceWorker: { addEventListener: (name, fn) => handlers.set('worker:' + name, fn) }, setAppBadge: async () => {}, clearAppBadge: async () => {} },
    fetch: async (url, init) => {
      if (url.endsWith('/config')) return { ok: true, json: async () => ({ enabled: true, publicKey: key }) };
      calls.push({ url, init }); order.push('fetch');
      if (options.fail) throw new Error('Network failed');
      await options.beforeResponse?.(url, init);
      return { ok: true };
    },
  };
  vm.runInNewContext(readFileSync(new URL('../js/services/push-notifications.js', import.meta.url), 'utf8') + '\nglobalThis.Push = PushNotifications;', sandbox);
  const push = new sandbox.Push(app, Promise.resolve(registration), () => {});
  await push.ready;
  return { push, calls, states, storage, order, handlers, opened, app, sub: () => sub };
}
test('permission comes from an explicit enable action and denied permission never subscribes', async () => {
  const f = await fixture({ permission: 'denied' });
  assert.deepEqual(f.order, []);
  await assert.rejects(f.push.enable(), /未获得通知权限/);
  assert.deepEqual(f.order, ['permission']); assert.equal(f.calls.length, 0);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('changing accounts while the permission prompt is open cannot enable push for either account', async () => {
  const permission = deferred();
  const f = await fixture({ permissionResult: permission.promise });
  const enabling = f.push.enable();
  await f.push.setUser({ id: 'sekai:alice', authenticated: true });
  permission.resolve('granted');
  await assert.rejects(enabling, /账户已切换/);
  assert.equal(f.calls.length, 0); assert.equal(f.sub(), null); assert.equal(f.push.state, null);
});
test('a delayed pause cannot restore device ownership after logout', async () => {
  const response = deferred(); let hold = false;
  const f = await fixture({ beforeResponse: url => hold && url.endsWith('/subscribe') ? response.promise : undefined });
  await f.push.enable(); hold = true;
  const pausing = f.push.pause();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  const logout = f.push.logout();
  response.resolve();
  await assert.rejects(pausing);
  await logout;
  assert.equal(f.sub(), null); assert.equal(f.push.state, null); assert.equal(f.states.at(-1), null);
});
test('an obsolete logout cannot clear the identity of a subsequent login', async () => {
  const response = deferred();
  const f = await fixture({ beforeUnsubscribe: () => response.promise });
  await f.push.enable();
  const logout = f.push.logout();
  while (!f.order.includes('unsubscribe')) await new Promise(resolve => setImmediate(resolve));
  const login = f.push.setUser({ id: 'sekai:alice', authenticated: true });
  response.resolve(); await Promise.all([logout, login]);
  assert.equal(f.push.user?.id, 'sekai:alice'); assert.equal(f.push.state, null);
});
test('subscription and pause are authenticated, persisted for the account, and removed on logout', async () => {
  const f = await fixture(); await f.push.enable();
  assert.deepEqual(f.order.slice(0, 3), ['permission', 'subscribe', 'fetch']);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(f.push.state.ownerId, 'sekai:bob');
  assert.equal(JSON.stringify(f.states).includes('test-token'), false);
  await f.push.pause(); assert.ok(f.push.state.pausedUntil > Date.now());
  await f.push.pause(); assert.equal(f.push.state.pausedUntil, 0);
  await f.push.logout(); assert.equal(f.sub(), null); assert.equal(f.push.state, null);
  assert.ok(f.calls.some(call => call.url.endsWith('/unsubscribe')), 'logout frees the old account device slot');
  assert.equal(f.storage.has('nightcord-push-device'), false); assert.equal(f.states.at(-1), null);
});
test('failed registration rolls back browser subscription and account switches cannot enable old requests', async () => {
  const failed = await fixture({ fail: true });
  await assert.rejects(failed.push.enable(), /Network failed/); assert.equal(failed.sub(), null); assert.equal(failed.push.state, null);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture({ beforeResponse: () => waiting });
  const enabling = f.push.enable();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const switching = f.push.setUser({ id: 'sekai:alice', authenticated: true });
  release(); await assert.rejects(enabling, /账户已切换/); await switching;
  assert.equal(f.sub(), null); assert.equal(f.push.state, null);
});
test('notification destination waits for authenticated inbox sync and survives the OAuth redirect', async () => {
  const id = 'a'.repeat(64), f = await fixture({ search: '?dm=' + id });
  f.push.openPending(); assert.deepEqual(f.opened, []);
  assert.equal(f.storage.get('nightcord-push-destination'), id);
  f.app.directMessages.ready = true;
  f.app.directMessages.conversations.set(id, { id });
  f.handlers.get('dm:synced')(); assert.deepEqual(f.opened, [id]);
  assert.equal(f.storage.has('nightcord-push-destination'), false);
});

test('notification clicks received before login are acknowledged and wait for the matching conversation', async () => {
  const f = await fixture(), id = 'b'.repeat(64); let acknowledged = false;
  f.push.user = null;
  f.handlers.get('worker:message')({ data: { type: 'OPEN_DM', ownerId: 'sekai:bob', conversation: id },
    ports: [{ postMessage: data => { acknowledged = data.ok; } }] });
  assert.equal(acknowledged, true); assert.deepEqual(f.opened, []);
  f.app.directMessages.ready = true; f.app.directMessages.conversations.set(id, { id });
  f.handlers.get('dm:synced')(); assert.deepEqual(f.opened, [id]);
});

test('a same-account session refresh queued during enable does not revoke the completed choice', async () => {
  const response = deferred();
  const f = await fixture({ beforeResponse: () => response.promise });
  const enabling = f.push.enable();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const refreshing = f.push.setUser(f.push.user);
  response.resolve(); await enabling; await refreshing;
  assert.ok(f.sub()); assert.equal(f.push.state.ownerId, 'sekai:bob');
});

test('room switches request permission explicitly, retain independent categories and isolate rooms', async () => {
  const f = await fixture();
  await f.push.setRoomPreferences('nightcord-default', { mention: true });
  assert.equal(f.order[0], 'permission');
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscribe')).length, 1);
  assert.equal(f.push.roomPreferences().message, false);
  assert.equal(f.push.roomPreferences('nightcord-default').mention, true);
  assert.equal(f.push.roomPreferences('nightcord-test').mention, false);
  await f.push.setRoomPreferences('nightcord-default', { message: true });
  assert.equal(f.order.filter(item => item === 'permission').length, 1);
  assert.equal(f.push.roomPreferences('nightcord-default').mention, true);
  assert.equal(f.push.roomPreferences('nightcord-default').message, true);
  assert.equal(f.states.at(-1).rooms['nightcord-default'].mention, true);
  await f.push.disable(); assert.equal(f.push.roomPreferences('nightcord-default').mention, false);
});

test('failed room synchronization does not present an enabled switch', async () => {
  const f = await fixture({ beforeResponse: url => { if (url.endsWith('/room')) throw new Error('Room offline'); } });
  await assert.rejects(f.push.setRoomPreferences('nightcord-default', { message: true }), /Room offline/);
  assert.equal(f.push.roomPreferences('nightcord-default').message, false);
  assert.ok(f.push.state, 'device permission remains usable for a later retry');
});

test('attention changes reuse the existing socket and never send a request for every message or scroll', async () => {
  const f = await fixture(); await f.push.setRoomPreferences('nightcord-default', { message: true });
  const frames = []; let viewing = true;
  f.app.ui = { currentRoom: 'nightcord-default', alerts: { viewing: () => viewing } };
  f.app.chatRoom = { wsManager: { ws: { readyState: 1, send: text => frames.push(JSON.parse(text)) } } };
  const requests = f.calls.length;
  for (let i = 0; i < 30; i++) await f.push.roomAttention();
  assert.equal(frames.length, 1); assert.equal(frames[0].viewing, true);
  viewing = false; await f.push.roomAttention(); assert.equal(frames.length, 2);
  assert.equal(f.calls.length, requests);
});

test('switching accounts while a room setting saves cannot restore the old device', async () => {
  const response = deferred();
  const f = await fixture({ beforeResponse: url => url.endsWith('/room') ? response.promise : undefined });
  const saving = f.push.setRoomPreferences('nightcord-default', { message: true });
  while (!f.calls.some(call => call.url.endsWith('/room'))) await new Promise(resolve => setImmediate(resolve));
  const switching = f.push.setUser({ id: 'sekai:alice', authenticated: true });
  response.resolve(); await assert.rejects(saving, /账户已切换/); await switching;
  assert.equal(f.push.state, null); assert.equal(f.push.roomPreferences('nightcord-default').message, false);
});

test('unchanged attention can renew an old room choice without per-message synchronization', async () => {
  const f = await fixture(); await f.push.setRoomPreferences('nightcord-default', { mention: true });
  f.app.ui = { currentRoom: 'nightcord-default', alerts: { viewing: () => true } };
  f.app.chatRoom = { wsManager: { ws: { readyState: 1, send() {} } } };
  await f.push.roomAttention();
  f.push.state.rooms['nightcord-default'].syncedAt = Date.now() - 2 * 86400000;
  f.storage.set(f.push.storageKey, JSON.stringify(f.push.state));
  const before = f.calls.length;
  for (let i = 0; i < 30; i++) await f.push.roomAttention();
  await f.push.queue;
  assert.equal(f.calls.length, before + 1);
  assert.ok(f.push.roomPreferences('nightcord-default').syncedAt > Date.now() - 1000);
});
