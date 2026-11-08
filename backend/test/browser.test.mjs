/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('browser identity, profiles, persistence, tabs, login/logout and blocked cookies', { timeout: 180_000 }, async () => {
  const state = {};
  let runtime;
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    runtime = createRuntime(state, { origin });
    const apiBase = String(await runtime.ready).replace(/\/$/, '');
    const wsBase = apiBase.replace(/^http/, 'ws');
    browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
    const errors = [];
    const room = `browser-${crypto.randomUUID().slice(0, 12)}`;
    async function pageFor(authenticated, viewport, options = {}) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (route.request().url().startsWith(origin) || route.request().url().startsWith(apiBase)) return route.continue();
        if (route.request().url() === 'https://example.com/avatar.png') return route.fulfill({
          contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#9977dd"/></svg>',
        });
        return route.abort();
      });
      await context.addInitScript(({ wsBase, apiBase, room, authenticated, blockCookies }) => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, options) => nativeFetch(String(url).replace('https://chat.nightcord.de5.net', apiBase),
          blockCookies && String(url).includes('/api/guest/session') ? { ...options, credentials: 'omit' } : options);
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(url, protocols) { super(String(url).replace('wss://chat.nightcord.de5.net', wsBase).replace(/\/api\/room\/[^/]+\//, `/api/room/${room}/`), protocols); }
        };
        if (localStorage.getItem('nightcord-test-seeded')) return;
        localStorage.setItem('nightcord-test-seeded', '1');
        localStorage.setItem('nightcord-username', 'Shared name');
        if (authenticated) {
          localStorage.setItem('sekai_pass_access_token', 'local-test-token');
          localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
          localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: 'forged-cache', name: 'Forged cached name' }));
        }
      }, { wsBase, apiBase, room, authenticated, blockCookies: options.blockCookies });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      if (options.defer) return page;
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready);
      return page;
    }
    const guest = await pageFor(false, { width: 1280, height: 900 });
    const guestId = await guest.evaluate(() => nightcord.ui.currentUser.id);
    const cookies = await guest.context().cookies(apiBase);
    assert.ok(cookies.some(cookie => cookie.name === '__Host-nightcord_guest' && cookie.httpOnly && cookie.secure));
    assert.equal(await guest.evaluate(() => document.cookie.includes('nightcord_guest')), false);
    const member = await pageFor(true, { width: 390, height: 844 });
    await guest.waitForFunction(() => nightcord.ui.roster.length === 2);
    const profiles = await guest.evaluate(() => nightcord.ui.roster.map(u => u.profile));
    assert.equal(new Set(profiles.map(u => u.id)).size, 2);
    assert.ok(profiles.every(u => u.displayName === 'Shared name'));
    assert.equal(await member.evaluate(() => nightcord.ui.currentUser.id), 'sekai:stable-subject');
    async function openOwnProfile(page) {
      if (page.viewportSize().width <= 768 && !await page.locator('.sidebar').evaluate(el => el.classList.contains('show'))) {
        await page.getByRole('button', { name: '切换成员列表' }).click();
      }
      const id = await page.evaluate(() => nightcord.ui.currentUser.id);
      await page.locator(`.sidebar .voice-user[data-user-id="${id}"]`).click();
    }
    await openOwnProfile(member);
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
    await openOwnProfile(member);
    await member.getByRole('button', { name: '同步资料', exact: true }).click();
    await guest.waitForFunction(() => nightcord.ui.roster.some(u => u.name === 'Updated profile'));
    assert.equal(await guest.evaluate(() => nightcord.ui.roster.length), 2);
    const oldMessage = guest.locator('.message').filter({ hasText: text });
    assert.equal(await oldMessage.locator('.message-user').textContent(), 'Shared name');
    await oldMessage.locator('.message-user').click();
    assert.equal(await guest.locator('dialog h2').textContent(), 'Updated profile');
    assert.equal(await guest.locator('dialog .profile-snapshot-note').textContent(), '发送时昵称：Shared name');
    assert.equal(await guest.locator('dialog .profile-cache-note').count(), 0);
    assert.equal(await guest.locator('dialog .profile-bio').textContent(), '<img onerror=alert(1)> signature');
    assert.equal(await guest.locator('dialog .profile-actions').count(), 0);
    await guest.keyboard.press('Escape');
    await guest.locator('dialog').waitFor({ state: 'detached' });
    // Avatar and keyboard activation must resolve the same current identity.
    await oldMessage.locator('.avatar').focus();
    await guest.keyboard.press('Enter');
    assert.equal(await guest.locator('dialog h2').textContent(), 'Updated profile');
    await guest.keyboard.press('Escape');
    await guest.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await guest.evaluate(text => nightcord.ui.messages.find(m => m.text === text).profile.displayName, text), 'Shared name');
    await guest.reload({ waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.roster.length === 2);
    assert.equal(await guest.evaluate(() => nightcord.ui.currentUser.id), guestId);
    assert.equal(await guest.evaluate(text => nightcord.ui.messages.filter(m => m.text === text && m.profile?.id === 'sekai:stable-subject').length, text), 1);
    await openOwnProfile(guest);
    await guest.getByRole('button', { name: '修改访客昵称', exact: true }).click();
    assert.equal(await guest.evaluate(() => nightcord.ui.currentUser.authenticated), false);
    await guest.locator('#name-input').fill('Renamed visitor');
    await guest.locator('#name-submit').click();
    await member.waitForFunction(() => nightcord.ui.roster.some(u => u.name === 'Renamed visitor') && nightcord.ui.roster.length === 2);
    assert.equal(await guest.evaluate(() => nightcord.ui.currentUser.id), guestId);
    // The same test browser shares the IP join budget with the account tab.
    await delay(5500);
    await guest.locator('#messageInput').fill('Single send after rejoin');
    await guest.locator('#messageInput').press('Enter');
    await member.waitForFunction(() => nightcord.ui.messages.some(m => m.text === 'Single send after rejoin'));
    assert.equal(await member.evaluate(() => nightcord.ui.messages.filter(m => m.text === 'Single send after rejoin').length), 1);
    await guest.screenshot({ path: 'dist/guest-desktop.png', fullPage: true, animations: 'disabled' });
    await openOwnProfile(member);
    await member.screenshot({ path: 'dist/member-mobile.png', fullPage: true, animations: 'disabled' });
    await member.getByRole('button', { name: '关闭资料', exact: true }).click();
    await member.locator('dialog').waitFor({ state: 'detached' });
    await member.setViewportSize({ width: 1280, height: 900 });
    await openOwnProfile(member);
    await member.screenshot({ path: 'dist/member-desktop.png', fullPage: true, animations: 'disabled' });
    // Empty card space should not dismiss; the backdrop should.
    await member.locator('.profile-header').click({ position: { x: 80, y: 12 } });
    assert.equal(await member.locator('dialog').count(), 1);
    await member.mouse.click(4, 4);
    await member.locator('dialog').waitFor({ state: 'detached' });
    await openOwnProfile(guest);
    await guest.screenshot({ path: 'dist/guest-profile-desktop.png', fullPage: true, animations: 'disabled' });
    assert.equal(await guest.locator('dialog .identity-badge').count(), 0);
    await guest.keyboard.press('Escape');
    await guest.locator('dialog').waitFor({ state: 'detached' });
    // New layout must keep large names, signatures and IDs readable at small
    // widths, including when the user disables motion or rotates the device.
    const longProfile = {
      id: `sekai:${'x'.repeat(128)}`, authenticated: true,
      displayName: 'A'.repeat(50), username: 'u'.repeat(50),
      bio: '长签名 / Profile text '.repeat(12).slice(0, 200),
    };
    await member.emulateMedia({ reducedMotion: 'reduce' });
    for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 667, height: 375 }]) {
      await member.setViewportSize(viewport);
      await member.evaluate(profile => nightcord.ui.profileUI.open(profile), longProfile);
      const card = member.locator('dialog');
      assert.equal(await card.evaluate(el => getComputedStyle(el).animationName), 'none');
      await card.locator('summary').click();
      assert.equal(await card.locator('.profile-id').textContent(), longProfile.id);
      const bounds = await card.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, overflow: el.scrollWidth > el.clientWidth };
      });
      assert.ok(bounds.left >= 15 && bounds.right <= bounds.width - 15);
      assert.ok(bounds.top >= 15 && bounds.bottom <= bounds.height - 15);
      assert.equal(bounds.overflow, false);
      assert.equal(await card.locator('.profile-actions').count(), 0, 'other users have no account actions');
      await member.keyboard.press('Escape');
      await card.waitFor({ state: 'detached' });
    }
    await member.emulateMedia({ reducedMotion: 'no-preference' });

    await guest.evaluate(() => nightcord.chatRoom.setUser('Shared name'));
    await guest.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser.displayName === 'Shared name');
    await member.evaluate(() => nightcord.chatRoom.leave());
    await guest.waitForFunction(() => !nightcord.ui.roster.some(u => u.profile?.id === 'sekai:stable-subject'));
    assert.equal(await guest.locator('#offline-users [data-user-id="sekai:stable-subject"]').count(), 1);
    // A same-name online guest cannot be substituted for an offline account.
    assert.ok(await guest.evaluate(() => nightcord.ui.roster.some(u => u.name === 'Shared name' && !u.profile.authenticated)));
    await oldMessage.locator('.message-user').click();
    assert.equal(await guest.locator('dialog h2').textContent(), 'Updated profile');
    assert.equal(await guest.locator('dialog .profile-cache-note').textContent(), '最后已知资料');
    assert.equal(await guest.locator('dialog .profile-snapshot-note').textContent(), '发送时昵称：Shared name');
    assert.equal(await guest.locator('dialog .profile-bio').textContent(), '<img onerror=alert(1)> signature');
    assert.equal(await guest.locator('dialog .profile-avatar img').count(), 1);
    await guest.locator('dialog summary').click();
    assert.equal(await guest.locator('dialog .profile-id').textContent(), 'sekai:stable-subject');
    assert.equal(await oldMessage.locator('.message-user').textContent(), 'Shared name');
    await guest.keyboard.press('Escape');
    await guest.locator('dialog').waitFor({ state: 'detached' });

    // Reload replays the old message snapshot, but must retain the newer offline profile.
    await guest.reload({ waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => nightcord.chatRoom.wsManager.ready);
    assert.equal(await guest.locator('#offline-users [data-user-id="sekai:stable-subject"]').count(), 1);
    await oldMessage.locator('.avatar').focus();
    await guest.keyboard.press('Enter');
    assert.equal(await guest.locator('dialog h2').textContent(), 'Updated profile');
    assert.equal(await guest.locator('dialog .profile-cache-note').textContent(), '最后已知资料');
    assert.equal(await oldMessage.locator('.message-user').textContent(), 'Shared name');
    await guest.keyboard.press('Escape');
    await guest.locator('dialog').waitFor({ state: 'detached' });

    // Without an observation for this ID, the original message remains a usable fallback.
    await guest.evaluate(() => {
      localStorage.removeItem('nightcord-known-profiles');
      nightcord.ui.storage.knownProfiles.clear();
    });
    await oldMessage.locator('.message-user').click();
    assert.equal(await guest.locator('dialog h2').textContent(), 'Shared name');
    assert.equal(await guest.locator('dialog .profile-cache-note').count(), 0);
    assert.equal(await guest.locator('dialog .profile-snapshot-note').textContent(), '发送时昵称');
    await guest.keyboard.press('Escape');
    await guest.locator('dialog').waitFor({ state: 'detached' });

    // Two first visits with an empty cookie jar must serialize initialization.
    await delay(5500);
    const firstTab = await pageFor(false, { width: 1280, height: 900 }, { defer: true });
    const secondTab = await firstTab.context().newPage();
    secondTab.on('pageerror', error => errors.push(error.message));
    await Promise.all([firstTab.goto(origin), secondTab.goto(origin)]);
    await Promise.all([firstTab, secondTab].map(page => page.waitForFunction(() => nightcord.chatRoom.wsManager.ready)));
    const tabId = await firstTab.evaluate(() => nightcord.ui.currentUser.id);
    assert.equal(await secondTab.evaluate(() => nightcord.ui.currentUser.id), tabId);
    assert.notEqual(tabId, guestId);
    assert.equal(await firstTab.evaluate(() => nightcord.ui.roster.filter(u => u.profile?.id === nightcord.ui.currentUser.id).length), 1);
    await delay(5500);
    await firstTab.evaluate(() => nightcord.chatRoom.setUser('Shared tab visitor'));
    await Promise.all([firstTab, secondTab].map(page => page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser.displayName === 'Shared tab visitor')));
    assert.equal(await secondTab.evaluate(() => nightcord.ui.currentUser.id), tabId);
    await delay(5500);
    await firstTab.locator('#messageInput').fill('Anonymous before login');
    await firstTab.locator('#messageInput').press('Enter');
    await secondTab.waitForFunction(() => nightcord.ui.messages.some(m => m.text === 'Anonymous before login'));
    // Simulate the local fixture's successful OAuth result; the real backend
    // still verifies the token rather than trusting this cached profile.
    await delay(5500);
    await firstTab.evaluate(() => {
      localStorage.setItem('sekai_pass_access_token', 'local-test-token');
      localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
      localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: 'forged-cache', name: 'Forged cached name' }));
      nightcord.chatRoom.leave();
      nightcord.broadcastIdentityChange();
      nightcord.chatRoom.setUser('Forged cached name');
      nightcord.joinRoom('nightcord-default');
    });
    await Promise.all([firstTab, secondTab].map(page => page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser.id === 'sekai:stable-subject')));
    assert.equal(await firstTab.evaluate(() => nightcord.ui.messages.find(m => m.text === 'Anonymous before login').profile.authenticated), false);
    await delay(5500);
    await firstTab.evaluate(() => nightcord.ui.onLogout());
    await Promise.all([firstTab, secondTab].map(page => page.waitForFunction(id => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser.id === id, tabId)));
    assert.equal(await firstTab.evaluate(() => nightcord.ui.currentUser.displayName), 'Shared tab visitor');
    await firstTab.context().close();

    // Cookie rejection must stop instead of endlessly creating new identities.
    await delay(5500);
    const blocked = await pageFor(false, { width: 1280, height: 900 }, { defer: true, blockCookies: true });
    await blocked.goto(origin);
    await blocked.waitForFunction(() => nightcord.chatRoom.wsManager.shouldReconnect === false);
    assert.equal(await blocked.evaluate(() => nightcord.chatRoom.wsManager.ready), false);
    assert.equal(await blocked.evaluate(() => nightcord.chatRoom.wsManager._guestRecoveries), 2);
    assert.ok(!(await blocked.context().cookies(apiBase)).some(c => c.name === '__Host-nightcord_guest'));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await runtime?.dispose();
  }
});
