/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const View = vm.runInNewContext(readFileSync(new URL('../js/ui/direct-messages.js', import.meta.url), 'utf8') + '\nDirectMessageView');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const view = Object.create(View.prototype);
  Object.assign(view, {
    viewVersion: 0, active: 'one', panel: { hidden: false }, older: {}, error: {}, status: {}, ui: { currentRoom: 'test' },
    log: { getClientRects: () => [{}] }, manager: { generation: 0, conversations: new Map([['one', { lastSeq: 1, peer: { id: 'other-one' } }], ['two', { lastSeq: 2, peer: { id: 'other-two' } }]]) },
    render() {}, renderThread() {}, markRead() {}, open() { this.changeView(); }, select(id) { this.active = id; this.changeView(); },
  });
  return view;
}

test('a delayed start cannot select a conversation after navigation or replace a newer start', async () => {
  const view = fixture(), first = deferred(), second = deferred();
  view.manager.create = peer => peer === 'bob' ? first.promise : second.promise;
  const openingFirst = view.start({ id: 'bob' });
  const openingSecond = view.start({ id: 'eve' });
  second.resolve({ id: 'two' }); await openingSecond;
  first.resolve({ id: 'one' }); await openingFirst;
  assert.equal(view.active, 'two');
  const late = deferred(); view.manager.create = () => late.promise;
  const opening = view.start({ id: 'bob' });
  view.changeView(); view.panel.hidden = true;
  late.resolve({ id: 'one' }); await opening;
  assert.equal(view.active, 'two'); assert.equal(view.panel.hidden, true);
});

test('loading one conversation does not block another, and its late error cannot change the new view', async () => {
  const view = fixture(), first = deferred(), second = deferred();
  const requested = [];
  view.manager.history = id => { requested.push(id); return id === 'one' ? first.promise : second.promise; };
  const firstLoad = view.load(true);
  view.select('two'); const secondLoad = view.load();
  assert.deepEqual(requested, ['one', 'two']);
  first.reject(new Error('Old history failed')); await firstLoad;
  assert.ok(view.loadingActive, 'the new history request is still pending');
  assert.equal(view.older.disabled, true); assert.equal(view.error.textContent, '');
  second.resolve(); await secondLoad;
  assert.equal(view.loadingActive, null); assert.equal(view.failedLoad, null);
});

test('an old account history result cannot release the new account loading state', async () => {
  const view = fixture(), old = deferred(), fresh = deferred();
  view.manager.history = () => old.promise;
  const oldLoad = view.load();
  view.manager.generation++; view.changeView();
  view.manager.history = () => fresh.promise;
  const newLoad = view.load();
  old.resolve(); await oldLoad;
  assert.ok(view.loadingActive); assert.equal(view.older.disabled, true);
  fresh.resolve(); await newLoad;
  assert.equal(view.loadingActive, null);
});
