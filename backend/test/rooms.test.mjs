/* SPDX-License-Identifier: AGPL-3.0-only */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRuntime } from './runtime.mjs';
const origin='https://nightcord.de5.net';
const profiles=Object.fromEntries(['alice','bob','eve'].map(name=>[name,{id:'sekai:'+name,authenticated:true,displayName:name,username:name,sub:name,issuer:'https://id.nightcord.de5.net',avatarUrl:null,bio:'',isMobile:false}]));
const creation=(name='房间')=>({name,description:'测试',discoverability:'listed',joinPolicy:'open',requestId:crypto.randomUUID()});
async function until(check) { for(let i=0;i<200;i++){ const value=await check(); if(value)return value; await delay(25); } assert.fail('Timed out'); }
async function fixture(t,bindings={},script,persistencePath,initialize=true) {
  script ||= await readFile('dist/chat.js','utf8');
  script = script.replace(/(var ManagedRoom = class extends \w+ \{)/, '$1\n testAlarm() { return this.alarm(); }');
  const state={}; const runtime=createRuntime(state,{inspectDurableObjects:true,script,persistencePath,bindings:{DM_MODE:'on',ROOMS_MODE:'on',ROOMS_MODERATORS:'sekai:eve',...bindings},identities:Object.fromEntries(Object.keys(profiles).map(n=>['Bearer '+n,n]))});
  t.after(()=>runtime.dispose()); const base=String(await runtime.ready).replace(/\/$/,'');
  const db=await runtime.getD1Database('ROOM_DIRECTORY'); if(initialize) await db.exec((await readFile('migrations/0001_rooms.sql','utf8')).replace(/\n/g,' '));
  const api=async(who,path,data,method=data===undefined?'GET':'POST')=>{
    const r=await fetch(base+'/api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(who?{Authorization:'Bearer '+who}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:r.status,data:await r.json()};
  };
  const ns=await runtime.getDurableObjectNamespace('MANAGED_ROOMS');
  const room=id=>{ const stub=ns.get(ns.idFromName(id)); return new Proxy(stub,{get(target,key){ if(key==='handle')return async(...args)=>{ const r=await target.handle(...args);return {status:r.status,data:JSON.parse(r.json)};};const v=target[key];return typeof v==='function'?v.bind(target):v; }}); };
  const storage=id=>runtime.unsafeGetDurableObjectStorage('nightcord-chat','ManagedRoom',{name:id});
  const connect=async(id,who)=>{
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/rooms/'+id+'/websocket',{headers:{Origin:origin,'CF-Connecting-IP':crypto.randomUUID()}}); const frames=[];
    ws.on('message',raw=>frames.push(JSON.parse(String(raw)))); t.after(()=>ws.terminate()); await once(ws,'open');
    const command=async(type,input={})=>{const requestId=crypto.randomUUID(); ws.send(JSON.stringify({type,requestId,...input})); return until(()=>frames.find(f=>f.requestId===requestId));};
    const ready=await command('auth',{accessToken:who}); return {ws,frames,command,ready};
  };
  const create=async(input=creation())=>{ const r=await api('alice','rooms',input); assert.equal(r.status,200,JSON.stringify(r)); return r.data.room.id; };
  return {runtime,state,db,api,room,storage,connect,create};
}
test('official catalog preserves configured order, excludes invalid and private IDs, and stays available with managed rooms off', async t => {
  const configured = [
    { id: 'nightcord-default', name: '作业', description: '官方作业频道' },
    { id: 'nightcord-study', name: '自习室', description: '官方自习频道' },
    { id: 'nightcord-study', name: '重复频道' },
    { id: 'r_' + 'a'.repeat(32), name: '用户房间' },
    { id: 'a'.repeat(64), name: '私人房间' },
    { id: '../private', name: '无效路径' },
    { id: 'Upper_Case', name: '会被客户端改写的 ID' },
    { id: 'blank', name: ' ' },
    null,
  ];
  const expected = configured.slice(0, 2).map(room => ({ ...room, kind: 'official' }));
  for (const value of [configured, JSON.stringify(configured)]) {
    const f = await fixture(t, { ROOMS_MODE: 'off', ROOMS_OFFICIAL: value });
    const config = await f.api(null, 'rooms/config');
    assert.equal(config.status, 200); assert.deepEqual(config.data.official, expected);
    assert.equal((await f.api(null, 'rooms')).status, 503);
  }
  const fallback = await fixture(t, { ROOMS_OFFICIAL: 'invalid json' });
  assert.equal((await fallback.api(null, 'rooms/config')).data.official[0].id, 'nightcord-default');
});

test('creation ledger enforces atomic quotas, idempotency, publication and independent moderation',async t=>{
  const f=await fixture(t,{ROOMS_MAX_OWNED:'1'}), input=creation();
  const results=await Promise.all([f.api('alice','rooms',input),f.api('alice','rooms',input)]);
  assert.equal(results[0].status,200,JSON.stringify(results)); assert.equal(results[1].data.room.id,results[0].data.room.id);
  const id=results[0].data.room.id;
  assert.equal((await f.api('alice','rooms',creation())).data.code,'creation_quota');
  assert.equal((await f.api('alice','rooms',{...input,name:'changed'})).data.code,'request_id_conflict');
  assert.equal((await f.api(null,'rooms')).data.rooms.length,1);
  assert.equal((await f.api('alice','rooms/'+id+'/moderation',{hidden:true,reason:'test'})).status,404);
  assert.equal((await f.api('eve','rooms/'+id+'/moderation',{hidden:true,reason:'test'})).status,200);
  await f.room(id).handle(profiles.alice,'update',{name:'renamed'});
  assert.equal((await f.api(null,'rooms')).data.rooms.length,0);
  await f.api('eve','rooms/'+id+'/moderation',{hidden:false,reason:'test'});
  await f.room(id).handle(profiles.alice,'update',{discoverability:'unlisted'});
  assert.equal((await f.api(null,'rooms')).data.rooms.length,0);
  assert.equal((await f.api('bob','me/rooms')).data.rooms.length,0);
});
test('invite-only privacy, last use race, idempotent acceptance, removal, bans and transfer revocation',async t=>{
  const f=await fixture(t), id=await f.create({...creation(),discoverability:'unlisted',joinPolicy:'invite'}), room=f.room(id);
  assert.equal((await f.api('bob','rooms/'+id)).status,404);
  const stranger=await f.connect(id,'eve'); assert.equal(stranger.ready.type,'error');
  const invite=(await room.handle(profiles.alice,'invite',{})).data;
  const results=await Promise.all(['bob','eve'].map(who=>room.handle(profiles[who],'accept',{secret:invite.secret})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
  const winner=results[0].status===200?'bob':'eve';
  assert.equal((await room.handle(profiles[winner],'accept',{secret:invite.secret})).status,200);
  const storage=await f.storage(id); assert.equal((await storage.exec('SELECT uses FROM invites'))[0].uses,1);
  const connected=await f.connect(id,winner); assert.equal(connected.ready.type,'ready');
  await room.handle(profiles.alice,'ban',{accountId:profiles[winner].id}); await until(()=>connected.ws.readyState>=2);
  assert.equal(await room.directPeer(profiles.alice.id,profiles[winner].id),null);
  assert.equal((await room.handle(profiles[winner],'accept',{secret:invite.secret})).status,404);
  await room.handle(profiles.alice,'unban',{accountId:profiles[winner].id});
  assert.equal((await room.handle(profiles[winner],'accept',{secret:invite.secret})).status,404);
  const fresh=(await room.handle(profiles.alice,'invite',{})).data;
  await room.handle(profiles[winner],'accept',{secret:fresh.secret});
  const old=(await room.handle(profiles.alice,'invite',{})).data;
  await room.handle(profiles.alice,'transfer',{accountId:profiles[winner].id});
  assert.equal((await room.handle(profiles.alice,'update',{name:'no'})).status,403);
  assert.equal((await room.handle(profiles.alice,'preview',{secret:old.secret})).status,404);
});
test('WS sends stay local; dedupe, conflicts, replies, history, archive and renewal preserve authorization',async t=>{
  const f=await fixture(t), id=await f.create(), room=f.room(id);
  await room.handle(profiles.bob,'join',{});
  const a=await f.connect(id,'alice'), b=await f.connect(id,'bob');
  assert.equal(a.ready.type,'ready',JSON.stringify(a.ready));
  const stateBefore=await f.db.prepare('SELECT * FROM room_directory').all(); const pass=f.state.passCalls;
  const input={clientMessageId:crypto.randomUUID(),text:'private text'};
  const saved=await a.command('send',input); assert.equal(saved.type,'ack'); assert.equal(saved.message.seq,1);
  await until(()=>b.frames.find(f=>f.type==='message'));
  assert.equal((await a.command('send',input)).message.seq,1);
  assert.equal((await a.command('send',{...input,text:'different'})).code,'message_id_conflict');
  assert.equal(f.state.passCalls,pass); assert.deepEqual((await f.db.prepare('SELECT * FROM room_directory').all()).results,stateBefore.results);
  assert.equal((await b.command('history')).messages[0].text,'private text');
  await delay(110); assert.equal((await b.command('history',{beforeSeq:2,afterSeq:0})).code,'invalid_sequence');
  await room.handle(profiles.alice,'archive',{});
  assert.equal((await b.command('send',{clientMessageId:crypto.randomUUID(),text:'no'})).code,'room_archived');
  assert.equal((await a.command('send',input)).message.seq,1);
  await delay(110); assert.equal((await b.command('history')).messages.length,1);
  assert.equal((await room.handle(profiles.eve,'join',{})).status,404);
  await delay(1000); const renewed=await a.command('auth',{accessToken:'alice'}); assert.equal(renewed.type,'ready'); assert.equal(renewed.messages,undefined);
});

test('managed rooms reject the third repeat and preserve idempotent retries', async t => {
  const f = await fixture(t), id = await f.create();
  const a = await f.connect(id, 'alice');
  const input = { clientMessageId: crypto.randomUUID(), text: '6767' };
  assert.equal((await a.command('send', input)).type, 'ack');
  assert.equal((await a.command('send', input)).message.seq, 1);
  await delay(800);
  assert.equal((await a.command('send', { clientMessageId: crypto.randomUUID(), text: '⑥⑦' })).type, 'ack');
  await delay(800);
  const denied = await a.command('send', { clientMessageId: crypto.randomUUID(), text: '6...7' });
  assert.equal(denied.code, 'message_repeated');
  assert.ok(denied.retryAfter > 0 && denied.retryAfter <= 60);
  assert.equal((await a.command('history')).messages.length, 2);
});
test('managed visibility persists per room, synchronizes tabs and filters rosters without hiding moderation or messages', async t => {
  const f = await fixture(t), id = await f.create(), room = f.room(id);
  await room.handle(profiles.bob, 'join', {});
  const alice = await f.connect(id, 'alice'), bob = await f.connect(id, 'bob'), tab = await f.connect(id, 'bob');
  assert.equal(bob.ready.visibility, 'online');
  assert.equal((await bob.command('room:visibility', { visibility: 'bad' })).code, 'invalid_visibility');
  const offline = await bob.command('room:visibility', { visibility: 'offline', userId: profiles.alice.id });
  assert.equal(offline.visibility, 'offline'); assert.equal(offline.userId, profiles.bob.id);
  await until(() => tab.frames.some(v => v.type === 'room:visibility' && v.visibility === 'offline'));
  await until(() => alice.frames.some(v => v.type === 'presence' && !v.online.includes(profiles.bob.id) && v.members?.some(m => m.id === profiles.bob.id)));
  const mark = alice.frames.length;
  assert.equal((await tab.command('room:visibility', { visibility: 'hidden' })).visibility, 'hidden');
  await until(() => alice.frames.slice(mark).some(v => v.type === 'presence' && !v.online.includes(profiles.bob.id) && !v.members.some(m => m.id === profiles.bob.id)));
  assert.ok(!alice.frames.some(v => v.type === 'room:visibility'), 'preferences go only to the same account');
  assert.ok(!(await f.api('alice', 'rooms/' + id + '/members?view=roster')).data.members.some(m => m.id === profiles.bob.id));
  assert.ok((await f.api('alice', 'rooms/' + id + '/members')).data.members.some(m => m.id === profiles.bob.id), 'owner can still manage a hidden member');
  const sent = await bob.command('send', { clientMessageId: crypto.randomUUID(), text: 'Hidden but chatting' });
  assert.equal(sent.type, 'ack'); await until(() => alice.frames.some(v => v.message?.text === 'Hidden but chatting'));
  const other = await f.create(creation('other')); await f.room(other).handle(profiles.bob, 'join', {});
  assert.equal((await f.connect(other, 'bob')).ready.visibility, 'online');
  await delay(1000);
  assert.equal((await bob.command('auth', { accessToken: 'bob' })).visibility, 'hidden');
  for (const peer of [alice, bob, tab]) { peer.ws.close(); await once(peer.ws, 'close'); }
  const returned = await f.connect(id, 'bob');
  assert.equal(returned.ready.visibility, 'hidden');
  assert.ok(!returned.ready.online.includes(profiles.bob.id)); assert.ok(!returned.ready.members.some(m => m.id === profiles.bob.id));
  assert.equal((await returned.command('room:visibility', { visibility: 'online' })).visibility, 'online');
  const newcomer = await f.connect(id, 'alice'); assert.ok(newcomer.ready.online.includes(profiles.bob.id));
});

test('visibility policies validate owner authority, retain legacy defaults and remain isolated per room', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('alice', 'rooms', { ...creation(), visibilityPolicy: 'bad' })).data.code, 'invalid_visibility_policy');
  const input = creation(), id = await f.create(input), room = f.room(id);
  assert.equal((await room.handle(profiles.alice, 'get', {})).data.room.visibilityPolicy, 'hidden');
  await room.handle(profiles.bob, 'join', {});
  assert.equal((await room.handle(profiles.bob, 'update', { visibilityPolicy: 'online' })).data.code, 'owner_required');
  assert.equal((await room.handle(profiles.alice, 'update', { visibilityPolicy: null })).data.code, 'invalid_visibility_policy');
  assert.equal((await room.handle(profiles.alice, 'update', { visibilityPolicy: ['online'] })).data.code, 'invalid_visibility_policy');
  assert.equal((await room.handle(profiles.alice, 'update', { visibilityPolicy: 'offline' })).data.room.visibilityPolicy, 'offline');
  const bob = await f.connect(id, 'bob');
  assert.equal((await bob.command('room:visibility', { visibility: 'hidden' })).code, 'visibility_not_allowed');
  assert.equal((await bob.command('room:visibility', { visibility: 'offline' })).visibility, 'offline');
  const other = await f.create({ ...creation('Other'), visibilityPolicy: 'online' });
  assert.equal((await f.room(other).handle(profiles.alice, 'get', {})).data.room.visibilityPolicy, 'online');
  assert.equal((await room.handle(profiles.alice, 'get', {})).data.room.visibilityPolicy, 'offline');
  // Pre-policy metadata and creation ledgers still read/retry as fully permissive.
  const storage = await f.storage(id);
  await storage.exec("UPDATE room_meta SET data=json_remove(data,'$.visibilityPolicy')");
  assert.equal((await room.handle(profiles.alice, 'get', {})).data.room.visibilityPolicy, 'hidden');
  const legacy = JSON.stringify({ name: input.name, description: input.description, discoverability: input.discoverability, joinPolicy: input.joinPolicy });
  await f.db.prepare('UPDATE room_creations SET payload=?,payload_hash=? WHERE room_id=?').bind(legacy, 'old-hash', id).run();
  assert.equal((await f.api('alice', 'rooms', input)).data.room.id, id);
});

test('tightened visibility suspends all tabs without exposing identity and requires current-policy consent', async t => {
  const f = await fixture(t), id = await f.create(), room = f.room(id);
  await room.handle(profiles.bob, 'join', {});
  const alice = await f.connect(id, 'alice'), bob = await f.connect(id, 'bob'), tab = await f.connect(id, 'bob');
  assert.equal((await bob.command('room:visibility', { visibility: 'hidden' })).visibility, 'hidden');
  await room.handle(profiles.alice, 'update', { visibilityPolicy: 'offline' });
  await until(() => [bob, tab].every(peer => peer.frames.some(v => v.type === 'room:visibility-required')));
  const gate = bob.frames.find(v => v.type === 'room:visibility-required');
  assert.equal(gate.visibility, 'hidden'); assert.equal(gate.messages, undefined);
  assert.equal(gate.room.visibilityPolicy, 'offline');
  assert.ok(!(await f.api('alice', 'rooms/' + id + '/members?view=roster')).data.members.some(m => m.id === profiles.bob.id));
  assert.equal((await f.api('bob', 'rooms/' + id + '/members')).data.code, 'visibility_confirmation_required');
  for (const type of ['send', 'history', 'members']) {
    assert.equal((await bob.command(type, { clientMessageId: crypto.randomUUID(), text: 'blocked' })).code, 'visibility_confirmation_required');
  }
  const mark = bob.frames.length;
  await alice.command('send', { clientMessageId: crypto.randomUUID(), text: 'Only accepted participants receive this' });
  await bob.command('history');
  assert.ok(!bob.frames.slice(mark).some(v => v.type === 'message' || v.type === 'presence'));
  const returned = await f.connect(id, 'bob');
  assert.equal(returned.ready.type, 'room:visibility-required'); assert.equal(returned.ready.visibility, 'hidden');
  assert.equal((await returned.command('room:visibility', { visibility: 'offline' })).code, 'visibility_confirmation_required');
  await room.handle(profiles.alice, 'update', { visibilityPolicy: 'online' });
  assert.equal((await tab.command('room:visibility', { visibility: 'online', confirmPolicy: 'offline' })).code, 'visibility_confirmation_required');
  const accepted = await bob.command('room:visibility', { visibility: 'online', confirmPolicy: 'online' });
  assert.equal(accepted.visibility, 'online');
  await until(() => [bob, tab, returned].every(peer => peer.frames.some(v => v.type === 'ready' && v.visibility === 'online' && v.room.visibilityPolicy === 'online')));
  assert.equal((await bob.command('send', { clientMessageId: crypto.randomUUID(), text: 'Accepted' })).type, 'ack');
  // The owner follows the same rule and can still manage the room while paused.
  await room.handle(profiles.alice, 'update', { visibilityPolicy: 'hidden' });
  assert.equal((await alice.command('room:visibility', { visibility: 'hidden' })).visibility, 'hidden');
  await room.handle(profiles.alice, 'update', { visibilityPolicy: 'offline' });
  assert.equal((await alice.command('history')).code, 'visibility_confirmation_required');
  assert.ok((await room.handle(profiles.alice, 'members', {})).data.members.some(m => m.id === profiles.alice.id));
  await room.handle(profiles.alice, 'update', { visibilityPolicy: 'hidden' });
  await until(() => alice.frames.some(v => v.type === 'ready' && v.visibility === 'hidden'));
  assert.ok(!(await f.connect(id, 'alice')).ready.online.includes(profiles.alice.id));
});

test('D1 failure retains durable outbox and hidden confirmation waits for repair; old snapshots cannot resurrect refs',async t=>{
  const f=await fixture(t), id=await f.create(), room=f.room(id), storage=await f.storage(id);
  await room.handle(profiles.bob,'join',{});
  const old=(await f.db.prepare("SELECT * FROM account_room_refs WHERE account_id='sekai:bob'").first());
  await f.db.exec('ALTER TABLE room_directory RENAME TO unavailable_directory');
  const hidden=await room.handle(profiles.alice,'update',{discoverability:'unlisted'}); assert.equal(hidden.status,202);
  assert.ok((await storage.exec('SELECT * FROM outbox')).length);
  const a=await f.connect(id,'alice'); assert.equal((await a.command('send',{clientMessageId:crypto.randomUUID(),text:'works offline directory'})).type,'ack');
  await f.db.exec('ALTER TABLE unavailable_directory RENAME TO room_directory');
  await storage.exec('UPDATE outbox SET due=0'); await room.testAlarm();
  assert.equal((await f.api(null,'rooms')).data.rooms.length,0);
  await room.handle(profiles.bob,'leave',{});
  const current=await f.db.prepare("SELECT * FROM account_room_refs WHERE account_id='sekai:bob'").first(); assert.ok(current.membership_version>old.membership_version); assert.equal(current.status,'left');
  await storage.exec('INSERT INTO outbox VALUES(?,?,?,0,0)', 'sekai:bob', old.membership_version, JSON.stringify({accountId:'sekai:bob',roomId:id,status:'active',name:old.name_at_join,joinedAt:old.joined_at}));
  await room.testAlarm();
  assert.equal((await f.db.prepare("SELECT status FROM account_room_refs WHERE account_id='sekai:bob'").first()).status,'left');
  assert.equal((await room.handle(profiles.bob,'members',{})).status,404);
});
test('unknown objects create no schema and expired passive sockets cannot receive',async t=>{
  let script=await readFile('dist/chat.js','utf8');
  script=script.replace(/(var ManagedRoom = class extends \w+ \{)/,'$1\n testExpire() { for (const ws of this.ctx.getWebSockets()) {const s=ws.deserializeAttachment(); s.expiresAt=Date.now()-1; ws.serializeAttachment(s);} }');
  const f=await fixture(t,{},script), unknown='r_'+ 'f'.repeat(32);
  assert.equal((await f.api('bob','rooms/'+unknown)).status,404);
  assert.equal((await (await f.storage(unknown)).exec("SELECT name FROM sqlite_master WHERE name='room_meta'")).length,0);
  const id=await f.create(), a=await f.connect(id,'alice'); await f.room(id).testExpire(); await f.room(id).testAlarm(); await until(()=>a.ws.readyState>=2);
});
test('100 distinct sends have bounded moderation costs at 1, 10 and 50 members, with no external calls',async t=>{
  let script=await readFile('dist/chat.js','utf8');
  script=script.replace('return this.storage.sql;',`return {exec: (...args) => {
    const cursor=this.storage.sql.exec(...args), rows=cursor.toArray();
    this.cost ||= {read:0,write:0}; this.cost.read+=cursor.rowsRead; this.cost.write+=cursor.rowsWritten;
    return {toArray:()=>rows,one:()=>rows[0],[Symbol.iterator]:()=>rows[Symbol.iterator]()};
  }};`).replace(/(var ManagedRoom = class extends \w+ \{)/,`$1
    testCosts(reset=false) {const c=this.store.cost; if(reset)this.store.cost={read:0,write:0}; return c;}
  `).replace('Date.now() + 750','Date.now()');
  // Accelerate only the test clock's sending interval, leaving the transaction intact.
  const f=await fixture(t,{},script), results=[];
  for(const count of [1,10,50]) {
    const id=await f.create(),room=f.room(id);
    for(let n=1;n<count;n++)await room.handle({...profiles.bob,id:'sekai:member'+n},'join',{});
    const a=await f.connect(id,'alice'); await room.testCosts(true); const pass=f.state.passCalls;
    for(let n=0;n<100;n++)assert.equal((await a.command('send',{clientMessageId:crypto.randomUUID(),text:`budget ${n}`})).type,'ack');
    const costs=await room.testCosts(); assert.equal(costs.write,600); assert.equal(f.state.passCalls,pass);
    if (results.length) assert.equal(costs.write, results[0].rowsWritten, 'cost does not grow with member count');
    const storage=await f.storage(id);assert.equal((await storage.exec('SELECT * FROM outbox')).length,0);
    results.push({members:count,messages:100,rowsRead:costs.read,rowsWritten:costs.write,passCalls:0}); a.ws.close();
  }
  if(process.env.ROOM_COST_OUTPUT) { const {writeFile}=await import('node:fs/promises'); await writeFile(process.env.ROOM_COST_OUTPUT,JSON.stringify(results,null,2)+'\n'); }
});
test('disk restart recovers pending publication, creation acknowledgement and message idempotency',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'), {tmpdir}=await import('node:os'), {join}=await import('node:path');
  const path=await mkdtemp(join(tmpdir(),'nightcord-rooms-'));
  let f=await fixture(t,{},undefined,path), input=creation(), id=await f.create(input);
  const a=await f.connect(id,'alice'), payload={clientMessageId:crypto.randomUUID(),text:'survives restart'};
  assert.equal((await a.command('send',payload)).message.seq,1);
  assert.equal((await a.command('room:visibility', { visibility: 'hidden' })).visibility, 'hidden');
  await f.db.exec('ALTER TABLE room_directory RENAME TO unavailable_directory');
  assert.equal((await f.room(id).handle(profiles.alice,'update',{discoverability:'unlisted',visibilityPolicy:'offline'})).status,202);
  await f.db.prepare("UPDATE room_creations SET state='pending'").run();
  a.ws.terminate(); await f.runtime.dispose();
  f=await fixture(t,{},undefined,path,false);
  await f.db.exec('ALTER TABLE unavailable_directory RENAME TO room_directory');
  const storage=await f.storage(id); await storage.exec('UPDATE outbox SET due=0');
  assert.equal((await f.api('alice','rooms',input)).data.room.id,id);
  assert.equal((await f.api(null,'rooms')).data.rooms.length,0);
  const b=await f.connect(id,'alice');
  assert.equal(b.ready.type, 'room:visibility-required'); assert.equal(b.ready.room.visibilityPolicy, 'offline');
  assert.equal(b.ready.visibility, 'hidden'); assert.equal(b.ready.messages, undefined);
  assert.equal((await b.command('room:visibility', { visibility: 'offline', confirmPolicy: 'offline' })).visibility, 'offline');
  assert.equal(b.frames.find(frame => frame.type === 'ready').messages[0].text, payload.text);
  assert.equal((await b.command('send',payload)).message.seq,1);
  b.ws.terminate(); await f.runtime.dispose(); await rm(path,{recursive:true,force:true});
});
test('state, outbox and recovery alarm roll back together on storage failure',async t=>{
  const f=await fixture(t), id=await f.create(), storage=await f.storage(id);
  const before=await storage.exec('SELECT * FROM room_meta');
  await storage.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.equal((await f.room(id).handle(profiles.bob,'join',{})).status,503);
  assert.deepEqual(await storage.exec('SELECT * FROM room_meta'),before);
  assert.equal((await storage.exec("SELECT * FROM members WHERE account_id='sekai:bob'")).length,0);
});
test('managed source DM verifies both current members and rejects legacy source routing',async t=>{
  const f=await fixture(t),id=await f.create();await f.room(id).handle(profiles.bob,'join',{});
  const input={peerId:profiles.bob.id,sourceRoom:id,sourceType:'managed'};
  assert.equal((await f.api('alice','dm/conversations',input)).status,200);
  assert.equal((await f.api('eve','dm/conversations',input)).data.code,'peer_unavailable');
  assert.equal((await f.api('alice','dm/conversations',{...input,sourceType:undefined})).data.code,'invalid_room');
  await f.room(id).handle(profiles.alice,'remove',{accountId:profiles.bob.id});
  await delay(1100);
  assert.equal((await f.api('alice','dm/conversations',input)).data.code,'peer_unavailable');
});
test('old D1 acknowledgement cannot erase a newer publication queued during delivery',async t=>{
  let script=await readFile('dist/chat.js','utf8');
  script=script.replace(/(var ManagedRoom = class extends \w+ \{)/,`$1
    testHold() { this.delivery.gate = new Promise(resolve => this.delivery.release = resolve); }
    testWaiting() { return !!this.delivery.waiting; }
    testRelease() {this.delivery.gate=null; this.delivery.release();}
  `).replace('await apply(this.env, row.destination, row.version, row.payload);','this.waiting=true; if(this.gate) await this.gate; await apply(this.env, row.destination, row.version, row.payload);');
  const f=await fixture(t,{},script),id=await f.create(),room=f.room(id);
  await room.testHold(); const rename=room.handle(profiles.alice,'update',{name:'new name'});
  await until(()=>room.testWaiting());
  const hide=room.handle(profiles.alice,'update',{discoverability:'unlisted'});
  const storage=await f.storage(id);
  await until(async()=>JSON.parse((await storage.exec("SELECT payload FROM outbox WHERE destination='directory'"))[0]?.payload||'{}').listed===0);
  await room.testRelease(); assert.equal((await rename).status,200); assert.equal((await hide).status,200);
  assert.equal((await f.api(null,'rooms')).data.rooms.length,0); assert.equal((await storage.exec('SELECT * FROM outbox')).length,0);
});
