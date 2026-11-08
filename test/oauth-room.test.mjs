/* SPDX-License-Identifier: AGPL-3.0-only */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture({ savedRoom = 'nightcord-test', failed = false, search = '?code=C&state=S' } = {}) {
  const storage = new Map(savedRoom ? [['nightcord-oauth-room', savedRoom]] : []);
  const calls = [];
  const sandbox = {
    console: { error() {} }, URLSearchParams,
    sessionStorage: { getItem: k => storage.get(k), removeItem: k => storage.delete(k) },
    document: { title: 'Nightcord' },
    window: {
      location: { search }, describeAuthError: e => ({ message: e.message }),
      history: { replaceState: (_state, _title, path) => calls.push(['url', path]) },
    },
    SekaiAnalytics: class {},
  };
  const Nightcord = vm.runInNewContext(readFileSync(new URL('../nightcord.js', import.meta.url), 'utf8') + '\nNightcord', sandbox);
  const app = Object.create(Nightcord.prototype);
  Object.assign(app, {
    sekaiPassAuth: {
      async handleCallback() { if (failed) throw new Error('access_denied'); return { name: 'Test account' }; },
    },
    chatRoom: { setUser: name => calls.push(['user', name]) },
    ui: { showAuthError: () => calls.push(['error']) },
    joinRoom: room => calls.push(['join', room]),
    broadcastIdentityChange() {},
    init: room => calls.push(['init', room]),
    state: {},
  });
  return { app, storage, calls, Nightcord };
}

test('OAuth success returns to test and keeps refreshes in test', async () => {
  const { app, calls, storage } = fixture();
  await app.handleOAuthCallback();
  assert.ok(calls.some(([action, value]) => action === 'join' && value === 'nightcord-test'));
  assert.ok(calls.some(([action, value]) => action === 'url' && value === '/?test'));
  assert.equal(storage.has('nightcord-oauth-room'), false);
});

test('OAuth rejection restores the same room before showing the chooser', async () => {
  const { app, calls } = fixture({ failed: true });
  await app.handleOAuthCallback();
  assert.deepEqual(calls.map(c => c.slice()), [['error'], ['url', '/?test'], ['init', 'nightcord-test']]);
  assert.equal(calls.some(([action]) => action === 'join'), false);
});

test('unrecognized stored destinations cannot change the default room', async () => {
  const { app, calls } = fixture({ savedRoom: 'https://example.com/' });
  await app.handleOAuthCallback();
  assert.ok(calls.some(([action, value]) => action === 'url' && value === '/'));
  assert.ok(calls.some(([action, value]) => action === 'join' && value === 'nightcord-default'));
});

test('OAuth error callbacks enter the error handler even without code and state', () => {
  const { app, calls, Nightcord } = fixture({ search: '?error=access_denied' });
  app.handleOAuthCallback = room => calls.push(['callback', room]);
  Nightcord.prototype.init.call(app, 'nightcord-test');
  assert.deepEqual(calls, [['callback', 'nightcord-test']]);
});
