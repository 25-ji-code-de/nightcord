/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function harness() {
  const events = [], sent = [], timers = new Map(); let nextTimer = 0, connected = true;
  const Manager = vm.runInNewContext(readFileSync(new URL('../nightcord-mgr.js', import.meta.url), 'utf8') + '\nNightcordManager', {
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id)
  });
  const manager = new Manager({ eventBus: { emit: (type, data) => events.push({ type, data }) },
    createTransport: () => ({ send: frame => { if (!connected) return false; sent.push(frame); return true; },
      isConnected: () => connected, disconnect() {}, connect() {} }) });
  manager.roomname = 'room-a';
  const user = { id: 'sekai:me', displayName: 'Me', authenticated: true };
  const session = visibility => { manager.handleMessage({ type: 'session', user, visibility }); manager.handleMessage({ ready: true }); };
  return { manager, events, sent, timers, user, session, connected: value => { connected = value; } };
}

test('visibility waits for confirmation, synchronizes other tabs and recovers from rejection', () => {
  const h = harness(); h.session('online');
  assert.equal(h.manager.setVisibility('hidden'), true);
  assert.equal(h.manager.visibilityState.visibility, 'online');
  assert.equal(h.manager.visibilityState.pending, 'hidden');
  assert.equal(h.manager.setVisibility('offline'), false);
  const requestId = h.sent.at(-1).requestId;
  h.manager.handleMessage({ type: 'room:visibility', userId: h.user.id, visibility: 'offline' });
  assert.equal(h.manager.visibilityState.visibility, 'offline');
  assert.equal(h.manager.visibilityState.pending, 'hidden', 'another tab cannot acknowledge our write');
  h.manager.handleMessage({ type: 'room:visibility', userId: h.user.id, visibility: 'hidden', requestId });
  assert.equal(h.manager.visibilityState.visibility, 'hidden');
  assert.equal(h.manager.visibilityState.pending, null); assert.equal(h.timers.size, 0);
  h.manager.setVisibility('online');
  h.manager.handleMessage({ type: 'room:visibility', requestId: h.sent.at(-1).requestId, error: '稍后重试', code: 'rate_limited' });
  assert.equal(h.manager.visibilityState.visibility, 'hidden');
  assert.equal(h.manager.visibilityState.error, '稍后重试');
  assert.equal(h.manager.visibilityState.pending, null); assert.equal(h.timers.size, 0);
  h.manager.handleMessage({ type: 'room:visibility', userId: 'sekai:someone-else', visibility: 'online' });
  assert.equal(h.manager.visibilityState.visibility, 'hidden');
});

test('room switching, reconnects, old servers and timed-out saves never reuse an unconfirmed setting', () => {
  const h = harness(); h.session('hidden');
  h.manager.setVisibility('online');
  h.manager.joinRoom('room-b');
  assert.equal(h.manager.visibilityState.visibility, null); assert.equal(h.timers.size, 0);
  assert.equal(h.manager.setVisibility('online'), false);
  h.session('offline'); assert.equal(h.manager.visibilityState.visibility, 'offline');
  h.manager.setVisibility('hidden');
  const requestId = h.sent.at(-1).requestId;
  const timer = [...h.timers.values()][0]; h.timers.clear(); timer();
  assert.equal(h.manager.visibilityState.available, false);
  assert.equal(h.manager.visibilityState.visibility, 'offline');
  assert.match(h.manager.visibilityState.error, /未收到保存确认/);
  h.manager.handleMessage({ type: 'room:visibility', userId: h.user.id, visibility: 'hidden', requestId });
  assert.equal(h.manager.visibilityState.visibility, 'hidden'); assert.equal(h.manager.visibilityState.available, true);
  h.manager.handleConnectionClose();
  assert.equal(h.manager.visibilityState.available, false);
  h.session(undefined);
  assert.equal(h.manager.visibilityState.available, false, 'old servers do not offer an ineffective privacy toggle');
  assert.equal(h.manager.setVisibility('hidden'), false);
});

test('server silent transitions still update roster while retaining the silence flag', () => {
  const h = harness();
  h.manager.handleMessage({ joined: 'Me', user: h.user, silent: true });
  assert.ok(h.manager.roster.has(h.user.id)); assert.equal(h.events.at(-1).data.silent, true);
  h.manager.handleMessage({ quit: 'Me', userId: h.user.id, silent: true });
  assert.ok(!h.manager.roster.has(h.user.id)); assert.equal(h.events.at(-1).data.silent, true);
});
