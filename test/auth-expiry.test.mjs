/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function fixture({ signedIn = true, remembered = false, guestName = 'Visitor' } = {}) {
  const storage = new Map();
  if (remembered) storage.set('nightcord-sekai-session', '1');
  if (guestName) storage.set('nightcord-guest-name', guestName);
  const calls = [], prompts = [], timers = new Map();
  const browser = new EventTarget(), document = new EventTarget();
  browser.location = { hostname: 'nightcord.test', origin: 'https://nightcord.test', search: '?test' };
  document.visibilityState = 'visible';
  const navigator = { onLine: true };
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const context = vm.createContext({
    window: browser, document, navigator, localStorage, URLSearchParams, console,
    setInterval: (fn, ms) => { timers.set(fn, ms); return fn; },
    clearInterval: fn => timers.delete(fn),
    SekaiAnalytics: class {},
    SekaiPassAuth: class {
      constructor(options) { this.options = options; this.signedIn = signedIn; }
      isAuthenticated() { return this.signedIn; }
      getCurrentUser() { return this.signedIn ? { sub: 'one', name: 'Member' } : null; }
      async getAccessToken() { calls.push('token'); return 'token'; }
      async login() { calls.push('login'); }
      async clearSession() { this.signedIn = false; calls.push('clear'); }
      async logout() { await this.clearSession(); }
    },
  });
  const EventBus = vm.runInContext(readFileSync(new URL('../event-bus.js', import.meta.url), 'utf8') + '\nEventBus', context);
  const Identity = vm.runInContext(readFileSync(new URL('../js/app/identity.js', import.meta.url), 'utf8') + '\nIdentityController', context);
  const app = {
    state: {}, eventBus: new EventBus(),
    chatRoom: {
      roomname: 'nightcord-test', currentUser: signedIn ? { authenticated: true } : null,
      wsManager: { pauseAutoReconnect: () => calls.push('pause'), isConnected: () => true },
      leave: () => calls.push('leave'),
      setUser: name => calls.push(['user', name]),
      refreshAuthentication: async () => calls.push('validate'),
    },
    ui: {
      setSessionUnavailable: () => calls.push('unavailable'),
      showAuthExpired: options => { prompts.push(options); return () => calls.push('dismiss'); },
      showNameChooser: (_options, callback) => { app.chooseName = callback; calls.push('choose-name'); },
      setupNameChooser: callback => { app.chooseName = callback; calls.push('choose-name'); },
    },
    joinRoom: room => calls.push(['join', room]),
    broadcastIdentityChange: () => calls.push('broadcast'),
  };
  const identity = new Identity(app);
  identity.setup();
  identity.init('nightcord-test');
  calls.length = 0;
  return { identity, app, calls, prompts, storage, timers, browser, document, navigator };
}

test('resuming a phone detects missing credentials without a message or automatic redirect', async () => {
  const { app, identity, calls, prompts, browser, document } = fixture();
  document.visibilityState = 'hidden';
  app.sekaiPassAuth.signedIn = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(prompts.length, 0);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  browser.dispatchEvent(new Event('pageshow'));
  app.eventBus.emit('auth:required');
  app.sekaiPassAuth.options.onAuthExpired();
  assert.equal(prompts.length, 1, 'coincident expiry signals share one choice');
  assert.deepEqual(calls, ['pause', 'leave', 'unavailable']);
  await assert.rejects(identity.getAccessToken(), /expired/);
  await prompts[0].onRetry();
  assert.equal(calls.at(-1), 'login', 'only an explicit choice starts OAuth');
});

test('explicit logout clears the account without waiting for push cleanup to reach the network', async () => {
  const { app, browser, calls } = fixture();
  let finish;
  browser.NightcordPWA = { logout: () => new Promise(resolve => { finish = resolve; }) };
  const loggingOut = app.ui.onLogout();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(app.sekaiPassAuth.signedIn, false);
  assert.ok(calls.includes('leave')); assert.ok(calls.includes('unavailable'));
  finish(); await loggingOut;
});

test('the foreground timer checks tokens and server revocation while the user only reads', async () => {
  const { identity, app, calls, prompts, timers } = fixture();
  app.chatRoom.refreshAuthentication = async () => { calls.push('validate'); app.eventBus.emit('auth:required'); };
  const [tick, interval] = [...timers][0];
  assert.equal(interval, 60000);
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('token'));
  assert.ok(calls.includes('validate'));
  assert.equal(prompts.length, 1);
  identity.destroy();
});

test('continue clears stale credentials and restores the guest in the same room only once', async () => {
  const { identity, app, calls, prompts, storage } = fixture();
  app.eventBus.emit('auth:required');
  await prompts[0].onContinue();
  assert.equal(storage.has('nightcord-sekai-session'), false);
  assert.equal(await identity.getAccessToken(), null);
  assert.ok(calls.includes('clear'));
  assert.ok(calls.includes('broadcast'));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'join' && call[1] === 'nightcord-test'));
  await identity.checkSession();
  app.eventBus.emit('auth:required');
  assert.equal(prompts.length, 1);
});

test('a remembered login survives losing every SDK credential and profile across reloads', () => {
  const { prompts, storage } = fixture({ signedIn: false, remembered: true });
  assert.equal(prompts.length, 1);
  assert.equal(storage.get('nightcord-sekai-session'), '1');
});

test('disconnected sessions still validate against Pass, without treating a network failure as logout', async () => {
  const { identity, app, prompts, storage } = fixture();
  app.chatRoom.wsManager.isConnected = () => false;
  app.sekaiPassAuth.getUserInfo = async () => { throw new Error('network or service unavailable'); };
  await identity.checkSession();
  assert.equal(prompts.length, 0);
  assert.equal(storage.get('nightcord-sekai-session'), '1');
  app.sekaiPassAuth.getUserInfo = async () => {
    app.sekaiPassAuth.signedIn = false; // SDK clears credentials on userinfo 401.
    throw new Error('Failed to fetch user info');
  };
  await identity.checkSession();
  assert.equal(prompts.length, 1);
  assert.equal(storage.get('nightcord-sekai-session'), '1');
});

test('first guest use asks for a nickname and retains the startup room', async () => {
  const { app, identity, calls, prompts } = fixture({ signedIn: false, remembered: true, guestName: null });
  app.chatRoom.roomname = null;
  assert.equal(prompts.length, 1, 'a remembered expired login must not silently become a guest');
  await prompts[0].onContinue();
  assert.ok(calls.includes('choose-name'));
  app.chooseName('New visitor');
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'join' && call[1] === 'nightcord-test'));
  assert.equal(identity.sessionExpected, false);
});

test('ordinary guests and an explicit logout never receive an expiry prompt', async () => {
  const guest = fixture({ signedIn: false });
  await guest.identity.checkSession();
  assert.equal(await guest.identity.getAccessToken(), null);
  assert.equal(guest.prompts.length, 0);
  const member = fixture();
  await member.app.ui.onLogout();
  await member.identity.checkSession();
  member.app.sekaiPassAuth.options.onAuthExpired();
  assert.equal(member.prompts.length, 0);
});

test('offline and hidden pages avoid token requests; online resumes checks', async () => {
  const { identity, calls, navigator, document, browser, prompts } = fixture();
  navigator.onLine = false;
  await identity.checkSession();
  navigator.onLine = true;
  document.visibilityState = 'hidden';
  await identity.checkSession();
  assert.deepEqual(calls, []);
  document.visibilityState = 'visible';
  browser.dispatchEvent(new Event('online'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['token', 'validate']);
  assert.equal(prompts.length, 0);
});

test('concurrent resume checks share work and a late failure after logout stays quiet', async () => {
  const { identity, app, calls, prompts } = fixture();
  let reject;
  app.sekaiPassAuth.getAccessToken = () => { calls.push('token'); return new Promise((_, fail) => { reject = fail; }); };
  const pending = identity.checkSession();
  await identity.checkSession();
  assert.deepEqual(calls, ['token']);
  await app.ui.onLogout();
  reject(new Error('old session expired'));
  await pending;
  assert.equal(prompts.length, 0);
});

test('a fresh verified login allows a later expiry to prompt again', () => {
  const { identity, app, prompts } = fixture();
  identity.handleAuthExpired();
  app.eventBus.emit('session:updated', { user: { authenticated: true, displayName: 'Member' } });
  identity.handleAuthExpired();
  assert.equal(prompts.length, 2);
});

test('storage loss is detected but an intentional logout from another tab is respected', async () => {
  const { identity, app, prompts } = fixture();
  app.sekaiPassAuth.signedIn = false;
  identity.onStorage({ key: 'sekai_pass_access_token', newValue: null });
  assert.equal(prompts.length, 1);
  identity.onStorage({ key: 'nightcord-sekai-session', newValue: null });
  await identity.checkSession();
  assert.equal(identity.sessionExpected, false);
  assert.equal(identity.authExpired, false);
  assert.equal(prompts.length, 1);
});

test('destroy removes all resume listeners and the periodic check', async () => {
  const { identity, app, calls, prompts, timers, browser, document } = fixture();
  identity.destroy();
  app.sekaiPassAuth.signedIn = false;
  for (const event of ['pageshow', 'focus', 'online']) browser.dispatchEvent(new Event(event));
  document.dispatchEvent(new Event('visibilitychange'));
  await identity.checkSession();
  assert.equal(timers.size, 0);
  assert.equal(prompts.length, 0);
  assert.deepEqual(calls, []);
});
