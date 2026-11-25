/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRuntime } from './runtime.mjs';

const origin = 'https://nightcord.de5.net';
const offer = { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendonly\r\na=rtpmap:111 opus/48000/2\r\n' };
const answer = { type: 'answer', sdp: offer.sdp.replace('sendonly', 'recvonly') };
const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export async function fixture(options = {}) {
  const provider = { sessions: new Map(), calls: [], allocations: 0, failClose: false, partial: false, hold: null, revoked: [] };
  const outboundService = async request => {
    assert.equal(new URL(request.url).hostname, 'rtc.live.cloudflare.com');
    const path = new URL(request.url).pathname;
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => ({}));
    provider.calls.push({ path, body, method: request.method });
    const intercepted = await options.intercept?.({ request, path, body, provider });
    if (intercepted) return intercepted;
    if (path.endsWith('/generate-ice-servers')) return Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: `fixture-user-${crypto.randomUUID()}`, credential: 'fixture-credential' }] }, { status: 201 });
    if (path.endsWith('/revoke')) { provider.revoked.push(path); return new Response(null, { status: 204 }); }
    if (path.endsWith('/sessions/new')) { const sessionId = `fixture-${++provider.allocations}`; provider.sessions.set(sessionId, []); return Response.json({ sessionId }); }
    const match = /\/sessions\/([^/]+)(.*)/.exec(path);
    assert.ok(match, path);
    const [, sessionId, operation] = match;
    if (!operation) return Response.json({ tracks: provider.sessions.get(sessionId) });
    if (operation === '/tracks/new') {
      const tracks = body.tracks.map((track, index) => ({ ...track, mid: String(index), status: 'active' }));
      provider.sessions.set(sessionId, tracks);
      if (provider.hold) { const hold = provider.hold; provider.hold = null; await hold; }
      const remote = body.tracks[0].location === 'remote';
      return Response.json({ tracks: tracks.map((track, index) => provider.partial && index === 0 ? { ...track, errorCode: 'internal_error' } : track), sessionDescription: remote ? { ...offer, sdp: offer.sdp.replace('sendonly', 'sendonly') } : answer, requiresImmediateRenegotiation: remote });
    }
    if (operation === '/renegotiate') return Response.json({});
    if (operation === '/tracks/close') {
      if (provider.failClose) return Response.json({ tracks: body.tracks.map(track => ({ ...track, errorCode: 'internal_error' })) });
      const mids = new Set(body.tracks.map(track => track.mid));
      provider.sessions.set(sessionId, provider.sessions.get(sessionId).map(track => mids.has(track.mid) ? { ...track, status: 'inactive' } : track));
      return Response.json({ tracks: body.tracks });
    }
    assert.fail(path);
  };
  const runtime = createRuntime({}, {
    inspectDurableObjects: true, ...(options.script ? { script: options.script } : {}),
    bindings: {
      VOICE_MODE: 'on', VOICE_ALLOWED_ROOMS: 'voice-test,other-test', REALTIME_SFU_APP_ID: 'fixture-app',
      REALTIME_SFU_APP_SECRET: 'fixture-secret', REALTIME_TURN_KEY_ID: 'fixture-key', REALTIME_TURN_API_TOKEN: 'fixture-token', ...options.bindings,
    }, identities: { 'Bearer one': 'one', 'Bearer two': 'two', 'Bearer three': 'three', ...options.identities }, outboundService,
  });
  const base = String(await runtime.ready).replace(/\/$/, '');
  const sockets = [];
  async function connect(identity = 'one', room = 'voice-test', options = {}) {
    let cookie = options.cookie || '';
    if (identity === null && options.cookie === undefined) {
      const response = await fetch(`${base}/api/guest/session`, { method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': `fixture-${crypto.randomUUID()}` } });
      assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0];
    }
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/room/${room}/websocket`, { headers: { Origin: origin, Cookie: cookie, 'CF-Connecting-IP': `fixture-${crypto.randomUUID()}` } });
    sockets.push(socket);
    const messages = [];
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await once(socket, 'open'); socket.send(JSON.stringify(identity === null ? { name: 'Guest fixture', user: { id: 'sekai:forged', authenticated: true } } : { accessToken: identity }));
    async function wait(predicate) {
      for (let attempt = 0; attempt < 150; attempt++) { const value = messages.find(predicate); if (value) return value; await delay(20); }
      assert.fail(`Missing frame (${messages.map(frame => frame.type || Object.keys(frame)[0]).join(', ')})`);
    }
    if (options.ready !== false) await wait(value => value.ready);
    const client = { socket, messages, cookie, wait, async ticketResult() {
      const requestId = crypto.randomUUID(); socket.send(JSON.stringify({ type: 'voice:ticket', requestId }));
      return wait(value => value.requestId === requestId);
    }, async ticket() { const result = await this.ticketResult(); assert.ok(result.ticket, result.code); return result.ticket; } };
    return client;
  }
  async function api(action, credential, input = {}, room = 'voice-test') {
    const response = await fetch(`${base}/api/room/${room}/voice/${action}`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  }
  async function join(client, room = 'voice-test') {
    const credential = token(), input = { ticket: await client.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() };
    const result = await api('join', credential, input, room); assert.equal(result.status, 200, JSON.stringify(result.value));
    return { credential, input, ...result.value };
  }
  return { runtime, provider, connect, api, join, base, async close() { sockets.forEach(socket => socket.terminate()); await runtime.dispose(); } };
}

export { origin, offer, answer, token };
