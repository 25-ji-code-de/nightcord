/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readBrowserScript } from '../scripts/browser-source.mjs';

test('generic transport delivers JSON without interpreting chat authentication or presence', async () => {
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 1; this.events = {}; this.sent = []; }
    addEventListener(type, callback) { this.events[type] = callback; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.events.close?.({ code: 1000 }); }
  }
  const context = vm.createContext({ WebSocket: Socket, setTimeout, clearTimeout, console });
  const Transport = vm.runInContext(`${readBrowserScript('websocket-mgr.js')}\nWebSocketManager`, context);
  const received = [];
  const connection = new Transport({ onMessage: data => received.push(data) });
  await connection.connect('wss://example.test/updates');
  const old = connection.ws;
  await old.events.open({});
  assert.equal(old.url, 'wss://example.test/updates');
  assert.deepEqual(old.sent, [], 'a generic socket must not send a chat handshake');
  old.events.message({ data: JSON.stringify({ code: 'auth_invalid', ready: false, value: 42 }) });
  assert.equal(received[0].value, 42);
  assert.equal(connection.ready, true);
  assert.equal(connection.shouldReconnect, true);
  assert.equal(connection.send({ subscribe: 'weather' }), true);
  assert.deepEqual(old.sent[0], { subscribe: 'weather' });
  await connection.connect('wss://example.test/other');
  old.events.message({ data: JSON.stringify({ stale: true }) });
  assert.equal(received.length, 1, 'stale sockets cannot deliver after switching targets');
  connection.disconnect();
  assert.equal(connection.send({ after: 'disconnect' }), false);
});

function retryFixture(config = {}) {
  let clock = 0, nextId = 1;
  const timers = new Map(), sockets = [];
  class Socket {
    static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.events = {}; sockets.push(this); }
    addEventListener(type, callback) { this.events[type] = callback; }
    send() {}
    close() { this.readyState = 3; this.events.close?.({ code: 1013 }); }
    open() { this.readyState = 1; this.events.open({}); }
    message(data) { this.events.message({ data: JSON.stringify(data) }); }
  }
  const context = vm.createContext({ WebSocket: Socket, console: { log() {} },
    Date: { now: () => clock }, Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    setTimeout: (callback, ms) => { const id = nextId++; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const Transport = vm.runInContext(`${readBrowserScript('websocket-mgr.js')}\nWebSocketManager`, context);
  const connection = new Transport(config);
  return { connection, timers, sockets, context,
    advanceClock(ms) { clock += ms; },
    async retry() {
      assert.equal(timers.size, 1, 'only one retry timer may exist');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id); clock += timer.ms; timer.callback(); await connection.connectionPromise;
      return timer.ms;
    },
  };
}

test('outages back off with bounded jitter and a protocol ready frame resets the delay', async () => {
  const protocol = { attach(c) { this.c = c; }, reset() {}, prepare: async () => ({}), url: x => x,
    open() {}, close() {}, message(data) { if (data.ready) this.c.ready = true; } };
  const f = retryFixture({ protocol });
  await f.connection.connect('wss://example.test');
  const waits = [];
  for (let i = 0; i < 7; i++) {
    f.connection.ws.open(); // Transport open is not an authenticated connection.
    f.advanceClock(60000); // Slow failures must still wait after disconnection.
    f.connection.ws.close(); f.connection.rejoin();
    waits.push(await f.retry());
  }
  assert.deepEqual(waits, [8750, 17500, 35000, 70000, 105000, 105000, 105000]);
  f.connection.ws.open(); f.connection.ws.message({ ready: true });
  f.advanceClock(3600000); f.connection.ws.close();
  assert.equal(await f.retry(), 8750);
  f.connection.disconnect();
});

test('pause, disconnect and switching destinations cancel pending and stale retries', async () => {
  const f = retryFixture(); await f.connection.connect('wss://example.test/old');
  f.connection.ws.close();
  const staleTimer = f.timers.values().next().value.callback;
  await f.connection.connect('wss://example.test/new');
  staleTimer(); assert.equal(f.sockets.length, 2); assert.equal(f.timers.size, 0);
  f.connection.ws.close(); staleTimer();
  assert.equal(f.timers.size, 1, 'a stale callback cannot erase the new retry');
  assert.notEqual(f.connection._reconnectTimer, null);
  f.connection.pauseAutoReconnect();
  assert.equal(f.timers.size, 0);
  f.connection.resumeAutoReconnect(); await f.connection.connect('wss://example.test/new');
  f.connection.ws.close(); f.connection.disconnect();
  assert.equal(f.timers.size, 0);
});

test('guest preparation failures also back off without creating sockets', async () => {
  const protocol = { attach(c) { this.c = c; }, reset() {}, prepare() { this.c.rejoin(); } };
  const f = retryFixture({ protocol }); await f.connection.connect('room');
  assert.equal(await f.retry(), 8750);
  assert.equal(await f.retry(), 17500);
  assert.equal(f.sockets.length, 0); f.connection.disconnect();
});

test('managed-room handshake failures use the transport backoff until ready', async () => {
  const f = retryFixture();
  f.context.crypto = { randomUUID: () => 'fixture' };
  const Protocol = vm.runInContext(`${readBrowserScript('js/network/managed-room-session.js')}\nManagedRoomProtocol`, f.context);
  f.connection.protocol = new Protocol({ base: 'https://example.test', getAccessToken: async () => 'token' });
  f.connection.protocol.attach(f.connection);
  await f.connection.connect('room');
  for (const expected of [8750, 17500, 35000]) {
    f.connection.ws.open(); f.connection.ws.close();
    assert.equal(await f.retry(), expected);
  }
  f.connection.ws.open(); f.connection.ws.message({ type: 'ready', authExpiresAt: 99999999 });
  f.connection.ws.close(); assert.equal(await f.retry(), 8750);
  f.connection.disconnect();
});
