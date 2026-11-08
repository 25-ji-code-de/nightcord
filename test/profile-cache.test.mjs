/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function harness() {
  const values = new Map();
  let unavailable = false;
  let now = 1000;
  const localStorage = {
    getItem(key) { if (unavailable) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (unavailable) throw new Error('quota'); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const context = vm.createContext({ window: {}, localStorage, console, Date: { now: () => ++now } });
  vm.runInContext(readFileSync(new URL('../storage-manager.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../ui-manager.js', import.meta.url), 'utf8'), context);
  return {
    values,
    blockStorage() { unavailable = true; },
    createStorage: () => vm.runInContext('new StorageManager()', context),
    createUI(storage) {
      const ui = vm.runInContext('Object.create(UIManager.prototype)', context);
      const listeners = new Map();
      Object.assign(ui, {
        storage, roster: [], messages: [], roomMembers: new Map(),
        eventBus: { on: (name, listener) => listeners.set(name, listener) },
        setupMobileMenu() {}, setupNakoEventListeners() {}, renderVoiceUsers() {},
        addChatMessage(user, text, timestamp, avatar, color, profile) { this.messages.push({ user, text, timestamp, profile }); },
      });
      ui.setupEventListeners();
      return { ui, emit: (name, data) => listeners.get(name)(data) };
    },
  };
}

const profile = (id, displayName, extra = {}) => ({ id, displayName, authenticated: true, ...extra });

test('live profile updates survive departure, history replay and reload without rewriting messages', () => {
  const h = harness();
  const storage = h.createStorage();
  const { ui, emit } = h.createUI(storage);
  const old = profile('sekai:one', '小雨', { bio: '旧签名' });
  const updated = profile(old.id, '晚星', { avatarUrl: 'https://example.com/new.png', bio: '新签名' });
  emit('user:joined', { username: old.displayName, user: old });
  emit('user:profile', { user: updated });
  emit('user:quit', { username: updated.displayName, userId: updated.id });
  emit('message:received', { name: old.displayName, message: '旧消息', timestamp: 10, user: old });
  assert.equal(ui.roster.length, 0);
  assert.equal(ui.messages[0].user, '小雨');
  assert.equal(ui.messages[0].profile.displayName, '小雨');
  const remembered = h.createStorage().getKnownProfile(old.id);
  assert.equal(remembered.displayName, '晚星');
  assert.equal(remembered.bio, '新签名');
  assert.equal(remembered.avatarUrl, updated.avatarUrl);
  emit('session:updated', { user: profile('guest:one', '自己的昵称', { authenticated: false }) });
  assert.equal(storage.getKnownProfile('guest:one').displayName, '自己的昵称');
});

test('same-name identities and observations from other tabs remain separate', () => {
  const h = harness();
  const first = h.createStorage();
  const second = h.createStorage();
  first.rememberProfile(profile('sekai:one', '同名'));
  second.rememberProfile(profile('guest:two', '同名', { authenticated: false }));
  assert.equal(first.getKnownProfile('guest:two').authenticated, false);
  first.rememberProfile(profile('sekai:one', '改名'));
  assert.equal(second.getKnownProfile('sekai:one').displayName, '改名');
  assert.equal(second.getKnownProfile('guest:two').displayName, '同名');
  assert.equal(first.getKnownProfile('sekai:unknown'), null);
  assert.equal(first.getKnownProfile(undefined), null);
});

test('malformed or blocked storage falls back to in-memory observations and only saves public fields', () => {
  const h = harness();
  h.values.set('nightcord-known-profiles', '{broken');
  const storage = h.createStorage();
  assert.equal(storage.getKnownProfile('sekai:one'), null);
  h.values.set('nightcord-known-profiles', JSON.stringify([null, {}, { profile: profile('sekai:bad', 'Bad'), observedAt: 'invalid' }]));
  assert.equal(storage.getKnownProfile('sekai:bad'), null);
  storage.rememberProfile(profile('sekai:one', 'Name', { accessToken: 'never-save', bio: 'Signature' }));
  assert.equal(h.values.get('nightcord-known-profiles').includes('never-save'), false);
  const copy = storage.getKnownProfile('sekai:one');
  copy.displayName = 'Mutated';
  assert.equal(storage.getKnownProfile('sekai:one').displayName, 'Name');
  h.blockStorage();
  storage.rememberProfile(profile('sekai:one', 'New name'));
  assert.equal(storage.getKnownProfile('sekai:one').displayName, 'New name');
});

test('profile history is bounded to the 1000 most recently observed identities', () => {
  const h = harness();
  h.values.set('nightcord-known-profiles', JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({
    profile: profile(`sekai:${i}`, `Name ${i}`), observedAt: i,
  }))));
  const storage = h.createStorage();
  storage.rememberProfile(profile('sekai:0', 'Refreshed'));
  storage.rememberProfile(profile('sekai:new', 'New'));
  const reloaded = h.createStorage();
  assert.equal(reloaded.getKnownProfile('sekai:0').displayName, 'Refreshed');
  assert.equal(reloaded.getKnownProfile('sekai:1'), null);
  assert.equal(JSON.parse(h.values.get('nightcord-known-profiles')).length, 1000);
});
