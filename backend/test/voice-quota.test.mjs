/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime } from './runtime.mjs';
import { quotaLimits, quotaPeriods } from '../src/voice/quota-policy.ts';

async function fixture(bindings = {}, persistencePath) {
  const runtime = createRuntime({}, { inspectDurableObjects: true, bindings, persistencePath });
  await runtime.ready;
  const namespace = await runtime.getDurableObjectNamespace('VOICE_QUOTAS');
  const id = namespace.idFromName('voice-minutes-v1');
  const stub = namespace.get(id);
  await stub.grant('bootstrap', 'bootstrap', 'bootstrap', 0);
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'VoiceQuota', { id: id.toString() });
  return { runtime, stub, storage, id: id.toString(), async close() { await runtime.dispose(); } };
}

test('minute policy uses UTC months and Shanghai days, including year and leap-day boundaries', () => {
  const beforeMidnight = quotaPeriods(Date.parse('2026-11-08T15:59:59.999Z'));
  const midnight = quotaPeriods(Date.parse('2026-11-08T16:00:00Z'));
  assert.equal(beforeMidnight.day, '2026-11-08'); assert.equal(midnight.day, '2026-11-09');
  assert.equal(beforeMidnight.dayResetsAt, Date.parse('2026-11-08T16:00:00Z'));
  const december = quotaPeriods(Date.parse('2026-12-31T23:59:59Z'));
  assert.equal(december.month, '2026-12'); assert.equal(december.day, '2027-01-01');
  assert.equal(december.monthResetsAt, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(quotaPeriods(Date.parse('2028-02-29T12:00:00Z')).monthResetsAt, Date.parse('2028-03-01T00:00:00Z'));
  assert.deepEqual(quotaLimits({}), { monthly: 230000, daily: 240, valid: true });
  for (const value of ['0', '-1', '', 'NaN', 'Infinity', '1.5']) assert.equal(quotaLimits({ VOICE_DAILY_MINUTES: value }).valid, false);
});

test('concurrent grants across rooms share the last monthly minute without overspending', async () => {
  const f = await fixture({ VOICE_MONTHLY_MINUTES: '1', VOICE_DAILY_MINUTES: '120' });
  try {
    const grants = await Promise.all(['one', 'two', 'three'].map(user => f.stub.grant(user, `room-${user}`, user, Date.now() + 60000)));
    assert.ok(grants.some(value => value.ok));
    assert.ok(grants.some(value => !value.ok && value.code === 'voice_monthly_limit'));
    const rows = await f.storage.exec("SELECT spent_ms FROM voice_quota_totals WHERE scope='month'");
    assert.equal(rows.reduce((sum, row) => sum + row.spent_ms, 0), 60000);
  } finally { await f.close(); }
});

test('grant retries and a full restart retain one reservation, and closing refunds only unused time once', async () => {
  const prefix = join(tmpdir(), 'nightcord-quota-');
  const persist = await mkdtemp(prefix);
  let f = await fixture({}, persist);
  try {
    const deadline = Date.now() + 60000;
    const first = JSON.parse(JSON.stringify(await f.stub.grant('one', 'room-a', 'sekai:one', deadline)));
    assert.equal(first.ok, true); assert.equal(first.usage.daily.limitMinutes, 240);
    assert.equal(first.usage.monthly.limitMinutes, 230000);
    const before = JSON.parse(JSON.stringify(await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope')));
    await delay(30);
    const retry = await f.stub.grant('one', 'room-a', 'sekai:one', deadline);
    assert.equal(retry.until, first.until);
    assert.deepEqual(await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope'), before);
    assert.ok(retry.usage.daily.usedMinutes > first.usage.daily.usedMinutes);
    await f.close();
    f = await fixture({}, persist);
    assert.deepEqual(await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope'), before);
    assert.equal((await f.stub.grant('one', 'room-a', 'sekai:one', deadline)).until, first.until);
    await f.stub.release('one', 'wrong-room');
    assert.deepEqual(await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope'), before);
    await f.stub.release('one', 'room-a');
    const closed = await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope');
    assert.ok(closed.every(row => row.spent_ms > 0 && row.spent_ms < 5000));
    await f.stub.release('one', 'room-a');
    assert.deepEqual(await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope'), closed);
    assert.equal((await f.stub.grant('one', 'room-a', 'sekai:one', deadline)).code, 'voice_quota_expired');
    await f.stub.release('late-request', 'room-a');
    assert.equal((await f.stub.grant('late-request', 'room-a', 'sekai:one', deadline)).code, 'voice_quota_expired', 'closing an uncertain grant fences a late request');
  } finally {
    await f.close();
    assert.ok(resolve(persist).startsWith(resolve(prefix)) && resolve(persist) !== resolve(tmpdir()));
    await rm(persist, { recursive: true, force: true });
  }
});

test('the default daily allowance continues past two hours and stops at four hours', async () => {
  const f = await fixture();
  try {
    const { day } = quotaPeriods(Date.now());
    await f.storage.exec('INSERT INTO voice_quota_totals VALUES (?,?,?,?)', 'day', day, 'sekai:one', 120 * 60000);
    const grant = await f.stub.grant('one', 'room-a', 'sekai:one', Date.now() + 60000);
    assert.equal(grant.ok, true); assert.equal(grant.usage.daily.usedMinutes, 120);
    assert.equal(grant.usage.daily.limitMinutes, 240);
    await f.stub.release('one', 'room-a');
    await f.storage.exec("UPDATE voice_quota_totals SET spent_ms=? WHERE scope='day' AND subject=?", 240 * 60000, 'sekai:one');
    assert.equal((await f.stub.grant('two', 'room-b', 'sekai:one', Date.now() + 60000)).code, 'voice_daily_limit');
  } finally { await f.close(); }
});

test('personal daily minutes aggregate across rooms and remain spent after rejoining', async () => {
  const f = await fixture({ VOICE_DAILY_MINUTES: '1' });
  try {
    const { day } = quotaPeriods(Date.now());
    await f.storage.exec('INSERT INTO voice_quota_totals VALUES (?,?,?,?)', 'day', day, 'sekai:one', 60000);
    for (const room of ['room-a', 'room-b']) assert.equal((await f.stub.grant(room, room, 'sekai:one', Date.now() + 60000)).code, 'voice_daily_limit');
    assert.equal((await f.stub.grant('other', 'room-b', 'sekai:two', Date.now() + 60000)).ok, true);
    const rows = await f.storage.exec("SELECT spent_ms FROM voice_quota_totals WHERE scope='day' AND subject='sekai:one'");
    assert.equal(rows[0].spent_ms, 60000);
  } finally { await f.close(); }
});

test('expired grants cannot silently resume or erase already consumed minutes', async () => {
  const f = await fixture();
  try {
    const first = await f.stub.grant('one', 'room-a', 'one', Date.now() + 100);
    assert.equal(first.ok, true);
    await delay(150);
    assert.equal((await f.stub.grant('one', 'room-a', 'one', Date.now() + 60000)).code, 'voice_quota_expired');
    const before = await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope');
    await f.stub.release('one', 'room-a');
    const closed = await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope');
    assert.ok(closed.every((row, index) => row.spent_ms >= before[index].spent_ms));
    await f.stub.release('one', 'room-a');
    assert.deepEqual(await f.storage.exec('SELECT * FROM voice_quota_totals ORDER BY scope'), closed);
  } finally { await f.close(); }
});

test('invalid minute configuration fails closed without allocating time', async () => {
  const f = await fixture({ VOICE_MONTHLY_MINUTES: 'invalid' });
  try {
    assert.equal((await f.stub.grant('one', 'room-a', 'one', Date.now() + 60000)).code, 'voice_quota_unavailable');
    assert.deepEqual(await f.storage.exec('SELECT * FROM voice_quota_totals'), []);
  } finally { await f.close(); }
});
