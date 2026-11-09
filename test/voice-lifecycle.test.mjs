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

function configurePublishing(h) {
  const peers = [];
  h.manager.ice = async () => ({ iceServers: [] }); h.manager.gather = async () => {};
  h.manager.peerFactory = () => {
    const pc = {
      connectionState: 'connected', localDescription: { type: 'offer', sdp: 'v=0\r\n' },
      sender: { getParameters: () => ({}), track: null, async replaceTrack(track) { this.track = track; } },
      addTransceiver(track) { this.sender.track = track; return { mid: '0', sender: this.sender }; },
      createOffer: async () => ({}), setLocalDescription: async () => {},
      async setRemoteDescription(description) { this.remoteDescription = description; },
      getStats: async () => new Map([['audio', { type: 'outbound-rtp', kind: 'audio', packetsSent: 1 }]]),
      addEventListener() {}, close() { this.connectionState = 'closed'; },
    };
    peers.push(pc); return pc;
  };
  h.manager.request = async (action, input, membership) => {
    h.calls.push({ action, input, membership });
    if (action === 'publisher/start') return { operationId: input.mutationId, generation: 1, sessionDescription: { type: 'answer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' } };
    return {};
  };
  return peers;
}
async function publishing({ silence = true } = {}) {
  const h = harness(), stream = capture(), peers = configurePublishing(h);
  if (!silence) h.manager.audioContextFactory = () => { throw new Error('Web Audio unavailable'); };
  const pending = h.manager.microphone(); h.permission.resolve(stream); await pending;
  assert.equal(h.manager.state.microphone, true);
  return { ...h, stream, peers };
}

test('a minute-limit heartbeat closes capture and media and explains the daily limit', async () => {
  const h = await publishing();
  const pc = h.manager.publisher, silence = h.manager.publisherAttempt.silence;
  h.manager.request = async action => {
    if (action === 'heartbeat') throw h.manager.error('voice_daily_limit');
    return {};
  };
  await h.manager.heartbeat();
  assert.equal(h.manager.membership, null); assert.equal(h.manager.state.joined, false);
  assert.equal(h.stream.track.readyState, 'ended'); assert.equal(pc.connectionState, 'closed');
  assert.equal(silence.track.readyState, 'ended'); assert.match(h.manager.state.message, /今日.*时长.*已用尽.*明天/);
  h.manager.destroy();
});

test('a quota departure snapshot stops media immediately and keeps its explanation', async () => {
  const h = await publishing();
  const pc = h.manager.publisher;
  h.manager.applySnapshot({ revision: 10, members: [], departures: [{ memberId: 'member', code: 'voice_monthly_limit' }] });
  assert.equal(h.manager.state.joined, false); assert.equal(pc.connectionState, 'closed');
  assert.match(h.manager.state.message, /本月.*时长.*已用尽.*下个月/);
  h.manager.destroy();
});

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

function gatheringPeer(policy = 'all') {
  const listeners = new Map();
  return {
    iceGatheringState: 'gathering', signalingState: 'have-local-offer', localDescription: { sdp: 'v=0\r\n' },
    getConfiguration: () => ({ iceTransportPolicy: policy }),
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) { listeners.get(name)?.forEach(listener => listener()); },
    candidate(type) { this.localDescription.sdp += `a=candidate:1 1 udp 123 192.0.2.1 5000 typ ${type}\r\n`; this.dispatch('icecandidate'); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

test('adaptive ICE exits with reflected and relay candidates and removes all listeners', async () => {
  const h = harness(), pc = gatheringPeer();
  pc.candidate('host'); pc.candidate('srflx'); pc.candidate('relay');
  assert.equal(await h.manager.gather(pc, 2000), true);
  assert.equal(pc.listenerCount(), 0); h.manager.destroy();
});

test('ICE waits for a late relay and full fallback does not exit at an earlier quiet window', async () => {
  const h = harness(), pc = gatheringPeer('relay'); let settled = false;
  const pending = h.manager.gather(pc, 3000).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(settled, false, 'no timeout just because the initial window elapsed');
  pc.candidate('relay'); assert.equal(await pending, true); assert.equal(pc.listenerCount(), 0);
  const full = h.manager.gather(pc, 1200, { full: true }).then(result => { settled = true; return result; });
  settled = false; await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(settled, false, 'full fallback must keep collecting');
  pc.iceGatheringState = 'complete'; pc.dispatch('icegatheringstatechange');
  assert.equal(await full, false); assert.equal(pc.listenerCount(), 0); h.manager.destroy();
});

test('ICE rejects a closed connection or an empty completed collection and cleans up', async () => {
  const h = harness(), pc = gatheringPeer();
  const pending = h.manager.gather(pc); pc.signalingState = 'closed'; pc.dispatch('signalingstatechange');
  await assert.rejects(pending, error => error.code === 'connection_closed'); assert.equal(pc.listenerCount(), 0);
  pc.signalingState = 'stable'; pc.iceGatheringState = 'complete';
  await assert.rejects(h.manager.gather(pc), error => error.code === 'ice_timeout');
  assert.equal(pc.listenerCount(), 0); h.manager.destroy();
});

test('joining prefetches one credential request without opening a microphone or publisher', async () => {
  const h = harness(), response = deferred();
  h.manager.membership = null; h.manager.state.joined = false; h.manager.ticket = async () => 'ticket';
  h.manager.request = async (action, input, membership) => {
    h.calls.push({ action, input, membership });
    if (action === 'join') return { memberId: 'joined', snapshot: { revision: 1, members: [{ memberId: 'joined', publishing: false }] } };
    if (action === 'ice') return response.promise;
    return {};
  };
  await h.manager.join();
  assert.equal(h.manager.state.joined, true); assert.equal(h.manager.state.busy, false);
  assert.equal(h.audioContexts.length, 0); assert.equal(h.manager.capture, undefined); assert.equal(h.manager.publisher, undefined);
  const duringClick = h.manager.ice(h.manager.membership);
  assert.equal(h.calls.filter(call => call.action === 'ice').length, 1);
  await h.manager.leave(); response.resolve({ iceServers: [], iceExpiresAt: Date.now() + 3600000 }); await duringClick;
  assert.equal(h.manager.iceConfig, null, 'a late prefetch cannot restore credentials after leave');
  assert.ok(!h.calls.some(call => call.action === 'publisher/start')); h.manager.destroy();
});

test('a failed early publisher retries once with a new operation, full ICE and the same capture', async () => {
  for (const failure of ['connection_failed', 'media_timeout']) {
    const h = harness(), peers = configurePublishing(h), stream = capture(), windows = [];
    h.manager.gather = async (pc, timeout, options) => { windows.push(options.full); return !options.full; };
    if (failure === 'connection_failed') h.manager.connected = async pc => { if (pc === peers[0]) throw h.manager.error(failure); };
    else h.manager.mediaFlow = async pc => { if (pc === peers[0]) throw h.manager.error(failure); };
    const pending = h.manager.microphone(); h.permission.resolve(stream); await pending;
    assert.equal(h.manager.state.microphone, true, failure); assert.deepEqual(windows, [false, true], failure);
    assert.equal(peers.length, 2); assert.equal(peers[0].connectionState, 'closed');
    assert.equal(h.manager.capture, stream); assert.equal(stream.track.readyState, 'live');
    assert.equal(h.audioContexts.length, 1); assert.equal(h.audioContexts[0].state, 'running');
    const starts = h.calls.filter(call => call.action === 'publisher/start'), stops = h.calls.filter(call => call.action === 'publisher/stop');
    assert.notEqual(starts[0].input.mutationId, starts[1].input.mutationId);
    assert.equal(stops[0].input.operationId, starts[0].input.mutationId);
    assert.equal(h.calls.filter(call => call.action === 'publisher/ready').length, 1);
    h.manager.destroy(); assert.equal(stream.track.readyState, 'ended'); assert.equal(h.audioContexts[0].state, 'closed');
  }
});

test('a second connection failure or an unknown upstream result never loops allocation', async () => {
  for (const upstream of [false, true]) {
    const h = harness(), peers = configurePublishing(h), stream = capture(), original = h.manager.request;
    h.manager.gather = async () => true;
    h.manager.connected = async () => { throw h.manager.error('connection_failed'); };
    if (upstream) h.manager.request = async (...args) => {
      if (args[0] === 'publisher/start') { h.calls.push({ action: args[0] }); throw h.manager.error('upstream_unavailable'); }
      return original(...args);
    };
    const pending = h.manager.microphone(); h.permission.resolve(stream); await pending;
    assert.equal(h.manager.state.microphone, false); assert.equal(h.manager.publisher, null);
    assert.equal(stream.track.readyState, 'ended'); assert.ok(peers.every(pc => pc.connectionState === 'closed'));
    assert.equal(h.calls.filter(call => call.action === 'publisher/start').length, upstream ? 1 : 2);
    h.manager.destroy();
  }
});

test('canceling during full publisher fallback stops the capture and fences delayed work', async () => {
  const h = harness(), peers = configurePublishing(h), stream = capture(), waiting = deferred(), continueFull = deferred();
  h.manager.gather = async (pc, timeout, { full }) => { if (full) { waiting.resolve(); await continueFull.promise; } return true; };
  h.manager.connected = async pc => { if (pc === peers[0]) throw h.manager.error('connection_failed'); };
  const pending = h.manager.microphone(); h.permission.resolve(stream); await waiting.promise;
  h.manager.mute(); assert.equal(stream.track.readyState, 'ended');
  continueFull.resolve(); await pending;
  assert.equal(h.manager.publisher, null); assert.equal(h.manager.state.microphone, false);
  assert.equal(h.calls.filter(call => call.action === 'publisher/start').length, 1);
  assert.equal(h.audioContexts[0].state, 'closed'); h.manager.destroy();
});

test('device enumeration does not delay microphone readiness or turn a working microphone off', async () => {
  const h = harness(), peers = configurePublishing(h), stream = capture(), response = deferred();
  h.manager.mediaDevices.enumerateDevices = () => response.promise;
  const pending = h.manager.microphone(); h.permission.resolve(stream); await pending;
  assert.equal(h.manager.state.microphone, true); assert.equal(h.manager.capturePending, false);
  response.resolve(Promise.reject(new Error('device labels unavailable')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.manager.state.microphone, true); assert.equal(peers[0].connectionState, 'connected'); h.manager.destroy();
});

test('allocation waits for confirmed cleanup using new IDs and stops retrying when canceled', async () => {
  const h = harness(), attempts = [];
  h.manager.request = async (action, input) => {
    attempts.push(input.mutationId);
    if (attempts.length === 1) throw h.manager.error('cleanup_pending');
    return { operationId: input.mutationId };
  };
  const attempt = { operationId: crypto.randomUUID() };
  const result = await h.manager.allocate('publisher/start', {}, h.manager.membership, () => true, attempt);
  assert.equal(attempts.length, 2); assert.notEqual(attempts[0], attempts[1]); assert.equal(result.operationId, attempts[1]);
  assert.equal(attempt.activeOperationId, attempts[1]);
  let current = true;
  h.manager.request = async () => { current = false; throw h.manager.error('operation_busy'); };
  await assert.rejects(h.manager.allocate('publisher/start', {}, h.manager.membership, () => current, attempt), error => error.code === 'operation_busy');
  assert.equal(attempt.started, false);
  h.manager.destroy();
});

test('an early receiver failure retries full candidates once and closes the replaced receiver', async () => {
  const h = harness(), peers = [], windows = [];
  h.manager.peerFactory = () => {
    const pc = { connectionState: 'connected', addEventListener() {}, setRemoteDescription: async () => {},
      createAnswer: async () => ({}), setLocalDescription: async () => {}, localDescription: {},
      close() { this.connectionState = 'closed'; } };
    peers.push(pc); return pc;
  };
  h.manager.request = async (action, input) => {
    h.calls.push({ action, input });
    return { sessionDescription: {}, tracks: [], operationId: input.mutationId, generation: h.calls.length };
  };
  h.manager.gather = async (pc, timeout, { full }) => { windows.push(full); return !full; };
  h.manager.connected = async pc => { if (pc === peers[0]) throw h.manager.error('connection_failed'); };
  h.manager.mediaFlow = async () => {};
  await h.manager.receive(h.manager.membership, [{ memberId: 'other' }], { iceServers: [] });
  assert.deepEqual(windows, [false, true]); assert.equal(peers[0].connectionState, 'closed');
  assert.equal(h.manager.receiver, peers[1]);
  const requests = h.calls.filter(call => call.action === 'subscriptions');
  assert.equal(requests.length, 2); assert.notEqual(requests[0].input.mutationId, requests[1].input.mutationId);
  h.manager.destroy();
});
