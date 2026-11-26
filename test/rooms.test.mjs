/* SPDX-License-Identifier: AGPL-3.0-only */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function fixture() {
  const events = new Map();
  const bus = { on: (key, cb) => { events.set(key, cb); return () => events.delete(key); }, emit() {} };
  const context = vm.createContext({ AbortController, AbortSignal, crypto, setTimeout, clearTimeout, fetch: async () => ({ok:true, json:async()=>({mode:'on'})}),
    ManagedRoomProtocol: class {}, WebSocketManager: class { pauseAutoReconnect() {} disconnect() {} }, });
  vm.runInContext(readFileSync('js/services/rooms.js', 'utf8') + '\nglobalThis.RoomManager = RoomManager;', context);
  return new context.RoomManager({ eventBus: bus, getAccessToken: async () => 'token' });
}
const message = seq => ({ seq, senderId: 'sekai:a', clientMessageId: String(seq), sender: {displayName:'a'} });
test('managed room ack/echo deduplicate and never advance over a missing sequence', async () => {
  const m = fixture(); await m.configPromise; m.user = {id:'sekai:a'}; m.syncedSeq=0; m.loaded=true; m.sync = () => {};
  m.receive({type:'ack',message:message(3)}); assert.equal(m.syncedSeq,0);
  m.receive({type:'message',message:message(1)}); assert.equal(m.syncedSeq,1);
  m.receive({type:'message',message:message(2)}); assert.equal(m.syncedSeq,3);
  m.receive({type:'message',message:message(3)}); assert.equal(m.messages.size,3); m.destroy();
});
test('account reset discards messages, drafts, invitations and account list cache', async () => {
  const m=fixture(); await m.configPromise; m.secret='secret'; m.messages.set(1,message(1)); m.pending.set('a',{}); m.cache.set('a',{});
  m.reset(); assert.equal(m.messages.size,0); assert.equal(m.pending.size,0); assert.equal(m.cache.size,0); assert.equal(m.secret,null); m.destroy();
});
test('room switch ignores late preview responses', async () => {
  const m=fixture(); await m.configPromise;
  let finish; m.call=()=>new Promise(resolve=>finish=resolve);
  const pending=m.enter('r_old'); m.disconnect(); finish({room:{id:'r_old'},role:null}); await pending;
  assert.equal(m.room,null); m.destroy();
});

test('a late join cannot reconnect the next room or consume its invitation', async () => {
  const m = fixture(); await m.configPromise;
  m.room = { id: 'r_old' }; m.secret = 'old-invite';
  let finish, connects = 0;
  m.call = () => new Promise(resolve => { finish = resolve; }); m.connect = () => { connects++; };
  const joining = m.join();
  m.disconnect(); m.room = { id: 'r_next', revision: 1 }; m.role = 'member'; m.secret = 'next-invite';
  finish({ room: { id: 'r_old', revision: 1 }, role: 'member' }); await joining;
  assert.equal(connects, 0); assert.equal(m.secret, 'next-invite'); m.destroy();
});

test('blocked session storage does not stop startup or in-memory invitation handling', () => {
  const changes = [];
  const c = vm.createContext({ URLSearchParams, location: { search: '?room=r_' + 'a'.repeat(32), hash: '#invite=' + 'b'.repeat(64), pathname: '/' },
    history: { replaceState: (...args) => changes.push(args) } });
  vm.runInContext("Object.defineProperty(globalThis, 'sessionStorage', { get() { throw new Error('Storage blocked'); } });", c);
  vm.runInContext(readFileSync('js/app/room-destination.js', 'utf8') + '\nglobalThis.destination = RoomDestination;', c);
  assert.doesNotThrow(() => c.destination.capture());
  assert.equal(changes[0][2], '/?room=r_' + 'a'.repeat(32));
  assert.equal(c.destination.pending.secret, 'b'.repeat(64));
  assert.doesNotThrow(() => c.destination.save());
  assert.doesNotThrow(() => c.destination.clear()); assert.equal(c.destination.pending, null);
});

test('managed mention candidates use current visible membership rather than historical senders', () => {
  const c = vm.createContext({});
  vm.runInContext(readFileSync('js/ui/roster.js', 'utf8') + '\nglobalThis.RosterView = RosterView;', c);
  const visible = { id: 'sekai:visible', displayName: 'Visible' };
  const ui = { managedChat: {}, roster: [], roomMembers: new Map([[visible.id, visible]]),
    messages: [{ user: 'Hidden', profile: { id: 'sekai:hidden', displayName: 'Hidden' } },
      { user: 'Removed', profile: { id: 'sekai:removed', displayName: 'Removed' } }],
    generateAvatar: name => ({ name }) };
  const users = new c.RosterView(ui).getAllUsers();
  assert.deepEqual(Array.from(users, user => user.profile.id), [visible.id]);
});
test('room destination removes secret from address bar and validates callback data', () => {
  const values=new Map(); const history=[];
  const c=vm.createContext({URLSearchParams,location:{search:'?room=r_'+ 'a'.repeat(32),hash:'#invite='+ 'b'.repeat(64),pathname:'/'},history:{replaceState:(...args)=>history.push(args)},sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});
  vm.runInContext(readFileSync('js/app/room-destination.js','utf8')+'\nRoomDestination.capture(); RoomDestination.save();',c);
  assert.equal(history[0][2],'/?room=r_'+ 'a'.repeat(32)); assert.equal(JSON.parse(values.get('nightcord-room-destination')).secret,'b'.repeat(64));
});
test('public configuration survives identity reset and stale management results cannot roll metadata back', async () => {
  const m=fixture(); await m.configPromise;
  let finish; m.fetcher=()=>new Promise(resolve=>finish=resolve);
  const configured=m.configure(); m.reset(); finish({ok:true,json:async()=>({mode:'on'})}); await configured; assert.equal(m.mode,'on');
  m.room={id:'r_one',revision:3,name:'new'}; m.role='member';
  m.call=async()=>({room:{id:'r_one',revision:2,name:'old'},role:'owner'});
  await m.action('',{},'PATCH'); assert.equal(m.room.name,'new'); assert.equal(m.role,'member'); m.destroy();
});

test('managed visibility waits for server confirmation, rejects errors and isolates room switches', async () => {
  const m = fixture(); await m.configPromise;
  const ready = visibility => m.receive({ type: 'ready', visibility, user: { id: 'sekai:a' }, room: { id: 'r_one' }, role: 'member', online: [], members: [] });
  ready('online');
  let finish; m.request = (type, input) => { assert.equal(type, 'room:visibility'); assert.equal(input.visibility, 'hidden'); return new Promise(resolve => { finish = resolve; }); };
  const save = m.setVisibility('hidden');
  assert.equal(m.visibilityState.pending, 'hidden'); assert.equal(m.visibilityState.visibility, 'online');
  m.receive({ type: 'room:visibility', userId: 'sekai:a', visibility: 'offline' });
  assert.equal(m.visibilityState.pending, 'hidden', 'other tabs cannot complete this request');
  m.receive({ type: 'room:visibility', userId: 'sekai:a', visibility: 'hidden' }); finish({}); await save;
  assert.equal(m.visibilityState.visibility, 'hidden'); assert.equal(m.visibilityState.pending, null);
  m.request = async () => { throw Object.assign(new Error('too fast'), { code: 'rate_limited' }); };
  assert.equal(await m.setVisibility('online'), false);
  assert.equal(m.visibilityState.visibility, 'hidden'); assert.equal(m.visibilityState.error, 'too fast');
  m.request = () => new Promise(resolve => { finish = resolve; });
  const stale = m.setVisibility('offline'); m.clearRoom(); ready('online'); finish({}); await stale;
  assert.equal(m.visibilityState.visibility, 'online'); assert.equal(m.visibilityState.error, '');
  ready(undefined); assert.equal(m.visibilityState.available, false); assert.equal(m.visibilityState.reason, 'unsupported');
  assert.equal(await m.setVisibility('hidden'), false); m.destroy();
});

test('a stale member fetch cannot reinsert an identity removed by a visibility snapshot', async () => {
  const m = fixture(); await m.configPromise; m.room = { id: 'r_one' }; m.role = 'member'; m.ready = true;
  let finish; m.call = path => { assert.match(path, /view=roster/); return new Promise(resolve => { finish = resolve; }); };
  const pending = m.refreshMembers();
  m.receive({ type: 'presence', online: [], members: [], silent: true });
  finish({ members: [{ id: 'sekai:hidden', status: 'active' }] }); await pending;
  assert.equal(m.members.length, 0); m.destroy();
});

test('room policy blocks disallowed choices and requires explicit consent before resuming', async () => {
  const m = fixture(); await m.configPromise;
  const own = { user: { id: 'sekai:a' }, role: 'member', room: { id: 'r_one', visibilityPolicy: 'offline', revision: 2 }, visibility: 'hidden' };
  m.receive({ ...own, type: 'room:visibility-required' });
  assert.equal(m.ready, false); assert.equal(m.visibilityState.visibility, 'hidden');
  assert.equal(await m.setVisibility('hidden'), false);
  assert.equal(await m.setVisibility('online'), false, 'an old client change is not consent');
  assert.equal(await m.setVisibility('offline', 'hidden'), false, 'a stale policy cannot authorize a change');
  m.request = async (type, input) => {
    assert.equal(input.confirmPolicy, 'offline'); assert.equal(input.visibility, 'offline');
    m.receive({ ...own, type: 'ready', visibility: 'offline', messages: [], members: [], online: [] });
  };
  assert.equal(await m.setVisibility('offline', 'offline'), true);
  assert.equal(m.ready, true); assert.equal(m.visibilityState.required, false);
  assert.equal(await m.setVisibility('hidden'), false);
  m.receive({ type: 'changed', room: { ...own.room, visibilityPolicy: 'online', revision: 3 } });
  assert.equal(await m.setVisibility('offline'), false);
  m.destroy();
});
