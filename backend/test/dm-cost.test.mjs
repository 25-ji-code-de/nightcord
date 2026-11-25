/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRuntime } from './runtime.mjs';
import { instrumentCosts } from './dm-cost-fixture.mjs';

test('DM operation costs use consumed SQLite cursors and separate alarm writes', async t => {
  const source = await readFile(process.env.DM_COST_BUNDLE || 'dist/chat.js', 'utf8');
  const state = {}, runtime = createRuntime(state, { inspectDurableObjects: true,
    script: instrumentCosts(source), bindings: { DM_MODE: 'on' }, identities: { 'Bearer alice': 'alice', 'Bearer bob': 'bob' } });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const stub = async (binding, name) => (await runtime.getDurableObjectNamespace(binding)).getByName(name);
  const id = 'a'.repeat(64), alice = { id: 'sekai:alice', authenticated: true }, bob = { id: 'sekai:bob', authenticated: true };
  const room = await stub('DM_ROOMS', id), a = await stub('DM_INBOXES', alice.id), b = await stub('DM_INBOXES', bob.id);
  const limiter = await stub('LIMITERS', 'user:' + alice.id);
  const objects = { room, alice: a, bob: b, limiter };
  const storage = await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'DirectRoom', { name: id });
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      if (!(await storage.exec('SELECT * FROM dm_outbox')).length) { await delay(30); return; }
      await delay(10);
    }
    assert.fail('outbox did not settle');
  };
  const api = async (who, path, data) => {
    state.http = (state.http || 0) + 1;
    const response = await fetch(base + '/api/dm/conversations/' + id + path, {
      method: data ? 'POST' : 'GET', headers: { Origin: 'https://nightcord.de5.net', Authorization: 'Bearer ' + who, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  await room.handle(alice, 'initialize', {}, { id, peer: bob });
  assert.equal((await room.handle(alice, 'send', { text: 'initial', clientMessageId: crypto.randomUUID() })).status, 200);
  await room.handle(bob, 'accept', {}); await settled();
  await api('bob', '/read', { seq: 1 });
  const measure = async (action) => {
    for (const object of Object.values(objects)) await object.costs(true);
    state.http = state.passCalls = 0;
    await action(); await settled();
    const result = { http: state.http, pass: state.passCalls, objects: {} };
    for (const [name, object] of Object.entries(objects)) result.objects[name] = await object.costs();
    result.rpc = Object.values(result.objects).reduce((n, c) => n + (c.handle || 0) + (c.apply || 0) - (c.localApply || 0) + (c.check || 0), 0);
    return result;
  };
  const results = {};
  results.messageRead = await measure(async () => {
    await api('alice', '/messages', { text: 'measured', clientMessageId: crypto.randomUUID() });
    await settled(); await api('bob', '/messages'); await api('bob', '/read', { seq: 2 });
  });
  results.repeatAccept = await measure(() => room.handle(bob, 'accept', {}));
  await room.handle(bob, 'refuse', { refuseIncoming: true }); await settled();
  results.repeatRefuse = await measure(() => room.handle(bob, 'refuse', { refuseIncoming: true }));
  const sockets = [];
  for (let device = 0; device < 3; device++) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/dm/events?account=sekai:bob', {
      headers: { Origin: 'https://nightcord.de5.net', 'CF-Connecting-IP': crypto.randomUUID() },
    });
    t.after(() => ws.terminate());
    await once(ws, 'open');
    const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth', accessToken: 'bob' })); await ready;
    sockets.push(ws); await delay(20);
  }
  // Renew the latest deadline: another device still owns the earliest alarm.
  await delay(1100);
  results.renewLatestOfThree = await measure(async () => {
    const ready = once(sockets[2], 'message'); sockets[2].send(JSON.stringify({ type: 'auth', accessToken: 'bob' })); await ready;
  });
  assert.equal(results.messageRead.http, 3); assert.equal(results.messageRead.pass, 3); assert.equal(results.messageRead.rpc, 8);
  if (!process.env.DM_COST_BUNDLE) {
    for (const name of ['repeatAccept', 'repeatRefuse']) {
      assert.equal(results[name].objects.room.rowsWritten, 0);
      assert.equal(results[name].rpc, 1);
    }
    assert.equal(results.renewLatestOfThree.objects.bob.setAlarm || 0, 0);
    for (const ws of sockets) { const closed = once(ws, 'close'); ws.close(); await closed; }
    for (let attempt = 0; attempt < 100 && await b.costAlarm() !== null; attempt++) await delay(10);
    assert.equal(await b.costAlarm(), null, 'closing the last device clears the expiry alarm');
  }
  t.diagnostic(JSON.stringify(results));
  if (process.env.DM_COST_OUTPUT) await writeFile(process.env.DM_COST_OUTPUT, JSON.stringify(results, null, 2) + '\n');
});
