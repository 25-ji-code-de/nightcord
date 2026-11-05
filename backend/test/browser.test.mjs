/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('browser identity, profiles, safe text, sync, replay, keyboard and mobile layout', { timeout: 90_000 }, async () => {
  const state = {};
  const runtime = createRuntime(state);
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    const wsBase = String(await runtime.ready).replace(/^http/, 'ws').replace(/\/$/, '');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
    const errors = [];
    const room = `browser-${crypto.randomUUID().slice(0, 12)}`;
    async function pageFor(authenticated, viewport) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (route.request().url().startsWith(origin)) return route.continue();
        if (route.request().url() === 'https://example.com/avatar.png') return route.fulfill({
          contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#9977dd"/></svg>',
        });
        return route.abort();
      });
      await context.addInitScript(({ wsBase, room, authenticated }) => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(url, protocols) { super(String(url).replace('wss://chat.nightcord.de5.net', wsBase).replace(/\/api\/room\/[^/]+\//, `/api/room/${room}/`), protocols); }
        };
        localStorage.setItem('nightcord-username', 'Shared name');
        if (authenticated) {
          localStorage.setItem('sekai_pass_access_token', 'local-test-token');
          localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
          localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: 'forged-cache', name: 'Forged cached name' }));
        }
      }, { wsBase, room, authenticated });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready);
      return page;
    }
    const guest = await pageFor(false, { width: 1280, height: 900 });
    const member = await pageFor(true, { width: 390, height: 844 });
    await guest.waitForFunction(() => nightcord.ui.roster.length === 2);
    const profiles = await guest.evaluate(() => nightcord.ui.roster.map(u => u.profile));
    assert.equal(new Set(profiles.map(u => u.id)).size, 2);
    assert.ok(profiles.every(u => u.displayName === 'Shared name'));
    assert.equal(await member.evaluate(() => nightcord.ui.currentUser.id), 'sekai:stable-subject');
    async function openOwnProfile(page, authenticated) {
      if (page.viewportSize().width <= 768 && !await page.locator('.sidebar').evaluate(el => el.classList.contains('show'))) {
        await page.locator('.chat-header').click({ position: { x: 10, y: 20 } });
      }
      const badge = authenticated ? page.locator('.identity-badge--verified') : page.getByText('访客', { exact: true });
      await page.locator('#voice-users .voice-user').filter({ has: badge }).click();
    }
    await openOwnProfile(member, true);
    const dialog = member.locator('dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('.profile-bio').textContent(), '<img onerror=alert(1)> signature');
    assert.equal(await dialog.locator('.profile-bio img').count(), 0);
    assert.equal(await dialog.locator('a').getAttribute('href'), 'https://id.nightcord.de5.net/settings');
    assert.ok(await dialog.locator('.profile-avatar img').count());
    assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    await member.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await member.evaluate(() => document.activeElement.matches('.voice-user')), true);
    const text = 'Verified browser message';
    await member.locator('#messageInput').fill(text);
    await member.locator('#messageInput').press('Enter');
    await guest.waitForFunction(text => nightcord.ui.messages.some(m => m.text === text && m.profile?.authenticated), text);
    state.name = 'Updated profile';
    await openOwnProfile(member, true);
    await member.getByRole('button', { name: '同步资料', exact: true }).click();
    await guest.waitForFunction(() => nightcord.ui.roster.some(u => u.name === 'Updated profile'));
    assert.equal(await guest.evaluate(() => nightcord.ui.roster.length), 2);
    await guest.reload({ waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.roster.length === 2);
    assert.equal(await guest.evaluate(text => nightcord.ui.messages.filter(m => m.text === text && m.profile?.id === 'sekai:stable-subject').length, text), 1);
    await openOwnProfile(guest, false);
    await guest.getByRole('button', { name: '修改访客昵称', exact: true }).click();
    assert.equal(await guest.evaluate(() => nightcord.ui.currentUser.authenticated), false);
    await guest.locator('#name-input').fill('Renamed visitor');
    await guest.locator('#name-submit').click();
    await member.waitForFunction(() => nightcord.ui.roster.some(u => u.name === 'Renamed visitor') && nightcord.ui.roster.length === 2);
    await guest.locator('#messageInput').fill('Single send after rejoin');
    await guest.locator('#messageInput').press('Enter');
    await member.waitForFunction(() => nightcord.ui.messages.some(m => m.text === 'Single send after rejoin'));
    assert.equal(await member.evaluate(() => nightcord.ui.messages.filter(m => m.text === 'Single send after rejoin').length), 1);
    await guest.screenshot({ path: 'dist/guest-desktop.png', fullPage: true });
    await openOwnProfile(member, true);
    await member.screenshot({ path: 'dist/member-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await runtime.dispose();
  }
});
