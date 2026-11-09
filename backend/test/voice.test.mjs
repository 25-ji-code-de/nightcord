/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRuntime } from './runtime.mjs';
import { quotaPeriods } from '../src/voice/quota-policy.ts';

const origin = 'https://nightcord.de5.net';
const offer = { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendonly\r\na=rtpmap:111 opus/48000/2\r\n' };
const answer = { type: 'answer', sdp: offer.sdp.replace('sendonly', 'recvonly') };
const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

async function fixture(options = {}) {
  const provider = { sessions: new Map(), calls: [], allocations: 0, failClose: false, partial: false, hold: null, revoked: [] };
  const outboundService = async request => {
    assert.equal(new URL(request.url).hostname, 'rtc.live.cloudflare.com');
    const path = new URL(request.url).pathname;
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => ({}));
    provider.calls.push({ path, body, method: request.method });
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
    inspectDurableObjects: true,
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

test('voice authorization, join idempotency, SFU publish/subscribe ordering, and cleanup', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const one = await f.connect('one'), two = await f.connect('two');
    const a = await f.join(one), b = await f.join(two);
    const duplicate = await f.api('join', a.credential, a.input);
    assert.equal(duplicate.value.memberId, a.memberId);
    assert.equal((await f.api('join', token(), a.input)).status, 401, 'one-use ticket cannot create another member');
    assert.equal((await f.api('heartbeat', a.credential, {}, 'other-test')).status, 401);
    const ice = await f.api('ice', a.credential); assert.equal(ice.status, 200);
    const startBody = { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer };
    const start = await f.api('publisher/start', a.credential, startBody); assert.equal(start.status, 200, JSON.stringify(start.value));
    const again = await f.api('publisher/start', a.credential, startBody);
    assert.equal(again.value.generation, start.value.generation); assert.equal(f.provider.allocations, 1);
    const readyBody = { mutationId: crypto.randomUUID(), operationId: start.value.operationId, generation: start.value.generation };
    const ready = await f.api('publisher/ready', a.credential, readyBody); assert.equal(ready.status, 200);
    assert.ok(ready.value.snapshot.members.find(member => member.memberId === a.memberId).publishing);
    assert.equal((await f.api('publisher/ready', b.credential, readyBody)).status, 409, 'other member cannot complete publisher operation');
    const pullBody = { mutationId: crypto.randomUUID(), memberIds: [a.memberId] };
    const pull = await f.api('subscriptions', b.credential, pullBody); assert.equal(pull.status, 200, JSON.stringify(pull.value));
    assert.equal(pull.value.tracks[0].memberId, a.memberId);
    await delay(450);
    const replacement = await f.api('subscriptions', b.credential, { ...pullBody, mutationId: crypto.randomUUID() });
    assert.equal(replacement.status, 200, 'abandoned receiver offer can be replaced without waiting for its alarm');
    assert.equal((await f.api('renegotiate', b.credential, { operationId: pull.value.operationId, generation: pull.value.generation, sessionDescription: answer, mutationId: crypto.randomUUID() })).value.code, 'stale_generation');
    const negotiated = await f.api('renegotiate', b.credential, { operationId: replacement.value.operationId, generation: replacement.value.generation, sessionDescription: answer, mutationId: crypto.randomUUID() });
    assert.equal(negotiated.status, 200, JSON.stringify(negotiated.value));
    assert.equal((await f.api('publisher/start', a.credential, startBody)).value.operationId, start.value.operationId, 'cached result survives subsequent operations');
    const left = await f.api('leave', a.credential); assert.equal(left.status, 200);
    await delay(150);
    assert.ok(f.provider.sessions.get('fixture-1').every(track => track.status === 'inactive'));
    assert.ok(f.provider.revoked.length);
    assert.equal((await f.api('heartbeat', a.credential)).status, 401);
    assert.equal((await f.api('leave', b.credential)).status, 200);
    await delay(150);
    assert.ok([...f.provider.sessions.values()].flat().every(track => track.status === 'inactive'));
    assert.ok(!one.messages.some(frame => frame.message?.includes('fixture-secret')));
  } finally { await f.close(); }
});

test('microphone state is ordered, owned and persistent without replacing or closing publications', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.join(await f.connect('one')), b = await f.join(await f.connect('two'));
    const started = await f.api('publisher/start', a.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    const operation = { operationId: started.value.operationId, generation: started.value.generation };
    const ready = await f.api('publisher/ready', a.credential, { ...operation, mutationId: crypto.randomUUID() });
    const original = ready.value.snapshot.members.find(member => member.memberId === a.memberId);
    assert.equal(original.microphone, true);
    const calls = f.provider.calls.length;
    const mute = { ...operation, microphone: false, sequence: 2, mutationId: crypto.randomUUID() };
    const muted = await f.api('publisher/state', a.credential, mute);
    assert.equal(muted.status, 200);
    const publication = muted.value.snapshot.members.find(member => member.memberId === a.memberId);
    assert.equal(publication.microphone, false); assert.equal(publication.publishing, true);
    assert.equal(publication.publicationVersion, original.publicationVersion);
    assert.equal((await f.api('publisher/state', a.credential, mute)).status, 200, 'identical retry is idempotent');
    const late = await f.api('publisher/state', a.credential, { ...operation, microphone: true, sequence: 1, mutationId: crypto.randomUUID() });
    assert.equal(late.value.microphone, false, 'late unmute cannot undo a newer mute');
    assert.equal(late.value.sequence, 2);
    assert.equal((await f.api('publisher/state', a.credential, { ...mute, microphone: true, mutationId: crypto.randomUUID() })).status, 400, 'a sequence cannot describe two different states');
    assert.equal((await f.api('publisher/state', b.credential, { ...mute, mutationId: crypto.randomUUID() })).status, 409, 'another member cannot update this publisher');
    assert.equal((await f.api('publisher/state', a.credential, { ...mute, microphone: 'false', mutationId: crypto.randomUUID() })).status, 400);
    assert.equal(f.provider.calls.length, calls, 'mute state does not allocate or retire any SFU resources');
    const [id] = await f.runtime.listDurableObjectIds('VOICE_ROOMS');
    await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id });
    const restored = await f.api('heartbeat', a.credential);
    assert.equal(restored.value.snapshot.members.find(member => member.memberId === a.memberId).microphone, false);
    const resumed = await f.api('publisher/state', a.credential, { ...operation, microphone: true, sequence: 3, mutationId: crypto.randomUUID() });
    assert.equal(resumed.value.microphone, true);
    assert.equal(resumed.value.snapshot.members.find(member => member.memberId === a.memberId).publicationVersion, original.publicationVersion);
    assert.equal(f.provider.calls.length, calls);
    await delay(450);
    const replacement = await f.api('publisher/start', a.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    assert.equal(replacement.status, 200);
    await f.api('publisher/ready', a.credential, { operationId: replacement.value.operationId, generation: replacement.value.generation, mutationId: crypto.randomUUID() });
    assert.equal((await f.api('publisher/state', a.credential, { ...operation, microphone: false, sequence: 100, mutationId: crypto.randomUUID() })).status, 409, 'old publication state cannot mute a replacement');
    await f.api('leave', a.credential); await f.api('leave', b.credential);
  } finally { await f.close(); }
});

test('guest voice is opt-in and uses verified cookie identity, expiry and room-scoped tickets', { timeout: 20000 }, async () => {
  const locked = await fixture({ bindings: { VOICE_REQUIRE_PASS: 'true' } });
  try {
    const config = await fetch(`${locked.base}/api/room/voice-test/voice/config`, { headers: { Origin: origin } });
    assert.equal((await config.json()).loginRequired, true);
    const guest = await locked.connect(null);
    assert.equal((await guest.ticketResult()).code, 'login_required');
    assert.equal(locked.provider.allocations, 0);
  } finally { await locked.close(); }
  const f = await fixture({ bindings: { VOICE_REQUIRE_PASS: 'false' } });
  try {
    const config = await fetch(`${f.base}/api/room/voice-test/voice/config`, { headers: { Origin: origin } });
    assert.equal((await config.json()).loginRequired, false);
    const guest = await f.connect(null), a = await f.join(guest);
    const user = guest.messages.find(value => value.type === 'session').user;
    assert.match(user.id, /^guest:/); assert.equal(user.authenticated, false);
    assert.equal(a.snapshot.members[0].user.id, user.id);
    assert.equal(a.snapshot.members[0].user.authenticated, false);
    const duplicate = await f.connect(null, 'voice-test', { cookie: guest.cookie });
    assert.equal((await f.api('join', token(), { ticket: await duplicate.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() })).value.code, 'voice_in_use');
    const stranger = await f.connect(null), b = await f.join(stranger);
    assert.notEqual(b.memberId, a.memberId, 'same nickname cannot claim another guest');
    await delay(1050);
    assert.equal((await f.api('renew', a.credential, { ticket: await stranger.ticket() })).value.code, 'invalid_ticket');
    const missing = await f.connect(null, 'voice-test', { cookie: '', ready: false });
    assert.equal((await missing.wait(value => value.code)).code, 'guest_session_required');
    assert.equal(f.provider.allocations, 0);
  } finally { await f.close(); }
});

test('guest voice cannot outlive the signed cookie or renew from an expired chat identity', { timeout: 15000 }, async () => {
  const f = await fixture({ bindings: { VOICE_REQUIRE_PASS: 'false' } });
  try {
    const key = Buffer.from('ab'.repeat(32), 'hex'), now = Math.floor(Date.now() / 1000), expires = now + 5;
    const payload = `v1.${createHash('sha256').update(key).digest('hex').slice(0, 16)}.${crypto.randomUUID()}.${now}.${expires}`;
    const cookie = `__Host-nightcord_guest=${payload}.${createHmac('sha256', key).update('nightcord-chat/guest/v1\n' + payload).digest('hex')}`;
    const guest = await f.connect(null, 'voice-test', { cookie }), member = await f.join(guest);
    assert.equal(member.authUntil, expires * 1000);
    await delay(Math.max(0, expires * 1000 - Date.now()) + 30);
    assert.equal((await f.api('heartbeat', member.credential)).value.code, 'membership_expired');
    assert.equal((await guest.ticketResult()).code, 'login_required');
  } finally { await f.close(); }
});

test('a delayed microphone stop cannot close a newer publication', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const member = await f.join(await f.connect());
    const start = async () => {
      const result = await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
      assert.equal(result.status, 200, JSON.stringify(result.value));
      assert.equal((await f.api('publisher/ready', member.credential, { operationId: result.value.operationId, generation: result.value.generation, mutationId: crypto.randomUUID() })).status, 200);
      return result.value;
    };
    const old = await start();
    await f.api('publisher/stop', member.credential, { mutationId: crypto.randomUUID(), operationId: old.operationId });
    await delay(450);
    const current = await start();
    await f.api('publisher/stop', member.credential, { mutationId: crypto.randomUUID(), operationId: old.operationId });
    const state = await f.api('heartbeat', member.credential);
    assert.ok(state.value.snapshot.members.find(value => value.memberId === member.memberId).publishing);
    assert.notEqual(current.operationId, old.operationId);
    assert.ok(f.provider.sessions.get('fixture-2').some(track => track.status === 'active'));
  } finally { await f.close(); }
});

test('late publication cannot resurrect a member who left during SFU request', { timeout: 30000 }, async () => {
  const f = await fixture();
  let release;
  try {
    const client = await f.connect(), member = await f.join(client);
    f.provider.hold = new Promise(resolve => { release = resolve; });
    const pending = f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    for (let i = 0; i < 100 && !f.provider.allocations; i++) await delay(20);
    for (let i = 0; i < 100 && !f.provider.sessions.get('fixture-1')?.length; i++) await delay(20);
    assert.equal((await f.api('leave', member.credential)).status, 200);
    release(); const result = await pending; assert.equal(result.status, 401);
    await delay(200);
    assert.ok(f.provider.sessions.get('fixture-1').every(track => track.status === 'inactive'));
    assert.equal((await f.api('leave', member.credential)).status, 200);
  } finally { release?.(); await f.close(); }
});

test('partial allocations are closed and failed close is retained for retry', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const member = await f.join(await f.connect());
    f.provider.partial = true; f.provider.failClose = true;
    const result = await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    assert.equal(result.status, 502);
    await delay(100);
    assert.ok(f.provider.sessions.get('fixture-1').some(track => track.status === 'active'));
    const [id] = await f.runtime.listDurableObjectIds('VOICE_ROOMS');
    await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id });
    f.provider.failClose = false;
    await f.api('leave', member.credential); await delay(200);
    assert.ok(f.provider.sessions.get('fixture-1').every(track => track.status === 'inactive'));
  } finally { await f.close(); }
});

test('eight-member limit and duplicate account checks apply before allocating media', { timeout: 30000 }, async () => {
  const identities = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`Bearer capacity-${index}`, `capacity-${index}`]));
  const f = await fixture({ identities });
  try {
    for (let i = 0; i < 8; i++) await f.join(await f.connect(`capacity-${i}`));
    const ninth = await f.connect('capacity-8');
    const result = await f.api('join', token(), { ticket: await ninth.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() });
    assert.equal(result.value.code, 'room_full');
    const duplicate = await f.connect('capacity-0');
    assert.equal((await f.api('join', token(), { ticket: await duplicate.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() })).value.code, 'voice_in_use');
    assert.equal(f.provider.allocations, 0);
  } finally { await f.close(); }
});

test('persistent authentication expiry rejects heartbeats and alarm closes media after eviction', { timeout: 35000 }, async () => {
  const f = await fixture();
  try {
    const member = await f.join(await f.connect());
    const result = await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    assert.equal(result.status, 200);
    assert.equal((await f.api('publisher/ready', member.credential, { operationId: result.value.operationId, generation: result.value.generation, mutationId: crypto.randomUUID() })).status, 200);
    const [id] = await f.runtime.listDurableObjectIds('VOICE_ROOMS');
    const storage = await f.runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'VoiceRoom', { id });
    await storage.exec("UPDATE voice_members SET data=json_set(data,'$.authUntil',?)", Date.now() - 1);
    await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id });
    assert.equal((await f.api('heartbeat', member.credential)).value.code, 'membership_expired');
    for (let i = 0; i < 110 && f.provider.sessions.get('fixture-1').some(track => track.status === 'active'); i++) await delay(200);
    assert.ok(f.provider.sessions.get('fixture-1').every(track => track.status === 'inactive'), 'alarm must revoke forwarding without a cooperative browser leave');
    assert.ok(f.provider.revoked.length);
  } finally { await f.close(); }
});

async function quotaStorage(f) {
  const namespace = await f.runtime.getDurableObjectNamespace('VOICE_QUOTAS');
  const id = namespace.idFromName('voice-minutes-v1');
  await namespace.get(id).grant('bootstrap', 'bootstrap', 'bootstrap', 0);
  return f.runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'VoiceQuota', { id: id.toString() });
}

test('monthly minutes reject admission across rooms before allocating SFU or TURN resources', async () => {
  const f = await fixture({ bindings: { VOICE_MONTHLY_MINUTES: '1' } });
  try {
    const storage = await quotaStorage(f);
    await storage.exec('INSERT INTO voice_quota_totals VALUES (?,?,?,?)', 'month', quotaPeriods(Date.now()).month, '*', 60000);
    for (const [identity, room] of [['one', 'voice-test'], ['two', 'other-test']]) {
      const client = await f.connect(identity, room);
      const result = await f.api('join', token(), { ticket: await client.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() }, room);
      assert.equal(result.status, 429); assert.equal(result.value.code, 'voice_monthly_limit');
    }
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('daily minute expiry closes forwarding by alarm without a browser heartbeat, including after eviction', { timeout: 15000 }, async () => {
  const f = await fixture({ bindings: { VOICE_DAILY_MINUTES: '1' } });
  try {
    const storage = await quotaStorage(f);
    await storage.exec('INSERT INTO voice_quota_totals VALUES (?,?,?,?)', 'day', quotaPeriods(Date.now()).day, 'sekai:one', 56000);
    const one = await f.connect(), member = await f.join(one);
    assert.equal(member.usage.daily.limitMinutes, 1);
    assert.ok(member.usage.daily.usedMinutes >= 56 / 60);
    const start = await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    assert.equal(start.status, 200);
    assert.equal((await f.api('publisher/ready', member.credential, { operationId: start.value.operationId, generation: start.value.generation, mutationId: crypto.randomUUID() })).status, 200);
    const [id] = await f.runtime.listDurableObjectIds('VOICE_ROOMS');
    await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id });
    // Media closure finishes before the subsequent asynchronous TURN revocation.
    for (let i = 0; i < 100 && (f.provider.sessions.get('fixture-1').some(track => track.status === 'active') || !f.provider.revoked.length); i++) await delay(60);
    assert.ok(f.provider.sessions.get('fixture-1').every(track => track.status === 'inactive'), 'quota alarm must stop actual upstream forwarding');
    assert.ok(f.provider.revoked.length);
    assert.equal((await f.api('heartbeat', member.credential)).value.code, 'voice_daily_limit');
    assert.ok(one.messages.some(frame => frame.snapshot?.departures?.some(value => value.memberId === member.memberId && value.code === 'voice_daily_limit')));
    const other = await f.connect('one', 'other-test');
    const blocked = await f.api('join', token(), { ticket: await other.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() }, 'other-test');
    assert.equal(blocked.value.code, 'voice_daily_limit', 'changing room cannot reset personal minutes');
  } finally { await f.close(); }
});

test('failed forwarding cleanup keeps its reservation until closure is confirmed, then refunds unused seconds', async () => {
  const f = await fixture();
  try {
    const one = await f.connect(), member = await f.join(one), storage = await quotaStorage(f);
    const start = await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
    await f.api('publisher/ready', member.credential, { operationId: start.value.operationId, generation: start.value.generation, mutationId: crypto.randomUUID() });
    f.provider.failClose = true;
    const before = await storage.exec("SELECT spent_ms FROM voice_quota_totals WHERE scope='month'");
    await f.api('leave', member.credential); await delay(100);
    assert.deepEqual(await storage.exec("SELECT spent_ms FROM voice_quota_totals WHERE scope='month'"), before);
    assert.ok(f.provider.sessions.get('fixture-1').some(track => track.status === 'active'));
    f.provider.failClose = false;
    await f.api('leave', member.credential);
    for (let i = 0; i < 40; i++) {
      const rows = await storage.exec("SELECT data FROM voice_quota_leases WHERE id=?", member.memberId);
      if (JSON.parse(rows[0].data).closed) break;
      await delay(30);
    }
    const after = await storage.exec("SELECT spent_ms FROM voice_quota_totals WHERE scope='month'");
    assert.ok(after[0].spent_ms > 0 && after[0].spent_ms < before[0].spent_ms);
    assert.ok(f.provider.sessions.get('fixture-1').every(track => track.status === 'inactive'));
    const rejoined = await f.join(await f.connect());
    assert.ok(rejoined.usage.daily.usedMinutes > 0, 'leaving and rejoining retain elapsed minutes');
  } finally { await f.close(); }
});

test('unavailable minute accounting denies new membership before media allocation', async () => {
  const f = await fixture({ bindings: { VOICE_MONTHLY_MINUTES: 'invalid' } });
  try {
    const one = await f.connect();
    const result = await f.api('join', token(), { ticket: await one.ticket(), clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() });
    assert.equal(result.status, 503); assert.equal(result.value.code, 'voice_quota_unavailable');
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('configuration fails closed, rejects bad origin and audio-only policy before allocation', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const denied = await fetch(`${f.base}/api/room/voice-test/voice/config`, { headers: { Origin: 'https://attacker.example' } }); assert.equal(denied.status, 403);
    const config = await fetch(`${f.base}/api/room/not-enabled/voice/config`, { headers: { Origin: origin } }); assert.equal((await config.json()).enabled, false);
    const member = await f.join(await f.connect());
    const video = { ...offer, sdp: offer.sdp + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
    assert.equal((await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: video })).value.code, 'audio_only');
    assert.equal(f.provider.allocations, 0);
    const huge = await fetch(`${f.base}/api/room/voice-test/voice/join`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token()}` }, body: 'x'.repeat(70000) }); assert.equal(huge.status, 413);
  } finally { await f.close(); }
  const disabled = await fixture({ bindings: { VOICE_MODE: 'off' } });
  try { const config = await fetch(`${disabled.base}/api/room/voice-test/voice/config`, { headers: { Origin: origin } }); assert.equal((await config.json()).enabled, false); }
  finally { await disabled.close(); }
});
