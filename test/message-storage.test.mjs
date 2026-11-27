/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function fixture() {
  const values = new Map(), timers = new Map(), events = new Map();
  const calls = { reads: 0, writes: 0 };
  let serial = 0, blocked = false, quota = false;
  const localStorage = {
    getItem(key) {
      if (blocked) throw new Error('blocked');
      if (key.startsWith('nightcord-messages:')) calls.reads++;
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (blocked) throw new Error('blocked');
      if (key.startsWith('nightcord-messages:')) {
        calls.writes++;
        if (quota) { quota = false; throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); }
      }
      values.set(key, value);
    },
    removeItem: key => values.delete(key),
  };
  const document = { visibilityState: 'visible', addEventListener: (type, listener) => events.set(type, listener) };
  const context = vm.createContext({
    localStorage, document, console: { warn() {} },
    window: { addEventListener: (type, listener) => events.set(type, listener) },
    setTimeout: callback => { timers.set(++serial, callback); return serial; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(readFileSync(new URL('../storage-manager.js', import.meta.url), 'utf8'), context);
  const storage = vm.runInContext('new StorageManager()', context);
  return {
    storage, values, calls, timers, document,
    event: type => events.get(type)(),
    tick: () => { for (const callback of [...timers.values()]) callback(); },
    block: () => { blocked = true; },
    fill: () => { quota = true; },
    read: room => JSON.parse(values.get(`nightcord-messages:${room}`) || '[]'),
  };
}
const message = timestamp => ({ user: 'User', text: `Message ${timestamp}`, timestamp });

test('a receive burst writes history once and retains the newest 2000 messages', () => {
  const h = fixture();
  h.storage.saveMessages('room', Array.from({ length: 2000 }, (_, i) => message(i + 1)));
  h.calls.reads = h.calls.writes = 0;
  for (let i = 2001; i <= 2100; i++) h.storage.appendMessage('room', message(i));
  assert.deepEqual(h.calls, { reads: 0, writes: 0 }, 'receive handlers must not parse or rewrite history');
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.deepEqual(h.calls, { reads: 1, writes: 1 });
  const stored = h.read('room');
  assert.equal(stored.length, 2000);
  assert.equal(stored[0].timestamp, 101);
  assert.equal(stored.at(-1).timestamp, 2100);
  assert.equal(h.storage.getLastMsgTimestamp('room'), 2100);
  assert.equal(h.timers.size, 0);
});

test('reads and reconnect cursors flush pending messages for only the requested room', () => {
  const h = fixture();
  h.storage.appendMessage('first', message(1));
  h.storage.appendMessage('second', message(2));
  assert.equal(h.storage.loadMessages('first')[0].timestamp, 1);
  assert.equal(h.read('second').length, 0);
  assert.equal(h.timers.size, 1);
  assert.equal(h.storage.getLastMsgTimestamp('second'), 2);
  assert.equal(h.read('second')[0].timestamp, 2);
  assert.equal(h.timers.size, 0);
});

test('commits merge the current storage value instead of overwriting another tab', () => {
  const h = fixture();
  h.storage.appendMessage('room', message(3));
  h.values.set('nightcord-messages:room', JSON.stringify([message(1), message(2)]));
  h.tick();
  assert.deepEqual(h.read('room'), [message(1), message(2), message(3)]);
});

for (const event of ['pagehide', 'visibilitychange']) {
  test(`${event} persists pending messages before a page can be discarded`, () => {
    const h = fixture();
    h.storage.appendMessage('old-room', message(1));
    h.storage.appendMessage('new-room', message(2));
    h.document.visibilityState = 'hidden';
    h.event(event);
    assert.deepEqual(h.read('old-room'), [message(1)]);
    assert.deepEqual(h.read('new-room'), [message(2)]);
    assert.equal(h.timers.size, 0);
  });
}

test('malformed, full or unavailable storage never interrupts message delivery', () => {
  const h = fixture();
  h.values.set('nightcord-messages:room', '{}');
  h.storage.appendMessage('room', message(1));
  h.tick();
  assert.deepEqual(h.read('room'), [message(1)]);
  for (let i = 2; i <= 100; i++) h.storage.appendMessage('room', message(i));
  h.fill();
  h.tick();
  assert.equal(h.read('room').length, 50);
  assert.equal(h.read('room').at(-1).timestamp, 100);
  h.block();
  h.storage.appendMessage('room', message(101));
  assert.doesNotThrow(() => h.tick());
  assert.equal(h.timers.size, 0);
});
