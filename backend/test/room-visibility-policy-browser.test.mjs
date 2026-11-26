/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('room visibility policy: owner settings, mobile consent, leaving, reconnecting and allowed choices', { timeout: 120000 }, async t => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) return res.writeHead(403).end();
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' })[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const runtime = createRuntime({}, { origin, inspectDurableObjects: true, bindings: { ROOMS_MODE: 'on', DM_MODE: 'on' },
    identities: { 'Bearer alice': 'alice', 'Bearer bob': 'bob' } });
  t.after(() => runtime.dispose());
  const base = String(await runtime.ready).replace(/\/$/, '');
  const db = await runtime.getD1Database('ROOM_DIRECTORY');
  await db.exec((await readFile('migrations/0001_rooms.sql', 'utf8')).replace(/\n/g, ' '));
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());
  const errors = [];
  async function pageFor(name, width) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce', isMobile: width < 600, hasTouch: width < 600 });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith(base)) return route.continue();
      if (url.includes('autocomplete.json')) return route.fulfill({ contentType: 'application/json', body: '{}' });
      return route.abort();
    });
    await context.addInitScript(({ base, name }) => {
      const original = window.fetch.bind(window), Socket = window.WebSocket;
      window.fetch = (url, options) => original(String(url).replace('https://chat.nightcord.de5.net', base), options);
      window.WebSocket = class extends Socket { constructor(url, protocols) { super(String(url).replace('wss://chat.nightcord.de5.net', base.replace(/^http/, 'ws')), protocols); } };
      localStorage.setItem('sekai_pass_access_token', name);
      localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
      localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: name, name }));
    }, { base, name });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready);
    return page;
  }
  async function clearLimits() {
    for (const id of await runtime.listDurableObjectIds('LIMITERS')) {
      await (await runtime.unsafeGetDurableObjectStorage('nightcord-chat', 'RateLimiter', { id })).exec('DELETE FROM rate_limit');
    }
  }
  const alice = await pageFor('alice', 1280), bob = await pageFor('bob', 390);
  const id = await alice.evaluate(async () => {
    const data = await nightcord.rooms.call('/rooms', { requestId: crypto.randomUUID(), name: '协作房', description: '', discoverability: 'listed', joinPolicy: 'open' });
    await nightcord.roomsView.enter(data.room.id); return data.room.id;
  });
  await bob.evaluate(async id => { await nightcord.roomsView.enter(id); await nightcord.rooms.join(); }, id);
  await bob.waitForFunction(() => nightcord.rooms.ready);
  await bob.evaluate(() => nightcord.rooms.setVisibility('hidden'));
  await alice.waitForFunction(() => !nightcord.rooms.members.some(user => user.id === 'sekai:bob'));
  async function policy(label) {
    await clearLimits();
    await alice.getByRole('button', { name: '房间信息', exact: true }).click();
    await alice.getByRole('button', { name: '房间设置', exact: true }).click();
    await alice.getByRole('radio', { name: label, exact: true }).check();
    await alice.getByRole('button', { name: '保存设置', exact: true }).click();
    await alice.getByText('房间设置已保存。', { exact: true }).waitFor();
    await alice.locator('.rooms-back').click();
    await alice.locator('.rooms-back').click();
  }
  await policy('允许显示为离线');
  const gate = bob.getByRole('region', { name: '确认房间显示规则' });
  await gate.waitFor();
  assert.equal(await bob.locator('#messageInput').isDisabled(), true);
  assert.equal(await gate.getByRole('button', { name: '确认新状态并继续' }).isDisabled(), true);
  assert.equal(await bob.evaluate(() => nightcord.rooms.visibilityState.visibility), 'hidden');
  assert.equal(await alice.evaluate(() => nightcord.rooms.members.some(user => user.id === 'sekai:bob')), false);
  assert.deepEqual(await gate.locator('select option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'online', 'offline']);
  const screenshots = resolve(root, 'backend/dist/visibility-policy-screenshots'); await mkdir(screenshots, { recursive: true });
  for (const [width, height] of [[390, 844], [812, 375]]) {
    await bob.setViewportSize({ width, height });
    assert.equal(await gate.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await gate.getByRole('button', { name: '暂时离开' }).scrollIntoViewIfNeeded();
    await bob.screenshot({ path: resolve(screenshots, `consent-${width}.png`) });
  }
  await bob.setViewportSize({ width: 390, height: 844 });
  await gate.getByLabel('继续聊天时的显示状态').selectOption('offline');
  await gate.getByRole('button', { name: '确认新状态并继续' }).click();
  await bob.waitForFunction(() => nightcord.rooms.ready && nightcord.rooms.visibilityState.visibility === 'offline');
  await alice.locator('#offline-users [data-user-id="sekai:bob"]').waitFor();
  await policy('不允许隐藏状态');
  await gate.waitFor();
  await gate.getByRole('button', { name: '暂时离开' }).click();
  assert.equal(await bob.evaluate(() => nightcord.rooms.room), null);
  await bob.evaluate(id => nightcord.roomsView.enter(id), id);
  await gate.waitFor();
  assert.equal(await bob.evaluate(() => nightcord.rooms.visibilityState.visibility), 'offline');
  assert.equal(await gate.getByRole('button', { name: '确认新状态并继续' }).isDisabled(), true);
  await gate.getByLabel('继续聊天时的显示状态').selectOption('online');
  await gate.getByRole('button', { name: '确认新状态并继续' }).click();
  await bob.waitForFunction(() => nightcord.rooms.ready && nightcord.rooms.visibilityState.visibility === 'online');
  await bob.locator('.sidebar-toggle').click();
  await bob.getByRole('button', { name: '设置', exact: true }).click();
  await bob.getByRole('button', { name: '成员动态与关注', exact: true }).click();
  assert.equal(await bob.getByRole('radio', { name: '从列表隐藏', exact: true }).isDisabled(), true);
  assert.equal(await bob.getByRole('radio', { name: '显示为离线', exact: true }).isDisabled(), true);
  assert.equal(await bob.getByRole('radio', { name: '正常显示', exact: true }).isEnabled(), true);
  await policy('允许完全隐藏');
  await bob.waitForFunction(() => nightcord.rooms.room.visibilityPolicy === 'hidden');
  assert.equal(await bob.getByRole('radio', { name: '从列表隐藏', exact: true }).isEnabled(), true);
  await bob.getByRole('radio', { name: '从列表隐藏', exact: true }).check();
  await bob.waitForFunction(() => nightcord.rooms.visibilityState.visibility === 'hidden' && !nightcord.rooms.visibilityState.pending);
  await bob.locator('.settings-close').click();
  await alice.evaluate(() => nightcord.joinRoom('nightcord-default'));
  await alice.waitForFunction(() => nightcord.chatRoom.wsManager.ready);
  assert.equal(await alice.evaluate(() => nightcord.ui.roomVisibility.available), true);
  assert.deepEqual(errors, []);
});
