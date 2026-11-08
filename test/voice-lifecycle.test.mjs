/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function capture() {
  const track = { stopped: false, enabled: true, stop() { this.stopped = true; }, addEventListener() {} };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function harness() {
  const context = vm.createContext({ crypto, AbortSignal, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {}, document: { hidden: false }, RTCPeerConnection: class {} });
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
  return { manager, bus, chat, permission, calls };
}

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
