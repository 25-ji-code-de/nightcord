/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const flush = () => new Promise(resolve => setImmediate(resolve));
const blocked = () => Object.assign(new Error('User interaction required'), { name: 'NotAllowedError' });

function harness({ opus = true, play = () => Promise.resolve(), preferences = {} } = {}) {
  const calls = [], listeners = new Map();
  const document = {
    addEventListener(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    removeEventListener(event, listener) { listeners.get(event)?.delete(listener); }
  };
  class Audio {
    constructor(src) { this.src = src; this.paused = true; }
    canPlayType() { return opus ? 'probably' : ''; }
    cloneNode() { return new Audio(this.src); }
    play() { calls.push(this); this.paused = false; return play(this); }
    pause() { this.paused = true; }
  }
  const context = vm.createContext({ Audio, document, console });
  for (const file of ['event-bus.js', 'js/ui/voice-sounds.js']) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  }
  const bus = vm.runInContext('new EventBus()', context);
  context.bus = bus;
  context.preferences = preferences;
  const sounds = vm.runInContext('new VoiceSounds(bus, () => preferences)', context);
  const gesture = (event = 'click', isTrusted = true) => {
    for (const listener of [...(listeners.get(event) || [])]) listener({ isTrusted });
  };
  const waiting = () => [...listeners.values()].reduce((total, set) => total + set.size, 0);
  return { bus, sounds, calls, gesture, waiting };
}

test('effect preferences apply to entry and voice sounds, including a pending autoplay retry', async () => {
  const preferences = { effects: false, volume: .25 };
  const h = harness({ preferences });
  h.bus.emit('room:ready'); h.bus.emit('voice:changed', { joined: true, members: [] });
  assert.equal(h.calls.length, 0);
  preferences.effects = true;
  h.bus.emit('room:joining'); h.bus.emit('room:ready');
  assert.equal(h.calls[0].volume, .25);
  preferences.pausedUntil = Date.now() + 60000;
  h.bus.emit('voice:changed', { joined: false });
  assert.equal(h.calls.length, 1);
  h.sounds.destroy();
  const retry = harness({ preferences: { effects: true }, play: () => Promise.reject(blocked()) });
  retry.bus.emit('room:ready'); await flush();
  retry.sounds.getPreferences = () => ({ effects: false });
  retry.gesture();
  assert.equal(retry.calls.length, 1); assert.equal(retry.waiting(), 0);
  retry.sounds.destroy();
});

test('successful entry plays its own cue once; reconnects and presence updates stay silent', async () => {
  const h = harness();
  h.bus.emit('room:joining');
  h.bus.emit('connection:open');
  h.bus.emit('user:joined', { username: 'someone' });
  assert.equal(h.calls.length, 0);
  h.bus.emit('room:ready');
  h.bus.emit('room:ready');
  h.bus.emit('connection:close');
  h.bus.emit('roster:clear');
  h.bus.emit('connection:open');
  h.bus.emit('room:synced');
  h.bus.emit('user:quit', { username: 'someone' });
  await flush();
  assert.deepEqual(h.calls.map(audio => audio.src), ['se_nightcord_enter.opus']);
  assert.equal(h.waiting(), 0);
  h.bus.emit('room:joining');
  assert.equal(h.calls[0].paused, true);
  h.bus.emit('room:ready');
  assert.equal(h.calls.length, 2);
  h.sounds.destroy();
});

for (const event of ['click', 'keydown']) {
  test(`autoplay denial retries on a trusted ${event}, without duplicate playback`, async () => {
    let allowed = false;
    const h = harness({ play: () => allowed ? Promise.resolve() : Promise.reject(blocked()) });
    h.bus.emit('room:ready');
    await flush();
    assert.ok(h.waiting() > 0);
    h.gesture(event, false);
    assert.equal(h.calls.length, 1);
    allowed = true;
    h.gesture(event);
    h.gesture('click');
    h.gesture('keydown');
    await flush();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0], h.calls[1], 'retry the blocked entry, without cloning extra cues');
    assert.equal(h.waiting(), 0);
    h.sounds.destroy();
  });
}

test('repeated autoplay denial keeps just one cue pending', async () => {
  const h = harness({ play: () => Promise.reject(blocked()) });
  h.bus.emit('room:ready');
  await flush();
  h.gesture();
  await flush();
  h.bus.emit('room:ready');
  assert.equal(h.calls.length, 2);
  assert.equal(h.waiting(), 2);
  h.sounds.destroy();
  assert.equal(h.waiting(), 0);
});

for (const action of ['room:left', 'room:joining', 'destroy']) {
  test(`${action} cancels both queued playback and late autoplay rejection`, async () => {
    for (const alreadyRejected of [false, true]) {
      let reject;
      const h = harness({ play: () => new Promise((_, fail) => { reject = fail; }) });
      h.bus.emit('room:ready');
      if (alreadyRejected) { reject(blocked()); await flush(); }
      if (action === 'destroy') h.sounds.destroy();
      else h.bus.emit(action);
      if (!alreadyRejected) { reject(blocked()); await flush(); }
      h.gesture();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].paused, true);
      assert.equal(h.waiting(), 0);
      if (action === 'destroy') {
        h.bus.emit('room:ready');
        h.bus.emit('voice:changed', { joined: true, members: [] });
        assert.equal(h.calls.length, 1);
      } else h.sounds.destroy();
    }
  });
}

test('MP3 fallback works and media errors do not retry on every interaction', async () => {
  const h = harness({ opus: false, play: () => Promise.reject(new Error('Decode failed')) });
  h.bus.emit('room:ready');
  await flush();
  h.gesture();
  assert.equal(h.calls[0].src, 'se_nightcord_enter.mp3');
  assert.equal(h.calls.length, 1);
  assert.equal(h.waiting(), 0);
  h.sounds.destroy();
});

test('entry audio preserves voice membership sounds and partial-state guards', () => {
  const h = harness();
  for (const state of [undefined, {}, { joined: true }]) h.bus.emit('voice:changed', state);
  h.bus.emit('voice:changed', { joined: true, members: [{ memberId: 'me' }] });
  h.bus.emit('voice:changed', { joined: true, members: [{ memberId: 'me' }] });
  h.bus.emit('voice:changed', { joined: true, members: [{ memberId: 'me' }, { memberId: 'other' }] });
  h.bus.emit('voice:changed', { joined: true, members: [{ memberId: 'me' }] });
  h.bus.emit('voice:changed', { joined: false });
  assert.deepEqual(h.calls.map(audio => audio.src), [
    'se_cord.opus?v=2', 'se_cord.opus?v=2', 'se_dcord.opus?v=2', 'se_dcord.opus?v=2'
  ]);
  h.sounds.destroy();
});
