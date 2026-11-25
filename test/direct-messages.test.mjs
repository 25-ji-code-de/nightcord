/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const source = readFileSync(new URL('../js/services/direct-messages.js', import.meta.url), 'utf8');
const busSource = readFileSync(new URL('../event-bus.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const conversation = { id: 'room', ownerId: 'sekai:alice', peer: { id: 'sekai:bob' }, version: 1, state: 'accepted', lastSeq: 1, incoming: 1, hidden: false, readSeq: 0, unread: 1 };
const message = seq => ({ seq, senderId: 'sekai:bob', text: 'Message ' + seq, kind: 'text', clientMessageId: 'remote-' + seq, timestamp: seq });
async function fixture(t, handler) {
  const context = vm.createContext({ console, crypto, setTimeout, clearTimeout, AbortController, AbortSignal, Response });
  const { Manager, Bus } = vm.runInContext(busSource + '\n' + source + '\n({ Manager: DirectMessageManager, Bus: EventBus })', context);
  const bus = new Bus();
  const manager = new Manager({ eventBus: bus, getAccessToken: async () => 'alice', fetcher: async (url, opts) =>
    url.endsWith('/config') ? json({ mode: 'on' }) : handler(url, opts) });
  t.after(() => manager.destroy());
  await manager.configPromise; manager.user = { id: 'sekai:alice', authenticated: true };
  return { manager, bus };
}
function socketFor(manager) {
  const listeners = new Map();
  const socket = { readyState: 1, sent: [], close() { if (this.readyState === 3) return; this.readyState = 3; listeners.get('close')?.(); },
    send(data) { this.sent.push(JSON.parse(data)); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    open() { listeners.get('open')(); },
    async receive(data) { await listeners.get('message')({ data: JSON.stringify(data) }); },
  };
  manager.createSocket = () => socket;
  return socket;
}
test('late history and token results cannot repopulate a reset account', async t => {
  const response = deferred();
  const { manager } = await fixture(t, () => response.promise);
  manager.put(conversation);
  const loading = manager.history('room');
  await setImmediate();
  manager.reset();
  response.resolve(json({ conversation, messages: [message(1)], more: false }));
  await assert.rejects(loading, { code: 'stale_session' });
  assert.equal(manager.messages.size, 0); assert.equal(manager.conversations.size, 0);
  const token = deferred(); manager.getAccessToken = () => token.promise;
  const sending = manager.call('/conversations');
  manager.reset(); token.resolve('old-token');
  await assert.rejects(sending, { code: 'stale_session' });
});
test('reordered account snapshots preserve hidden preferences and do not duplicate notifications', async t => {
  const responses = [];
  const { manager, bus } = await fixture(t, () => { const response = deferred(); responses.push(response); return response.promise; });
  manager.ready = true; manager.put(conversation, 1);
  let notifications = 0; bus.on('dm:incoming', () => notifications++);
  const first = manager.refresh('room', false), second = manager.refresh('room', false);
  await setImmediate();
  responses[1].resolve(json({ conversation: { ...conversation, version: 2, incoming: 2 }, revision: 3 }));
  await second;
  responses[0].resolve(json({ conversation: { ...conversation, version: 2, incoming: 2 }, revision: 2 }));
  await first;
  assert.equal(notifications, 1);
  manager.put({ ...conversation, version: 3, hidden: true, unread: 0 }, 5);
  manager.put({ ...conversation, version: 2, hidden: false }, 4);
  assert.equal(manager.conversations.get('room').hidden, true);
  manager.put({ ...conversation, version: 6, incoming: 5 });
  manager.put({ ...conversation, version: 4, hidden: false, readSeq: 4, readIncoming: 3 }, 6);
  assert.equal(manager.conversations.get('room').version, 6);
  assert.equal(manager.conversations.get('room').unread, 2);
});
test('a send acknowledgement cannot skip an intervening message while catching up history', async t => {
  const paths = [];
  const { manager } = await fixture(t, url => {
    paths.push(url);
    return json({ conversation: { ...conversation, version: 3, lastSeq: 3 }, messages: [message(2), message(3)], more: false });
  });
  manager.put({ ...conversation, version: 3, lastSeq: 3 });
  manager.messages.set('room', [message(1), { ...message(3), senderId: 'sekai:alice' }]);
  manager.syncedSeq.set('room', 1);
  await manager.history('room');
  assert.ok(paths[0].endsWith('?after=1'));
  assert.deepEqual(Array.from(manager.messages.get('room'), value => value.seq), [1, 2, 3]);
  assert.equal(manager.syncedSeq.get('room'), 3);
});
test('uncertain sends retry the same client ID and remove the failed draft after confirmation', async t => {
  let attempts = 0; const ids = [];
  const { manager } = await fixture(t, (url, opts) => {
    const data = JSON.parse(opts.body); ids.push(data.clientMessageId);
    if (++attempts === 1) throw new TypeError('Connection interrupted after commit');
    return json({ conversation, message: { ...data, seq: 1, senderId: 'sekai:alice', timestamp: 1 } });
  });
  await manager.send('room', { text: 'Hello' });
  const item = manager.pending.get('room')[0];
  assert.equal(item.status, 'failed');
  await manager.send('room', {}, item);
  assert.equal(ids[0], ids[1]); assert.equal(manager.pending.get('room').length, 0);
  assert.equal(manager.messages.get('room').length, 1);
});

test('concurrent send confirmations cannot restore an already confirmed pending item', async t => {
  const responses = [];
  const { manager } = await fixture(t, (url, opts) => {
    const response = deferred(); responses.push({ ...response, data: JSON.parse(opts.body) }); return response.promise;
  });
  const first = manager.send('room', { text: 'First' }), second = manager.send('room', { text: 'Second' });
  await setImmediate();
  responses[1].resolve(json({ conversation, message: { ...responses[1].data, seq: 2, senderId: 'sekai:alice', timestamp: 2 } }));
  await second;
  assert.equal(manager.pending.get('room').length, 1);
  responses[0].resolve(json({ conversation, message: { ...responses[0].data, seq: 1, senderId: 'sekai:alice', timestamp: 1 } }));
  await first;
  assert.equal(manager.pending.get('room').length, 0);
  assert.deepEqual(Array.from(manager.messages.get('room'), value => value.seq), [1, 2]);
});

test('live metadata and lease renewals avoid HTTP reads, while reconnects and revision gaps resync', async t => {
  const paths = [];
  const { manager, bus } = await fixture(t, url => {
    paths.push(url);
    return json({ conversations: [conversation], revision: 1, next: null });
  });
  const socket = socketFor(manager);
  await manager.connect();
  const ready = revision => ({ type: 'dm:ready', user: manager.user, mode: 'on', expiresAt: Date.now() + 300000, revision });
  await socket.receive(ready(1));
  let notifications = 0; bus.on('dm:incoming', () => notifications++);
  const change = { type: 'dm:changed', id: 'room', revision: 2, silent: false,
    conversation: { ...conversation, version: 2, lastSeq: 2, incoming: 2 } };
  await socket.receive(change);
  await socket.receive(change);
  assert.equal(notifications, 1);
  assert.equal(manager.conversations.get('room').incoming, 2);
  await socket.receive(ready(2));
  await manager.resume(); await manager.resume();
  assert.equal(paths.length, 1, 'renewal, notification and focus need no HTTP reads');
  assert.equal(socket.sent.length, 0, 'focus does not reauthenticate a healthy lease');
  await socket.receive(ready(4));
  assert.equal(paths.length, 2, 'missing account events trigger repair');
  const replacement = socketFor(manager);
  await manager.connect(); await replacement.receive(ready(4));
  assert.equal(paths.length, 3, 'a new connection always synchronizes');
});

test('legacy notifications still fetch metadata during rollout', async t => {
  const paths = [];
  const { manager } = await fixture(t, url => {
    paths.push(url);
    return json(url.endsWith('/room') ? { conversation, revision: 2 } : { conversations: [], revision: 1, next: null });
  });
  const socket = socketFor(manager); await manager.connect();
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', expiresAt: Date.now() + 300000, revision: 1 });
  await socket.receive({ type: 'dm:changed', id: 'room', revision: 2 });
  assert.equal(paths.length, 2); assert.ok(paths[1].endsWith('/room'));
});

test('confirmed contiguous sends avoid redundant history reads without skipping gaps', async t => {
  let seq = 2; const paths = [];
  const { manager } = await fixture(t, (url, opts) => {
    paths.push(url);
    return json({ conversation: { ...conversation, version: seq, lastSeq: seq },
      message: { ...JSON.parse(opts.body), seq, senderId: 'sekai:alice', timestamp: seq }, revision: seq });
  });
  manager.put(conversation, 1); manager.messages.set('room', [message(1)]); manager.syncedSeq.set('room', 1);
  await manager.send('room', { text: 'Next' });
  assert.equal(manager.syncedSeq.get('room'), 2);
  await manager.history('room');
  assert.equal(paths.length, 1);
  seq = 4; await manager.send('room', { text: 'After a missing message' });
  assert.equal(manager.syncedSeq.get('room'), 2);
});

test('read updates coalesce while in flight and skip progress containing only own messages', async t => {
  const pending = deferred(); let requests = 0;
  const { manager } = await fixture(t, () => { requests++; return pending.promise; });
  manager.put({ ...conversation, incoming: 0, readIncoming: 0 });
  await manager.read('room', 1);
  assert.equal(requests, 0);
  manager.put({ ...conversation, incoming: 1, readIncoming: 0 });
  const first = manager.read('room', 1), repeated = manager.read('room', 1);
  const flushed = manager.flushRead('room');
  await setImmediate(); assert.equal(requests, 1);
  pending.resolve(json({ conversation: { ...conversation, readSeq: 1, readIncoming: 1 }, revision: 2 }));
  await Promise.all([first, repeated, flushed]);
  assert.equal(requests, 1); assert.equal(manager.conversations.get('room').unread, 0);
});

test('a short read window sends the highest seen sequence and leaves unseen messages unread', async t => {
  const sequences = [];
  const { manager } = await fixture(t, (url, opts) => {
    const { seq } = JSON.parse(opts.body); sequences.push(seq);
    return json({ conversation: { ...conversation, lastSeq: 100, incoming: 100, readSeq: seq, readIncoming: seq }, revision: 2 });
  });
  manager.put({ ...conversation, lastSeq: 100, incoming: 100 });
  await Promise.all(Array.from({ length: 50 }, (_, n) => manager.read('room', n + 1)));
  assert.deepEqual(sequences, [50]);
  assert.equal(manager.conversations.get('room').unread, 50);
});

test('failed read progress survives until an explicit flush, and reset discards queued progress', async t => {
  const sequences = []; let failed = true;
  const { manager } = await fixture(t, (url, opts) => {
    const { seq } = JSON.parse(opts.body); sequences.push(seq);
    if (failed) throw new TypeError('offline');
    return json({ conversation: { ...conversation, readSeq: seq, readIncoming: seq }, revision: 2 });
  });
  manager.put(conversation);
  const queued = manager.read('room', 1);
  const rejected = assert.rejects(queued, /offline/);
  await assert.rejects(manager.flushRead('room'), /offline/); await rejected;
  assert.equal(manager.readPending.get('room'), 1);
  failed = false; await manager.flushReads();
  assert.deepEqual(sequences, [1, 1]); assert.equal(manager.readPending.size, 0);
  manager.put({ ...conversation, version: 2, lastSeq: 2, incoming: 2 });
  const late = manager.read('room', 2); manager.reset(); await late;
  await manager.flushReads(); assert.deepEqual(sequences, [1, 1]);
});

test('read progress arriving during a request converges without parallel requests', async t => {
  const firstResponse = deferred(); const sequences = [];
  const { manager } = await fixture(t, (url, opts) => {
    const { seq } = JSON.parse(opts.body); sequences.push(seq);
    return seq === 1 ? firstResponse.promise : json({ conversation: { ...conversation, incoming: 3, lastSeq: 3, readSeq: seq, readIncoming: seq }, revision: 3 });
  });
  manager.put({ ...conversation, incoming: 3, lastSeq: 3 });
  const first = manager.read('room', 1), flush = manager.flushRead('room');
  await setImmediate();
  const next = manager.read('room', 3); assert.deepEqual(sequences, [1]);
  firstResponse.resolve(json({ conversation: { ...conversation, incoming: 3, lastSeq: 3, readSeq: 1, readIncoming: 1 }, revision: 2 }));
  await Promise.all([first, flush, next]); assert.deepEqual(sequences, [1, 3]);
});

test('connect and renewal coalesce token work and wait for server acknowledgement', async t => {
  const { manager } = await fixture(t, () => json({ conversations: [], revision: 0 }));
  const token = deferred(); let tokens = 0, sockets = 0;
  manager.getAccessToken = () => { tokens++; return token.promise; };
  const socket = socketFor(manager); manager.createSocket = () => { sockets++; return socket; };
  const connecting = [manager.connect(), manager.connect(), manager.resume()];
  assert.equal(tokens, 1); token.resolve('alice'); await Promise.all(connecting); assert.equal(sockets, 1);
  socket.open(); await manager.resume(); await manager.resume();
  assert.equal(tokens, 1); assert.equal(socket.sent.length, 1, 'initial authentication is also in flight until ready');
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', revision: 0, expiresAt: Date.now() + 300000 });
  const beforeRenewal = tokens; // Initial ready also authenticates the list HTTP.
  manager.expiresAt = Date.now() + 50000;
  await Promise.all([manager.resume(), manager.resume(), manager.renew()]);
  await manager.resume();
  assert.equal(tokens, beforeRenewal + 1); assert.equal(socket.sent.length, 2);
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', revision: 0, expiresAt: Date.now() + 300000 });
  assert.equal(manager.authWork, null);
});

test('a delayed renewal cannot authenticate a replacement socket or a new account', async t => {
  const { manager } = await fixture(t, () => json({}));
  const original = socketFor(manager); await manager.connect();
  const token = deferred(); manager.getAccessToken = () => token.promise;
  const renewing = manager.renew();
  const replacement = socketFor(manager); manager.socket = replacement;
  token.resolve('old'); await renewing;
  assert.equal(original.sent.length, 0); assert.equal(replacement.sent.length, 0);
  const nextToken = deferred(); manager.getAccessToken = () => nextToken.promise;
  const pending = manager.renew(); manager.reset(); nextToken.resolve('old'); await pending;
  assert.equal(replacement.sent.length, 0);
});

test('resuming after a receive lease expires reconnects without discarding the account or drafts', async t => {
  const { manager, bus } = await fixture(t, () => json({ conversations: [conversation], revision: 1 }));
  const socket = socketFor(manager); await manager.connect();
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', revision: 1, expiresAt: Date.now() + 300000 });
  manager.drafts.set('room', 'Unsent draft');
  let logouts = 0; bus.on('auth:required', () => logouts++);
  manager.expiresAt = Date.now() - 1;
  const replacement = socketFor(manager);
  await manager.resume();
  assert.equal(logouts, 0);
  assert.equal(manager.user.id, 'sekai:alice');
  assert.equal(manager.drafts.get('room'), 'Unsent draft');
  assert.equal(manager.ready, false, 'a replacement must synchronize before becoming ready');
  assert.equal(manager.socket, replacement);
  assert.equal(socket.readyState, 3);
});

test('a failed initial list sync schedules recovery and clears the disconnected lease', async t => {
  const { manager, bus } = await fixture(t, () => { throw new TypeError('offline'); });
  const socket = socketFor(manager); await manager.connect();
  let logouts = 0; bus.on('auth:required', () => logouts++);
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', revision: 1, expiresAt: Date.now() + 300000 });
  assert.equal(manager.ready, false);
  assert.equal(socket.readyState, 3);
  assert.ok(manager.retryTimer);
  assert.equal(manager.expiresAt, 0);
  assert.equal(manager.leaseTimer, null);
  assert.equal(logouts, 0);
});

test('a live revision gap repairs the list immediately and silently', async t => {
  let reads = 0;
  const { manager, bus } = await fixture(t, () => {
    reads++;
    return json({ conversations: [conversation, ...(reads > 1 ? [{ ...conversation, id: 'missed' }] : [])], revision: reads === 1 ? 1 : 3 });
  });
  const socket = socketFor(manager); await manager.connect();
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', revision: 1, expiresAt: Date.now() + 300000 });
  let notifications = 0; bus.on('dm:incoming', () => notifications++);
  await socket.receive({ type: 'dm:changed', conversation, revision: 3, silent: true });
  assert.equal(reads, 2);
  assert.ok(manager.conversations.has('missed'));
  assert.equal(notifications, 0);
});

test('the receive deadline reconnects without treating a missed renewal as invalid credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, bus } = await fixture(t, () => json({ conversations: [conversation], revision: 1 }));
  const socket = socketFor(manager); await manager.connect();
  let logouts = 0; bus.on('auth:required', () => logouts++);
  await socket.receive({ type: 'dm:ready', user: manager.user, mode: 'on', revision: 1, expiresAt: Date.now() + 100 });
  t.mock.timers.tick(101);
  assert.equal(logouts, 0); assert.equal(manager.user.id, 'sekai:alice');
  assert.equal(socket.readyState, 3); assert.equal(manager.ready, false);
  assert.ok(manager.retryTimer);
});

test('an explicit authentication rejection still clears account data and requires login', async t => {
  const { manager, bus } = await fixture(t, () => json({ code: 'login_required' }, 401));
  manager.put(conversation); manager.drafts.set('room', 'Private draft'); manager.messages.set('room', [message(1)]);
  let logouts = 0; bus.on('auth:required', () => logouts++);
  await assert.rejects(manager.refresh('room'), { code: 'login_required' });
  assert.equal(logouts, 1); assert.equal(manager.user, null);
  assert.equal(manager.conversations.size, 0); assert.equal(manager.messages.size, 0); assert.equal(manager.drafts.size, 0);
});
