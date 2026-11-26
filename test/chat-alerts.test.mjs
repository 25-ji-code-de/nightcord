/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const me = { id: 'sekai:me', displayName: 'Same' };
const peer = { id: 'sekai:peer', displayName: 'Same' };
const atMe = '<$SEKAI:Mention:type=user;display=Same:sekai:me>';
const atAll = '<$SEKAI:Mention:type=all:>';
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const values = new Map(), timers = new Map(), plays = [], notices = [];
  let now = 100000, next = 0, blocked = false, viewing = false;
  const events = { addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    window: events, document: { ...events, hidden: false, hasFocus: () => false, querySelector: () => null },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.set(++next, { fn, at: now + ms }); return next; },
    clearTimeout: id => timers.delete(id),
    localStorage: { getItem: key => { if (blocked) throw Error('blocked'); return values.get(key) || null; },
      setItem: (key, value) => { if (blocked) throw Error('blocked'); values.set(key, value); } },
    AlertDelivery: class {
      announce() {} viewing() { return viewing; } destroy() {}
      async deliver(key, callback) { await callback(); }
    },
    AlertSettingsView: class { refresh() {} refreshActivity() {} destroy() {} },
    AlertBanner: class { dismiss() {} },
    AlertSounds: class { stop() {} async play(kind, volume) { plays.push({ kind, volume }); return true; } }
  });
  for (const file of ['event-bus.js', 'js/renderer/resources.js', 'js/renderer/parser.js', 'mention-service.js',
    'js/services/message-alerts.js', 'js/ui/alert-preferences.js', 'js/ui/chat-alerts.js']) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  }
  const bus = vm.runInContext('new EventBus()', context);
  const mentions = vm.runInContext('new window.NightcordMentions(new SekaiParser())', context);
  const ui = { eventBus: bus, currentRoom: 'test', currentUser: me, messages: [], roster: [], mentions,
    elements: {}, mentionsReady: true, isAtBottom: false };
  context.ui = ui;
  const alerts = vm.runInContext('new ChatAlerts(ui)', context);
  alerts.notice = (text, message) => notices.push({ text, message });
  alerts.renderUnread = () => {};
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry; timers.delete(id); now = timer.at; timer.fn(); await flush();
    }
    now = end; await flush();
  };
  const message = (text, timestamp = now, profile = peer) => ({ text, timestamp, profile });
  const receive = (text, timestamp = now, user = peer) => alerts.receive({ name: user.displayName, user, message: text, timestamp });
  return { ui, bus, alerts, plays, notices, values, timers, message, receive, advance,
    blocked: value => { blocked = value; }, viewing: value => { viewing = value; } };
}

test('reply ownership uses stored identity, supports both protocols and preserves overlapping reasons', () => {
  const h = harness();
  h.ui.messages = [h.message('mine', 10, me), h.message('same name, different person', 20, peer)];
  assert.deepEqual(Array.from(h.alerts.reasons(h.message(`<$SEKAI:Reply::10> ${atMe} ${atAll}`))), ['mention', 'reply', 'everyone', 'message']);
  assert.deepEqual(Array.from(h.alerts.reasons(h.message('[re:10|preview] response'))), ['reply', 'message']);
  for (const text of ['<$SEKAI:Reply::20>', '<$SEKAI:Reply::999>', '<$SEKAI:Reply::NaN>', '<$SEKAI:Reply::-10>',
    '`<$SEKAI:Reply::10>`', '```\n<$SEKAI:Reply::10>\n```', '> <$SEKAI:Reply::10>', '<$SEKAI:Code::[re:10]>']) {
    assert.deepEqual(Array.from(h.alerts.reasons(h.message(text))), ['message'], text);
  }
  h.ui.currentUser = { ...me, displayName: 'Renamed' };
  assert.ok(h.alerts.reasons(h.message('<$SEKAI:Reply::10>')).includes('reply'));
  assert.deepEqual(Array.from(h.alerts.reasons(h.message(atMe, 30, me))), []);
  assert.deepEqual(Array.from(h.alerts.reasons({ ...h.message(atMe), sender: me })), []);
  h.alerts.destroy();
});

test('history, self, duplicate, AI and reconnect messages never produce live feedback', async () => {
  const h = harness();
  h.receive(atMe, 1); assert.equal(h.plays.length, 0);
  h.bus.emit('room:synced'); h.receive(atMe, 2); await flush();
  assert.equal(h.plays.length, 1);
  h.receive(atMe, 2); h.receive(atMe, 3, me);
  h.alerts.receive({ message: atMe, user: peer, timestamp: 4, isNako: true });
  h.bus.emit('connection:close'); h.receive(atMe, 5);
  await h.advance(3000); h.bus.emit('room:synced'); h.receive(atMe, 6); await flush();
  assert.equal(h.plays.length, 2); assert.equal(h.notices.length, 2);
  h.alerts.destroy();
});

test('one message plays the highest enabled cue, and away-only checks other tabs', async () => {
  const h = harness(); h.bus.emit('room:synced');
  h.ui.messages = [h.message('mine', 10, me)];
  h.receive(`<$SEKAI:Reply::10> ${atMe}`, 11); await flush();
  assert.deepEqual(h.plays.map(p => p.kind), ['mention']);
  await h.advance(2100);
  h.alerts.preferences.save(p => { p.mentionSound = false; });
  h.receive(`<$SEKAI:Reply::10> ${atMe}`, 12); await flush();
  assert.deepEqual(h.plays.map(p => p.kind), ['mention', 'reply']);
  await h.advance(2100); h.viewing(true); h.receive('ordinary', 13); await flush();
  assert.equal(h.plays.length, 2);
  h.viewing(false); h.receive('ordinary', 14); await flush();
  assert.equal(h.plays.at(-1).kind, 'message');
  h.alerts.preferences.save(p => { p.awayOnly = true; }); h.viewing(true);
  await h.advance(2100); h.receive('<$SEKAI:Reply::10>', 15); await flush();
  assert.equal(h.plays.length, 3);
  h.alerts.destroy();
});

test('muted, paused and zero-volume alerts retain classification without audible backlog', async () => {
  const h = harness(); h.bus.emit('room:synced');
  for (const setting of [{ sound: false }, { sound: true, volume: 0 }, { volume: .5, pausedUntil: 200000 }]) {
    h.alerts.preferences.save(p => Object.assign(p, setting));
    h.receive(atMe); await h.advance(3000);
  }
  assert.equal(h.plays.length, 0);
  assert.equal(h.notices.length, 2, 'pausing suppresses banners as well');
  assert.ok(h.alerts.reasons(h.message(atMe)).includes('mention'));
  h.alerts.preferences.save(p => { p.pausedUntil = 0; }); await h.advance(3000);
  assert.equal(h.plays.length, 0, 'unpausing does not play old events');
  h.receive(atMe); await flush(); assert.equal(h.plays.length, 1);
  h.alerts.destroy();
});

test('disabled mention and everyone cues never fall through to the ordinary message sound', async () => {
  const h = harness(); h.bus.emit('room:synced');
  h.alerts.preferences.save(p => { p.message = 'always'; p.mentionSound = false; });
  h.receive(atAll, 1); await h.advance(3000);
  h.receive(atMe, 2); await h.advance(3000);
  assert.equal(h.plays.length, 0);
  assert.equal(h.notices.length, 2, 'visual alerts remain independent');
  h.receive('ordinary message', 3); await flush();
  assert.equal(h.plays[0].kind, 'message');
  h.alerts.destroy();
});

test('following debounces online/offline and ignores refreshes, duplicates and snapshots', async () => {
  const h = harness();
  h.alerts.preferences.save(p => { p.followed[peer.id] = { name: peer.displayName, online: true, offline: true }; });
  h.ui.roster = [{ profile: peer }]; h.bus.emit('user:joined', { user: peer, username: peer.displayName });
  h.bus.emit('room:synced'); await h.advance(3000); assert.equal(h.notices.length, 0);
  h.bus.emit('user:quit', { userId: peer.id, username: peer.displayName });
  await h.advance(7000); h.bus.emit('user:joined', { user: peer, username: peer.displayName });
  await h.advance(20000); assert.equal(h.notices.length, 0, 'short disconnect returns to the baseline');
  h.bus.emit('user:quit', { userId: peer.id, username: peer.displayName });
  await h.advance(14999); assert.equal(h.notices.length, 0);
  await h.advance(1); assert.match(h.notices[0].text, /离开/); assert.equal(h.plays.length, 0);
  h.bus.emit('user:joined', { user: peer, username: peer.displayName });
  h.bus.emit('user:joined', { user: peer, username: peer.displayName });
  await h.advance(2000); assert.equal(h.notices.length, 2); assert.equal(h.plays[0].kind, 'online');
  h.bus.emit('user:quit', { userId: peer.id, username: peer.displayName });
  h.bus.emit('connection:close'); await h.advance(20000); assert.equal(h.notices.length, 2);
  h.alerts.destroy();
});

test('visibility changes cancel pending presence alerts without announcing a fabricated join or leave', async () => {
  const h = harness(); h.bus.emit('room:synced');
  h.alerts.preferences.save(p => { p.presence = 'all'; p.onlineNotice = true; p.offlineNotice = true; });
  h.bus.emit('user:joined', { user: peer, username: peer.displayName });
  await h.advance(500);
  h.bus.emit('user:quit', { userId: peer.id, username: peer.displayName, silent: true });
  await h.advance(20000);
  assert.equal(h.notices.length, 0); assert.equal(h.plays.length, 0);
  h.bus.emit('user:joined', { user: peer, username: peer.displayName, silent: true });
  await h.advance(3000);
  assert.equal(h.notices.length, 0);
  h.bus.emit('user:quit', { userId: peer.id, username: peer.displayName });
  await h.advance(15000);
  assert.equal(h.notices.length, 1, 'a later real departure still notifies');
  h.alerts.destroy();
});

test('canceling follows, switching identity/rooms and destroying fence delayed work', async () => {
  for (const action of ['cancel', 'identity', 'room', 'destroy']) {
    const h = harness(); h.bus.emit('room:synced');
    h.alerts.preferences.save(p => { p.presence = 'all'; });
    h.bus.emit('user:joined', { user: peer, username: peer.displayName });
    if (action === 'cancel') { h.alerts.preferences.save(p => { p.presence = 'off'; }); h.alerts.settingsChanged(); }
    if (action === 'identity') { h.ui.currentUser = peer; h.bus.emit('session:updated'); }
    if (action === 'room') { h.ui.currentRoom = 'elsewhere'; h.bus.emit('room:joining'); }
    if (action === 'destroy') h.alerts.destroy();
    await h.advance(20000); assert.equal(h.notices.length, 0, action); assert.equal(h.plays.length, 0, action);
    if (action !== 'destroy') h.alerts.destroy();
    assert.equal(h.timers.size, 0);
  }
});

test('preferences isolate identities and rooms, validate input and survive unavailable storage in memory', () => {
  const h = harness(), p = h.alerts.preferences;
  p.save(v => { v.volume = 12; v.presence = 'nonsense'; v.followed[peer.id] = { name: 'Peer', online: true }; });
  assert.equal(p.read().volume, 1); assert.equal(p.read().presence, 'followed');
  h.ui.currentRoom = 'other'; assert.equal(p.read().volume, .5); assert.equal(Object.keys(p.read().followed).length, 0);
  h.ui.currentRoom = 'test'; h.ui.currentUser = peer; assert.equal(p.read().volume, .5);
  h.ui.currentUser = me; assert.equal(p.read().volume, 1);
  h.blocked(true); assert.equal(p.save(v => { v.volume = .2; }), false); assert.equal(p.read().volume, .2);
  h.alerts.destroy();
});
