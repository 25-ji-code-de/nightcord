/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function capture() {
  const track = { kind: 'audio', readyState: 'live', stopped: false, enabled: true, stop() { this.stopped = true; this.readyState = 'ended'; }, addEventListener() {} };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function harness() {
  const audioContexts = [];
  class AudioContext {
    constructor() { this.state = 'running'; audioContexts.push(this); }
    createMediaStreamDestination() { this.stream = capture(); return { stream: this.stream }; }
    createConstantSource() { return { offset: { value: 1 }, connect() {}, start() {}, stop() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    addEventListener(name, listener) { if (name === 'statechange') this.stateChanged = listener; }
  }
  const context = vm.createContext({ crypto, AbortSignal, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval, AudioContext, navigator: {}, document: { hidden: false }, RTCPeerConnection: class {} });
  for (const file of ['event-bus.js', 'voice-manager.js']) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  const bus = vm.runInContext('new EventBus()', context);
  const chat = { roomname: 'test', currentUser: { authenticated: true, id: 'one' }, wsManager: { hostname: 'chat.test' } };
  const permission = deferred(), calls = [];
  const manager = vm.runInContext('new VoiceManager({eventBus:globalThis.bus,chatRoom:globalThis.chat,mediaDevices:globalThis.media,peerFactory:globalThis.peer})', Object.assign(context, {
    bus, chat, media: { getUserMedia: () => permission.promise, enumerateDevices: async () => [] }, peer: () => { throw new Error('unexpected peer'); },
  }));
  manager.request = async (action, input, membership) => { calls.push({ action, input, membership }); return {}; };
  manager.membership = { memberId: 'member', base: 'https://chat.test/voice', token: 'secret' };
  manager.state.joined = true;
  return { manager, bus, chat, permission, calls, audioContexts };
}

async function publishing({ silence = true } = {}) {
  const h = harness(), stream = capture(), peers = [];
  if (!silence) h.manager.audioContextFactory = () => { throw new Error('Web Audio unavailable'); };
  h.manager.ice = async () => ({ iceServers: [] }); h.manager.gather = async () => {};
  h.manager.peerFactory = () => {
    const pc = {
      connectionState: 'connected', localDescription: { type: 'offer', sdp: 'v=0\r\n' },
      sender: { getParameters: () => ({}), track: null, async replaceTrack(track) { this.track = track; } },
      addTransceiver(track) { this.sender.track = track; return { mid: '0', sender: this.sender }; },
      createOffer: async () => ({}), setLocalDescription: async () => {},
      async setRemoteDescription(description) { this.remoteDescription = description; },
      addEventListener() {}, close() { this.connectionState = 'closed'; },
    };
    peers.push(pc); return pc;
  };
  h.manager.request = async (action, input, membership) => {
    h.calls.push({ action, input, membership });
    if (action === 'publisher/start') return { operationId: input.mutationId, generation: 1, sessionDescription: { type: 'answer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' } };
    return {};
  };
  const pending = h.manager.microphone(); h.permission.resolve(stream); await pending;
  assert.equal(h.manager.state.microphone, true);
  return { ...h, stream, peers };
}

test('mute stops real capture and reopening reuses publisher, operation and DTX silence', async () => {
  const h = await publishing();
  const pc = h.manager.publisher, attempt = h.manager.publisherAttempt;
  assert.match(pc.remoteDescription.sdp, /useinbandfec=1;usedtx=1/);
  h.manager.mute(); await attempt.replacing;
  assert.equal(h.stream.track.readyState, 'ended'); assert.equal(h.manager.capture, null);
  assert.equal(pc.sender.track, attempt.silence.track); assert.equal(pc.connectionState, 'connected');
  const resumed = capture(); h.manager.mediaDevices.getUserMedia = async () => resumed;
  await h.manager.microphone();
  assert.equal(h.manager.publisher, pc); assert.equal(pc.sender.track, resumed.track);
  assert.equal(h.manager.state.microphone, true); assert.equal(h.peers.length, 1);
  assert.deepEqual(h.calls.filter(call => call.action === 'publisher/state').map(call => [call.input.sequence, call.input.microphone]), [[1, false], [2, true]]);
  assert.equal(h.calls.filter(call => call.action === 'publisher/start').length, 1);
  assert.equal(h.calls.filter(call => call.action === 'publisher/stop').length, 0);
  await h.manager.leave();
  assert.equal(resumed.track.readyState, 'ended'); assert.equal(attempt.silence.track.readyState, 'ended');
  assert.equal(attempt.silence.context.state, 'closed'); assert.equal(pc.connectionState, 'closed');
});

test('canceling a warm microphone prompt leaves silence and stops the late capture', async () => {
  const h = await publishing(); h.manager.mute();
  const attempt = h.manager.publisherAttempt, permission = deferred(), stream = capture();
  h.manager.mediaDevices.getUserMedia = () => permission.promise;
  const pending = h.manager.microphone(); h.manager.mute();
  permission.resolve(stream); await pending; await attempt.replacing;
  assert.equal(stream.track.readyState, 'ended'); assert.equal(h.manager.state.microphone, false);
  assert.equal(attempt.sender.track, attempt.silence.track);
  assert.ok(h.calls.filter(call => call.action === 'publisher/state').every(call => !call.input.microphone));
  h.manager.destroy();
});

test('mute wins a delayed warm track replacement and a newer unmute can follow it', async () => {
  const h = await publishing(); h.manager.mute(); await h.manager.publisherAttempt.replacing;
  const attempt = h.manager.publisherAttempt, response = deferred(), replacing = deferred(), stream = capture();
  h.manager.mediaDevices.getUserMedia = async () => stream;
  attempt.sender.replaceTrack = async function (track) {
    if (track === stream.track) { replacing.resolve(); await response.promise; }
    this.track = track;
  };
  const pending = h.manager.microphone(); await replacing.promise;
  h.manager.mute(); response.resolve(); await pending; await attempt.replacing;
  assert.equal(stream.track.readyState, 'ended'); assert.equal(attempt.sender.track, attempt.silence.track);
  assert.equal(h.manager.state.microphone, false);
  const newer = capture(); h.manager.mediaDevices.getUserMedia = async () => newer;
  await h.manager.microphone(); assert.equal(attempt.sender.track, newer.track);
  assert.equal(h.manager.state.microphone, true); h.manager.destroy();
});

test('an old mute sync failure also stops a newer capture before dropping that shared publisher', async () => {
  const h = await publishing(), response = deferred(), original = h.manager.request;
  h.manager.request = async (...args) => args[0] === 'publisher/state' && !args[1].microphone ? response.promise : original(...args);
  h.manager.mute();
  const resumed = capture(); h.manager.mediaDevices.getUserMedia = async () => resumed;
  await h.manager.microphone(); assert.equal(h.manager.state.microphone, true);
  response.resolve(Promise.reject(Object.assign(new Error('network'), { code: 'upstream_unavailable' })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed.track.readyState, 'ended'); assert.equal(h.manager.state.microphone, false);
  assert.equal(h.manager.publisher, null); h.manager.destroy();
});

test('suspended silence falls back to releasing the publication instead of keeping a dead audio graph', async () => {
  const h = await publishing(); h.manager.mute();
  const attempt = h.manager.publisherAttempt;
  attempt.silence.context.state = 'suspended'; attempt.silence.context.stateChanged();
  assert.equal(h.manager.publisher, null); assert.equal(attempt.pc.connectionState, 'closed');
  assert.equal(attempt.silence.track.readyState, 'ended'); h.manager.destroy();
});

test('without Web Audio, mute stops capture and retires the publisher before a cold reopen', async () => {
  const h = await publishing({ silence: false }), old = h.manager.publisher;
  h.manager.mute();
  assert.equal(h.stream.track.readyState, 'ended'); assert.equal(old.connectionState, 'closed');
  assert.equal(h.manager.publisher, null);
  const resumed = capture(); h.manager.mediaDevices.getUserMedia = async () => resumed;
  await h.manager.microphone();
  assert.equal(h.manager.state.microphone, true); assert.notEqual(h.manager.publisher, old);
  assert.equal(h.calls.filter(call => call.action === 'publisher/start').length, 2);
  assert.equal(h.calls.filter(call => call.action === 'publisher/stop').length, 1);
  h.manager.destroy();
});

test('room and identity changes close a warm publisher and reject a late warm capture', async () => {
  for (const event of ['room:joining', 'room:left', 'auth:required', 'session:updated']) {
    const h = await publishing(), attempt = h.manager.publisherAttempt;
    h.manager.identity = 'one'; h.manager.mute();
    const permission = deferred(), stream = capture();
    h.manager.mediaDevices.getUserMedia = () => permission.promise;
    const pending = h.manager.microphone();
    h.bus.emit(event, { user: { id: 'other' } });
    assert.equal(h.manager.membership, null, event); assert.equal(attempt.pc.connectionState, 'closed', event);
    assert.equal(attempt.silence.context.state, 'closed', event); assert.equal(attempt.silence.track.readyState, 'ended', event);
    permission.resolve(stream); await pending;
    assert.equal(stream.track.readyState, 'ended', event); assert.equal(h.manager.capture, null, event);
    assert.ok(h.calls.filter(call => call.action === 'publisher/state').every(call => !call.input.microphone), event);
    h.manager.destroy();
  }
});

test('canceling a pending microphone prompt stops the late stream without publishing', async () => {
  const h = harness(), stream = capture();
  const pending = h.manager.microphone();
  h.manager.mute(); h.permission.resolve(stream); await pending;
  assert.ok(stream.track.stopped);
  assert.equal(h.manager.state.microphone, false);
  assert.ok(!h.calls.some(call => call.action === 'publisher/start'));
  h.manager.destroy();
});

test('room and identity changes stop capture immediately, including late permission responses', async () => {
  for (const event of ['room:joining', 'room:left', 'auth:required', 'session:updated']) {
    const h = harness(), stream = capture();
    h.manager.identity = 'one';
    const pending = h.manager.microphone();
    h.bus.emit(event, { user: { id: 'other' } });
    assert.equal(h.manager.membership, null, event);
    h.permission.resolve(stream); await pending;
    assert.ok(stream.track.stopped, event);
    assert.ok(!h.calls.some(call => call.action === 'publisher/start'), event);
    h.manager.destroy();
  }
});

test('leaving while a join response is delayed does not restore membership', async () => {
  const h = harness(), joined = deferred(), started = deferred();
  h.manager.membership = null; h.manager.state.joined = false;
  h.manager.ticket = async () => 'ticket';
  h.manager.request = async (action, input, membership) => {
    h.calls.push({ action, membership });
    if (action === 'join') { started.resolve(); return joined.promise; }
    return {};
  };
  const pending = h.manager.join();
  await started.promise;
  await h.manager.leave();
  joined.resolve({ memberId: 'late' }); await pending;
  assert.equal(h.manager.membership, null);
  assert.equal(h.manager.state.joined, false);
  assert.ok(h.calls.some(call => call.action === 'leave' && call.membership.token));
  h.manager.destroy();
});

test('stopping a delayed publication targets its original operation after a newer mic attempt', async () => {
  const h = harness(), stream = capture(), response = deferred(), started = deferred();
  h.manager.ice = async () => ({ iceServers: [] });
  h.manager.gather = async () => {};
  h.manager.peerFactory = () => ({
    addTransceiver: () => ({ mid: '0', sender: { getParameters: () => ({}) } }),
    createOffer: async () => ({}), setLocalDescription: async () => {}, localDescription: {}, close() {},
  });
  h.manager.request = async (action, input) => { h.calls.push({ action, input }); if (action === 'publisher/start') { started.resolve(); return response.promise; } return {}; };
  const pending = h.manager.microphone(); h.permission.resolve(stream);
  await started.promise;
  const original = h.calls.find(call => call.action === 'publisher/start').input.mutationId;
  h.manager.mute();
  h.manager.publisherAttempt = { membership: h.manager.membership, operationId: 'newer-publication' };
  response.resolve({}); await pending;
  assert.ok(stream.track.stopped);
  assert.ok(h.calls.filter(call => call.action === 'publisher/stop').every(call => call.input.operationId === original));
  h.manager.destroy();
});

test('simultaneous publishing and listening share one in-flight ICE credential request', async () => {
  const h = harness(), response = deferred();
  h.manager.request = async action => { h.calls.push({ action }); return action === 'ice' ? response.promise : {}; };
  const publisher = h.manager.ice(h.manager.membership), receiver = h.manager.ice(h.manager.membership);
  assert.equal(h.calls.filter(call => call.action === 'ice').length, 1);
  response.resolve({ iceServers: [], iceExpiresAt: Date.now() + 3600000 });
  assert.equal(await publisher, await receiver);
  h.manager.destroy();
});

test('bounded ICE gathering uses available candidates and rejects an empty description', async () => {
  const h = harness();
  const pc = { iceGatheringState: 'gathering', signalingState: 'have-local-offer', addEventListener() {}, removeEventListener() {}, localDescription: { sdp: 'v=0\r\na=candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host\r\n' } };
  await h.manager.gather(pc, 1);
  pc.localDescription.sdp = 'v=0\r\n';
  await assert.rejects(h.manager.gather(pc, 1), error => error.code === 'ice_timeout');
  h.manager.destroy();
});
