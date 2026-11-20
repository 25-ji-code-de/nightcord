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
