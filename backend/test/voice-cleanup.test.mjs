/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, offer } from './voice-fixture.mjs';

async function auditFixture(options = {}) {
  let script = await readFile('dist/chat.js', 'utf8');
  if (options.quotaDelayMs) {
    const release = /  release\(id, roomId, closedAt = Date\.now\(\), legacyReview = false\) \{/;
    assert.match(script, release);
    script = script.replace(release, match => match.replace('  release(', '  async release(')
      + `await new Promise(resolve => setTimeout(resolve, ${options.quotaDelayMs}));`);
  }
  const pattern = /var VoiceRoom = class extends \w+ \{/;
  assert.match(script, pattern);
  // Test-only access to the real alarm/cleanup paths. Never deployed.
  script = script.replace(pattern, match => match + `
    async fetch(request) {
      const action = new URL(request.url).pathname;
      if (action === '/getPresence') return Response.json(this.getPresence());
      if (action === '/testCleanup') { await this.cleanup(); return Response.json(null); }
      if (action === '/testAlarm' || action === '/testReschedule') {
        await this.ctx.storage.deleteAlarm();
        if (action === '/testAlarm') await this.alarm(); else await this.schedule();
        return Response.json(await this.ctx.storage.getAlarm());
      }
      return new Response(null, { status: 404 });
    }
  `);
  return fixture({ ...options, script });
}
async function inspect(f) {
  const [id] = await f.runtime.listDurableObjectIds('VOICE_ROOMS');
  const ns = await f.runtime.getDurableObjectNamespace('VOICE_ROOMS');
  const storage = await f.runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'VoiceRoom', { id });
  const quotaIds = await f.runtime.listDurableObjectIds('VOICE_QUOTAS');
  const quota = await f.runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'VoiceQuota', { id: quotaIds[0] });
  const rows = async table => (await storage.exec(`SELECT data FROM ${table}`)).map(row => JSON.parse(row.data));
  // HTTP requests end their reference at response completion. Retaining a called
  // external RPC stub pins the object in Miniflare and prevents real eviction.
  const call = async action => (await ns.get(ns.idFromString(id)).fetch(`http://voice-test/${action}`)).json();
  const room = Object.fromEntries(['testCleanup', 'testAlarm', 'testReschedule', 'getPresence'].map(action => [action, () => call(action)]));
  return { id, room, storage, quota,
    members: () => rows('voice_members'), sessions: () => rows('voice_sessions'), turns: () => rows('voice_turn_cleanup'),
    lease: async memberId => JSON.parse((await quota.exec('SELECT data FROM voice_quota_leases WHERE id=?', memberId))[0].data),
    dueMedia: () => storage.exec("UPDATE voice_sessions SET data=json_set(data,'$.cleanup.nextAttemptAt',0)"),
    dueTurn: () => storage.exec("UPDATE voice_turn_cleanup SET data=json_set(data,'$.retry.nextAttemptAt',0)"),
  };
}
async function until(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(25); }
  assert.fail('Expected lifecycle transition did not finish');
}
async function publish(f, member) {
  const started = await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
  assert.equal(started.status, 200);
  assert.equal((await f.api('publisher/ready', member.credential, { mutationId: crypto.randomUUID(), operationId: started.value.operationId, generation: started.value.generation })).status, 200);
}

test('expired TURN work ends without an API call, and the empty room stops waking', async t => {
  const f = await auditFixture(); t.after(() => f.close());
  const member = await f.join(await f.connect());
  await f.api('ice', member.credential);
  const a = await inspect(f);
  await a.storage.exec("UPDATE voice_members SET data=json_set(data,'$.turnCredentials[0].expiresAt',?)", Date.now() - 1);
  await f.api('leave', member.credential);
  await until(async () => (await a.members())[0]?.tombstoneUntil && !(await a.turns()).length);
  assert.equal(f.provider.revoked.length, 0);
  assert.equal((await a.lease(member.memberId)).closed, true);
  const alarm = await a.room.testReschedule();
  assert.ok(alarm > Date.now() + 590000, 'a lone tombstone waits for its expiry, not 20-second polling');
  await a.storage.exec("UPDATE voice_members SET data=json_set(data,'$.tombstoneUntil',1)");
  assert.equal(await a.room.testAlarm(), null);
});

test('TURN partial success checkpoints independently, survives eviction, and does not hold quota or capacity', async t => {
  let failing = true;
  const revoked = [];
  const f = await auditFixture({ intercept: ({ path }) => {
    if (path.endsWith('/generate-ice-servers')) return Response.json({ iceServers: ['good', 'bad', 'good'].map(username => ({ urls: 'turn:turn.cloudflare.com:3478', username, credential: 'fixture' })) });
    if (path.endsWith('/revoke')) {
      const name = path.includes('/good/') ? 'good' : 'bad'; revoked.push(name);
      return new Response(null, { status: name === 'bad' && failing ? 503 : 204 });
    }
  } }); t.after(() => f.close());
  const member = await f.join(await f.connect()); await f.api('ice', member.credential);
  const a = await inspect(f);
  assert.equal((await a.members())[0].turnCredentials.length, 2, 'duplicate ICE entries share one credential');
  await f.api('leave', member.credential);
  const pending = await until(async () => (await a.turns()).find(task => task.retry?.attempts === 1));
  await until(async () => (await a.members())[0].tombstoneUntil);
  const lease = await a.lease(member.memberId);
  assert.equal(lease.closed, true);
  assert.equal(lease.closedAt, (await a.members())[0].mediaClosedAt);
  assert.deepEqual(revoked.sort(), ['bad', 'good']);
  await f.api('leave', member.credential); await a.room.testCleanup();
  assert.equal(revoked.length, 2, 'repeated leave cannot bypass backoff');
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  await a.room.testCleanup();
  assert.equal((await a.turns())[0].retry.nextAttemptAt, pending.retry.nextAttemptAt);
  assert.equal(revoked.length, 2);
  const rejoined = await f.join(await f.connect());
  assert.notEqual(rejoined.memberId, member.memberId);
  failing = false; await a.dueTurn(); await a.room.testCleanup();
  assert.deepEqual(revoked.filter(name => name === 'good'), ['good']);
  assert.equal((await a.turns()).length, 0);
  assert.equal((await a.lease(member.memberId)).closedAt, lease.closedAt);
});

test('unknown allocations survive empty snapshots and generic 404/410, but a confirmed dead session converges', async t => {
  let inspection = 'tracks';
  const f = await auditFixture({ intercept: ({ path }) => {
    if (path.endsWith('/tracks/new')) return new Response(null, { status: 503 });
    if (/\/sessions\/[^/]+$/.test(path) && !path.endsWith('/new')) {
      if (inspection === 'app404') return Response.json({ errorCode: 'not_found' }, { status: 404 });
      if (inspection === 'generic410') return Response.json({ errorCode: 'unknown' }, { status: 410 });
      if (inspection === 'gone') return Response.json({ errorCode: 'session_error' }, { status: 410 });
      return Response.json({ tracks: [] });
    }
  } }); t.after(() => f.close());
  const member = await f.join(await f.connect());
  assert.equal((await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer })).status, 502);
  const a = await inspect(f);
  const unresolved = await until(async () => (await a.sessions()).find(session => session.cleanup?.lastCode === 'outcome_unknown'));
  assert.equal(unresolved.uncertain, true);
  const before = f.provider.calls.length;
  await a.room.testCleanup(); assert.equal(f.provider.calls.length, before);
  inspection = 'app404'; await a.dueMedia(); await a.room.testCleanup();
  const retryAt = (await a.sessions())[0].cleanup.nextAttemptAt;
  assert.ok(retryAt > Date.now() + 290000);
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  const attempts = f.provider.calls.length;
  await a.room.testCleanup();
  assert.equal((await a.sessions())[0].cleanup.nextAttemptAt, retryAt);
  assert.equal(f.provider.calls.length, attempts, 'eviction cannot reset the configuration-error cooldown');
  inspection = 'generic410'; await a.dueMedia(); await a.room.testCleanup();
  assert.equal((await a.sessions()).length, 1);
  inspection = 'gone'; await a.dueMedia(); await a.room.testCleanup();
  assert.equal((await a.sessions()).length, 0);
  await f.api('leave', member.credential);
  await until(async () => (await a.lease(member.memberId)).closed);
});

test('incomplete allocation responses retain known mids and reconcile late tracks without premature settlement', async t => {
  let inspection = 'empty';
  const f = await auditFixture({ intercept: ({ path, provider }) => {
    if (path.endsWith('/tracks/new')) return Response.json({ tracks: [{ mid: '0' }, null] });
    if (/\/sessions\/[^/]+$/.test(path) && !path.endsWith('/new')) {
      if (inspection === 'gone') return Response.json({ errorCode: 'session_error' }, { status: 410 });
      if (inspection === 'late') provider.sessions.set('fixture-1', [{ mid: '0', status: 'inactive' }, { mid: '1', status: 'active' }]);
      return Response.json({ tracks: inspection === 'empty' ? [] : provider.sessions.get('fixture-1') });
    }
  } }); t.after(() => f.close());
  const member = await f.join(await f.connect());
  assert.equal((await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer })).status, 502);
  const a = await inspect(f);
  await until(async () => (await a.sessions())[0]?.cleanup?.lastCode === 'outcome_unknown');
  const session = (await a.sessions())[0];
  assert.equal(session.uncertain, true); assert.deepEqual(session.mids, ['0']); assert.deepEqual(session.closedMids, ['0']);
  await f.api('leave', member.credential);
  assert.equal((await a.lease(member.memberId)).closed, undefined);
  inspection = 'late'; await a.dueMedia(); await a.room.testCleanup();
  assert.equal(f.provider.sessions.get('fixture-1').find(track => track.mid === '1').status, 'inactive');
  assert.equal((await a.sessions()).length, 1, 'closing visible tracks cannot prove delayed allocation is finished');
  assert.equal((await a.lease(member.memberId)).closed, undefined);
  inspection = 'gone'; await a.dueMedia(); await a.room.testCleanup();
  assert.equal((await a.sessions()).length, 0); assert.equal((await a.lease(member.memberId)).closed, true);
});

test('rate-limited cleanup honors Retry-After and prolonged uncertainty backs off across eviction', async t => {
  let limited = true;
  const f = await auditFixture({ intercept: ({ path }) => {
    if (path.endsWith('/tracks/new')) return new Response(null, { status: 503 });
    if (/\/sessions\/[^/]+$/.test(path) && !path.endsWith('/new')) return limited
      ? Response.json({ errorCode: 'temporarily_unavailable_error' }, { status: 429, headers: { 'Retry-After': '1200' } })
      : Response.json({ tracks: [] });
  } }); t.after(() => f.close());
  const member = await f.join(await f.connect());
  await f.api('publisher/start', member.credential, { mutationId: crypto.randomUUID(), mid: '0', sessionDescription: offer });
  const a = await inspect(f);
  const rateLimited = await until(async () => (await a.sessions()).find(session => session.cleanup?.attempts === 1));
  assert.ok(rateLimited.cleanup.nextAttemptAt > Date.now() + 1190000);
  limited = false;
  await a.storage.exec("UPDATE voice_sessions SET data=json_set(data,'$.cleanup.nextAttemptAt',0,'$.cleanup.firstFailedAt',?,'$.cleanup.attempts',8)", Date.now() - 3600000);
  await a.room.testCleanup();
  const retryAt = (await a.sessions())[0].cleanup.nextAttemptAt;
  assert.ok(retryAt > Date.now() + 890000);
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  const calls = f.provider.calls.length; await a.room.testCleanup();
  assert.equal((await a.sessions())[0].cleanup.nextAttemptAt, retryAt); assert.equal(f.provider.calls.length, calls);
});

test('partial media close retries only unresolved mids and does not release live forwarding', async t => {
  let failSecond = true;
  const closes = [];
  const f = await auditFixture({ intercept: ({ path, body, provider }) => {
    if (!path.endsWith('/tracks/close')) return;
    closes.push(body.tracks.map(track => track.mid));
    const tracks = body.tracks.map(track => track.mid === '1' && failSecond ? { ...track, errorCode: 'internal_error' } : track);
    provider.sessions.set('fixture-1', provider.sessions.get('fixture-1').map(track => tracks.some(result => result.mid === track.mid && !result.errorCode) ? { ...track, status: 'inactive' } : track));
    return Response.json({ tracks });
  } }); t.after(() => f.close());
  const member = await f.join(await f.connect()); await publish(f, member);
  const a = await inspect(f);
  await a.storage.exec("UPDATE voice_sessions SET data=json_set(data,'$.mids',json('[\"0\",\"1\"]'))");
  f.provider.sessions.get('fixture-1').push({ mid: '1', status: 'active' });
  await f.api('leave', member.credential);
  await until(async () => (await a.sessions())[0]?.cleanup?.attempts === 1);
  assert.equal((await a.lease(member.memberId)).closed, undefined);
  assert.deepEqual((await a.sessions())[0].closedMids, ['0']);
  assert.deepEqual((await a.sessions())[0].cleanupMids, ['1']);
  await a.room.testCleanup(); assert.equal(closes.length, 1);
  failSecond = false; await a.dueMedia(); await a.room.testCleanup();
  assert.deepEqual(closes, [['0', '1'], ['1']]);
  assert.equal((await a.lease(member.memberId)).closed, true);
});

test('pre-migration TURN-only departures preserve charges for review and free the room', async t => {
  const f = await auditFixture(); t.after(() => f.close());
  const member = await f.join(await f.connect());
  const a = await inspect(f);
  await a.storage.exec("UPDATE voice_members SET data=json_set(json_remove(data,'$.cleanupVersion','$.turnCredentials'),'$.leaving',json('true'),'$.turnUsers',json('[\"legacy-credential\",\"legacy-credential\"]'),'$.ice',json(?))", JSON.stringify({ iceExpiresAt: Date.now() - 86400000 }));
  await a.quota.exec("UPDATE voice_quota_leases SET data=json_set(data,'$.until',?),reserved_until=? WHERE id=?", Date.now() - 86400000, Date.now() - 86400000, member.memberId);
  const totals = await a.quota.exec('SELECT * FROM voice_quota_totals ORDER BY scope');
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  await a.room.testCleanup();
  await until(async () => (await a.members())[0].tombstoneUntil);
  assert.equal((await a.lease(member.memberId)).settlement, 'legacy_settlement_review');
  assert.deepEqual(await a.quota.exec('SELECT * FROM voice_quota_totals ORDER BY scope'), totals);
  assert.equal((await a.turns()).length, 0); assert.equal(f.provider.revoked.length, 0);
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  await a.room.testCleanup(); assert.equal((await a.turns()).length, 0);
  assert.notEqual((await f.join(await f.connect())).memberId, member.memberId);
});

test('legacy active listeners stay billable and missing TURN expiry is initialized once', async t => {
  const f = await auditFixture(); t.after(() => f.close());
  const member = await f.join(await f.connect()); const a = await inspect(f);
  await a.storage.exec("UPDATE voice_members SET data=json_set(json_remove(data,'$.cleanupVersion','$.turnCredentials','$.ice'),'$.turnUsers',json('[\"old-key-credential\"]'))");
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  await a.room.testCleanup();
  const restored = (await a.members())[0], expiry = restored.turnCredentials[0].expiresAt;
  assert.ok(expiry >= Date.now() + 3500000);
  assert.equal(restored.leaving, false); assert.equal(restored.legacySettlementReview, false);
  assert.equal((await a.lease(member.memberId)).closed, undefined);
  await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
  await a.room.testCleanup(); assert.equal((await a.members())[0].turnCredentials[0].expiresAt, expiry);
  await f.api('leave', member.credential);
  await until(async () => (await a.lease(member.memberId)).closed);
  assert.equal(f.provider.revoked.length, 0, 'unknown old key ownership waits for expiry');
});

test('a slow cleanup respects another member deadline and does not hold getPresence', async t => {
  const f = await auditFixture({ intercept: async ({ path }) => {
    if (path.endsWith('/revoke')) { await delay(1500); return new Response(null, { status: 204 }); }
  } }); t.after(() => f.close());
  const departing = await f.join(await f.connect('one'));
  await f.api('ice', departing.credential);
  const listener = await f.join(await f.connect('two')), a = await inspect(f);
  await a.storage.exec("UPDATE voice_members SET data=json_set(data,'$.authUntil',?) WHERE id=?", Date.now() + 400, listener.memberId);
  await f.api('leave', departing.credential);
  const presenceStart = Date.now(); await a.room.getPresence();
  assert.ok(Date.now() - presenceStart < 500);
  await until(async () => (await a.members()).find(member => member.id === listener.memberId)?.leaving, 2500);
  const task = await until(async () => (await a.turns()).find(task => task.retry?.lastCode?.includes('timeout')), 2500);
  assert.equal(task.retry.attempts, 1);
  assert.equal((await a.lease(departing.memberId)).closed, true);
});

test('only two cleanup resources run at once even when leave and alarm overlap', async t => {
  let inFlight = 0, peak = 0;
  const f = await auditFixture({ intercept: async ({ path }) => {
    if (path.endsWith('/generate-ice-servers')) return Response.json({ iceServers: Array.from({ length: 5 }, (_, index) => ({ urls: 'turn:turn.cloudflare.com:3478', username: 'fixture-' + index, credential: 'fixture' })) });
    if (path.endsWith('/revoke')) { peak = Math.max(peak, ++inFlight); await delay(150); inFlight--; return new Response(null, { status: 204 }); }
  } }); t.after(() => f.close());
  const member = await f.join(await f.connect()); await f.api('ice', member.credential); const a = await inspect(f);
  await f.api('leave', member.credential);
  await Promise.all([a.room.testCleanup(), f.api('leave', member.credential), a.room.testAlarm()]);
  await until(async () => !(await a.turns()).length, 5000);
  assert.equal(peak, 2);
  assert.equal((await a.lease(member.memberId)).closed, true);
});

test('media closure is checkpointed before unrelated slow cleanup finishes', async t => {
  let releaseClose;
  const heldClose = new Promise(resolve => { releaseClose = resolve; });
  const f = await auditFixture({ intercept: async ({ path }) => {
    if (path.endsWith('/sessions/fixture-2/tracks/close')) await heldClose;
  } });
  t.after(() => { releaseClose(); return f.close(); });
  const one = await f.join(await f.connect('one')); await publish(f, one);
  const two = await f.join(await f.connect('two')); await publish(f, two);
  const a = await inspect(f);
  await a.storage.exec("UPDATE voice_members SET data=json_set(data,'$.leaving',json('true'))");
  await a.storage.exec("UPDATE voice_sessions SET data=json_set(data,'$.retired',json('true'))");
  const cleanup = a.room.testCleanup();
  try {
    await until(async () => !(await a.sessions()).some(session => session.memberId === one.memberId));
    const closedAt = (await a.members()).find(member => member.id === one.memberId).mediaClosedAt;
    assert.ok(Number.isSafeInteger(closedAt), 'persist closure with the last session deletion, before awaiting other resources');
    await delay(150);
    releaseClose(); await cleanup;
    assert.equal((await a.lease(one.memberId)).closedAt, closedAt);
    await f.runtime.unsafeEvictDurableObject('nightcord-chat', 'VoiceRoom', { id: a.id });
    await a.room.testCleanup();
    assert.equal((await a.lease(one.memberId)).closedAt, closedAt);
  } finally { releaseClose(); await cleanup; }
});

test('leaving without media records closure while TURN issuance is still pending', async t => {
  let releaseIce;
  const heldIce = new Promise(resolve => { releaseIce = resolve; });
  let issuing = false;
  const f = await auditFixture({ intercept: async ({ path }) => {
    if (path.endsWith('/generate-ice-servers')) { issuing = true; await heldIce; }
  } });
  t.after(() => { releaseIce(); return f.close(); });
  const member = await f.join(await f.connect()), a = await inspect(f);
  const ice = f.api('ice', member.credential);
  try {
    await until(() => issuing);
    await f.api('leave', member.credential);
    const closedAt = (await a.members())[0].mediaClosedAt;
    assert.ok(Number.isSafeInteger(closedAt), 'pending credentials do not extend voice time');
    await delay(150);
    releaseIce(); await ice;
    await until(async () => (await a.lease(member.memberId)).closed);
    assert.equal((await a.lease(member.memberId)).closedAt, closedAt);
    await until(async () => !(await a.turns()).length);
    assert.equal(f.provider.revoked.length, 1, 'late credentials still get revoked');
  } finally { releaseIce(); await ice; }
});

test('slow quota settlement yields at the next member deadline and a late reply stays idempotent', async t => {
  const f = await auditFixture({ quotaDelayMs: 1800 }); t.after(() => f.close());
  const departing = await f.join(await f.connect('one'));
  const listener = await f.join(await f.connect('two')), a = await inspect(f);
  await a.storage.exec("UPDATE voice_members SET data=json_set(data,'$.leaving',json('true')) WHERE id=?", departing.memberId);
  await a.storage.exec("UPDATE voice_members SET data=json_set(data,'$.authUntil',?) WHERE id=?", Date.now() + 500, listener.memberId);
  const start = Date.now();
  await a.room.testCleanup();
  assert.ok(Date.now() - start < 1200, 'quota RPC cannot block the cleanup round past another member deadline');
  const closedAt = (await a.members()).find(member => member.id === departing.memberId).mediaClosedAt;
  await until(async () => (await a.members()).find(member => member.id === listener.memberId).leaving);
  await until(async () => (await a.lease(departing.memberId)).closed);
  assert.equal((await a.lease(departing.memberId)).closedAt, closedAt);
  await until(async () => (await a.members()).find(member => member.id === departing.memberId).tombstoneUntil, 7000);
  assert.equal((await a.lease(departing.memberId)).closedAt, closedAt);
});
