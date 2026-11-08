/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function websocketHarness(getAccessToken, navigator) {
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 1; this.events = {}; this.sent = []; }
    addEventListener(type, listener) { this.events[type] = listener; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close(code) { this.readyState = 3; this.events.close?.({ code }); }
    message(value) { this.events.message({ data: JSON.stringify(value) }); }
  }
  const Manager = vm.runInNewContext(readFileSync(new URL('../websocket-mgr.js', import.meta.url), 'utf8') + '\nWebSocketManager', {
    WebSocket: Socket, console: { log() {}, warn() {} }, setTimeout, clearTimeout, AbortSignal, navigator,
  });
  const errors = [];
  const guestErrors = [];
  const fetches = [];
  const manager = new Manager({ getAccessToken, onAuthError: e => errors.push(e), onGuestError: e => guestErrors.push(e), fetch: async (url, options) => {
    fetches.push({ url, options });
    return { ok: true, json: async () => ({ id: 'guest:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAt: Date.now() + 180 * 86400000 }) };
  } });
  return { manager, errors, guestErrors, fetches };
}

test('token failure stops reconnect and never silently claims a guest session', async () => {
  const { manager, errors, fetches } = websocketHarness(async () => { throw new Error('revoked'); });
  await manager.connect('identity-test', 'Guest nickname');
  assert.equal(manager.ws, null);
  assert.equal(fetches.length, 0);
  assert.equal(manager.shouldReconnect, false);
  assert.equal(errors.length, 1);
  manager.disconnect();
});

test('authenticated handshake and revalidation wait for the server before sending', async () => {
  const { manager, fetches } = websocketHarness(async () => 'test-bearer');
  await manager.connect('identity-test', 'Guest nickname');
  const socket = manager.ws;
  try {
    await socket.events.open({});
    assert.equal(socket.url.includes('test-bearer'), false);
    assert.equal(socket.sent[0].accessToken, 'test-bearer');
    assert.equal(fetches.length, 0, 'Pass does not require a guest cookie');
    assert.equal(manager.send({ message: 'too early' }), false);
    socket.message({ type: 'session', user: { id: 'sekai:one' }, authExpiresAt: Date.now() + 300000 });
    socket.message({ ready: true });
    assert.equal(manager.send({ message: 'ready' }), true);
    await manager.refreshAuthentication();
    assert.equal(socket.sent.at(-1).type, 'auth');
    assert.equal(manager.send({ message: 'while checking' }), false);
    socket.message({ type: 'session', user: { id: 'sekai:one' }, authExpiresAt: Date.now() + 300000 });
    assert.equal(manager.send({ message: 'checked' }), true);
    socket.message({ code: 'auth_invalid', error: 'expired' });
    assert.equal(manager.send({ message: 'after revocation' }), false);
    assert.equal(manager.shouldReconnect, false);
  } finally { manager.disconnect(); }
});

test('an obsolete token request cannot pause a newer connection', async () => {
  let rejectOld;
  const { manager } = websocketHarness(() => new Promise((_, reject) => { rejectOld = reject; }));
  const pending = manager.connect('identity-test', 'Guest nickname');
  manager.getAccessToken = async () => null;
  await manager.connect('another-room', 'visitor');
  const current = manager.ws;
  await current.events.open({});
  rejectOld(new Error('old request failed'));
  await pending;
  assert.equal(manager.shouldReconnect, true);
  assert.equal(current.sent[0].name, 'visitor');
  manager.disconnect();
});

test('guest initialization precedes the socket and only the cookie carries credentials', async () => {
  const { manager, fetches } = websocketHarness(async () => null);
  await manager.connect('identity-test', 'Visitor');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].options.credentials, 'include');
  assert.equal(fetches[0].options.method, 'POST');
  assert.equal(fetches[0].options.cache, 'no-store');
  await manager.ws.events.open({});
  assert.equal(JSON.stringify(manager.ws.sent), '[{"name":"Visitor","isMobile":false}]');
  assert.equal(manager.ws.url.includes('guest:'), false);
  manager.ws.message({ type: 'session', user: { id: 'guest:one', displayName: 'Visitor' }, guestExpiresAt: Date.now() + 180 * 86400000 });
  manager.ws.message({ ready: true });
  assert.equal(manager.send({ message: 'ready' }), true);
  manager.disconnect();
});

test('guest and Pass handshakes identify mobile browsers, WebViews and iPad desktop mode', async () => {
  const devices = [
    [undefined, false],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 10 }, false],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, false],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile' }, true],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 15; tablet; wv)', userAgentData: { mobile: false } }, true],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, true],
    [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }, true],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Reduced browser UA', userAgentData: { mobile: true } }, true],
  ];
  for (const [device, expected] of devices) {
    for (const token of [null, 'test-bearer']) {
      const { manager } = websocketHarness(async () => token, device);
      try {
        await manager.connect('device-test', 'Visitor');
        await manager.ws.events.open({});
        assert.equal(manager.ws.sent[0].isMobile, expected, JSON.stringify({ device, token }));
        assert.equal(token ? manager.ws.sent[0].accessToken : manager.ws.sent[0].name, token || 'Visitor');
      } finally { manager.disconnect(); }
    }
  }
});

test('blocked guest cookie stops after one recovery instead of looping', async () => {
  const { manager, guestErrors } = websocketHarness(async () => null);
  await manager.connect('identity-test', 'Visitor');
  await manager.ws.events.open({});
  manager.ws.message({ code: 'guest_session_required' });
  await manager.connectionPromise;
  await manager.ws.events.open({});
  manager.ws.message({ code: 'guest_session_required' });
  assert.equal(manager.shouldReconnect, false);
  assert.equal(manager.ready, false);
  assert.equal(guestErrors.length, 1);
  assert.match(guestErrors[0].message, /Cookie/);
  manager.disconnect();
});

test('presence uses identity IDs and AI forwarding preserves the actual sender', () => {
  const events = [];
  const Manager = vm.runInNewContext(readFileSync(new URL('../nightcord-mgr.js', import.meta.url), 'utf8') + '\nNightcordManager', {
    WebSocketManager: class {}, localStorage: { setItem() {} }, window: { AIConfig: { getAllDisplayNames: () => ['Nako'] } },
  });
  const manager = new Manager({ eventBus: { emit: (type, data) => events.push({ type, data }) } });
  const user = { id: 'sekai:one', displayName: 'Same name', authenticated: true };
  const guest = { id: 'guest:two', displayName: 'Same name', authenticated: false };
  manager.handleMessage({ joined: 'Same name', user });
  manager.handleMessage({ joined: 'Same name', user: guest });
  assert.equal(manager.roster.size, 2);
  manager.handleMessage({ quit: 'Same name', userId: guest.id });
  assert.equal(manager.roster.size, 1);
  assert.ok(manager.roster.has(user.id));
  manager.handleMessage({ name: user.displayName, message: '[Nako]forwarded text', timestamp: 100, user });
  const message = events.at(-1).data;
  assert.equal(message.user, null);
  assert.equal(message.sender.id, user.id);
});
