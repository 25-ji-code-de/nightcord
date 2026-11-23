/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

test('SEKAI Pass expiry choices and mobile resume', { timeout: 120_000 }, async t => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) return res.writeHead(403).end();
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = {};
  const runtime = createRuntime(state, { origin });
  t.after(() => runtime.dispose());
  const apiBase = String(await runtime.ready).replace(/\/$/, '');
  const browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined });
  t.after(() => browser.close());

  async function fixture(t, { refresh = false, refreshFails = false } = {}) {
    state.revoked = false;
    const context = await browser.newContext({ viewport: { width: 375, height: 667 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    t.after(() => context.close());
    const errors = [];
    t.after(() => assert.deepEqual(errors, []));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && ['/boot.js', '/pwa.js', '/version-checker.js'].includes(url.pathname)) {
        return route.fulfill({ contentType: 'text/javascript', body: '' });
      }
      if (url.origin === origin || url.origin === new URL(apiBase).origin) return route.continue();
      if (url.pathname === '/oauth/token') return route.fulfill({
        status: refreshFails ? 400 : 200, contentType: 'application/json',
        body: JSON.stringify(refreshFails ? { error: 'invalid_grant' } : { access_token: 'local-test-token', refresh_token: 'rotated', expires_in: 3600 }),
      });
      if (url.pathname === '/oauth/userinfo') return route.fulfill({
        status: state.revoked ? 401 : 200, contentType: 'application/json',
        body: JSON.stringify(state.revoked ? { error: 'invalid_token' } : { sub: 'stable-subject', name: 'Member' }),
      });
      if (url.pathname === '/oauth/authorize') return route.fulfill({ contentType: 'text/html', body: '<h1>Login</h1>' });
      return route.abort();
    });
    await context.addInitScript(({ apiBase, refresh }) => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (url, options) => nativeFetch(String(url).replace('https://chat.nightcord.de5.net', apiBase), options);
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) { super(String(url).replace('wss://chat.nightcord.de5.net', apiBase.replace(/^http/, 'ws')), protocols); }
      };
      if (!localStorage.getItem('test-seeded')) {
        localStorage.setItem('test-seeded', '1');
        localStorage.setItem('nightcord-guest-name', 'Visitor');
        localStorage.setItem('sekai_pass_access_token', 'local-test-token');
        localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
        localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: 'stable-subject', name: 'Member' }));
        if (refresh) localStorage.setItem('sekai_pass_refresh_token', 'refresh-token');
      }
    }, { apiBase, refresh });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?test');
    await page.evaluate(() => { window.nightcord = new Nightcord(); nightcord.init('nightcord-test'); });
    await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser?.authenticated);
    return page;
  }

  await t.test('phone resume prompts before sending, keeps the draft, and continues as a guest', async t => {
    const page = await fixture(t);
    await page.locator('.input').fill('草稿还在');
    await page.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      localStorage.removeItem('sekai_pass_access_token');
      await nightcord.identity.checkSession();
    });
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      nightcord.eventBus.emit('auth:required');
    });
    const dialog = page.getByRole('alertdialog', { name: 'SEKAI Pass 登录已过期。' });
    await dialog.waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 1);
    assert.equal(await page.locator('.input').inputValue(), '草稿还在');
    assert.equal(page.url(), origin + '/?test');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '暂不登录，继续使用');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '重新登录');
    for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 667, height: 375 }]) {
      await page.setViewportSize(viewport);
      const layout = await dialog.locator('.auth-error-dialog').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
          overflow: el.scrollWidth > el.clientWidth, animation: getComputedStyle(el).animationName,
          targets: [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) };
      });
      assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height);
      assert.equal(layout.overflow, false);
      assert.equal(layout.animation, 'none');
      assert.ok(layout.targets.every(height => height >= 44));
    }
    await page.setViewportSize({ width: 375, height: 667 });
    await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('../dist/auth-expired-mobile.png', import.meta.url)) });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: fileURLToPath(new URL('../dist/auth-expired-desktop.png', import.meta.url)) });
    await dialog.locator('.auth-error-dialog').screenshot({ path: fileURLToPath(new URL('../dist/auth-expired-dialog.png', import.meta.url)) });
    await dialog.getByRole('button', { name: '暂不登录，继续使用' }).click();
    await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser?.authenticated === false);
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.locator('.input').inputValue(), '草稿还在');
    assert.equal(await page.evaluate(() => nightcord.chatRoom.roomname), 'nightcord-test');
    await page.evaluate(() => nightcord.identity.checkSession());
    assert.equal(await page.getByRole('alertdialog').count(), 0);
  });

  await t.test('server revocation is detected on focus even with a locally valid token', async t => {
    const page = await fixture(t);
    state.revoked = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('alertdialog').waitFor();
    assert.equal(await page.evaluate(() => nightcord.chatRoom.wsManager.shouldReconnect), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser?.authenticated === false);
  });

  await t.test('revocation is detected while the chat connection is already disconnected', async t => {
    const page = await fixture(t);
    state.revoked = true;
    await page.evaluate(async () => {
      nightcord.chatRoom.wsManager.pauseAutoReconnect();
      nightcord.chatRoom.wsManager.disconnect();
      await nightcord.identity.checkSession();
    });
    await page.getByRole('alertdialog').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('nightcord-sekai-session')), '1');
    assert.equal(await page.evaluate(() => nightcord.sekaiPassAuth.isAuthenticated()), false);
    await page.getByRole('button', { name: '暂不登录，继续使用' }).click();
    await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser?.authenticated === false);
    assert.equal(await page.evaluate(() => localStorage.getItem('nightcord-sekai-session')), null);
  });

  await t.test('failed silent refresh prompts once; login failure retains both choices', async t => {
    const page = await fixture(t, { refresh: true, refreshFails: true });
    await page.evaluate(async () => {
      localStorage.setItem('sekai_pass_expires_at', String(Date.now() - 1));
      await nightcord.identity.checkSession();
      nightcord.sekaiPassAuth.login = async () => { throw new Error('network unavailable'); };
    });
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1);
    await dialog.getByRole('button', { name: '重新登录' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByRole('button', { name: '暂不登录，继续使用' }).isEnabled(), true);
    assert.equal(page.url(), origin + '/?test');
  });

  await t.test('successful silent refresh preserves login without a prompt', async t => {
    const page = await fixture(t, { refresh: true });
    await page.evaluate(async () => {
      localStorage.setItem('sekai_pass_expires_at', String(Date.now() - 1));
      await nightcord.identity.checkSession();
    });
    await page.waitForFunction(() => localStorage.getItem('sekai_pass_refresh_token') === 'rotated' && !nightcord.chatRoom.wsManager.protocol._authRefreshing);
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.evaluate(() => nightcord.ui.currentUser.authenticated), true);
  });

  await t.test('reload remembers a lost session and relogin retains the test room', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
      nightcord.destroy();
      localStorage.removeItem('sekai_pass_access_token');
      localStorage.removeItem('sekai_pass_user');
    });
    await page.reload();
    await page.evaluate(() => { window.nightcord = new Nightcord(); nightcord.init('nightcord-test'); });
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => nightcord.chatRoom.wsManager.ws), null);
    await dialog.getByRole('button', { name: '重新登录' }).click();
    await page.waitForURL(url => url.pathname === '/oauth/authorize');
    assert.equal(new URL(page.url()).searchParams.get('client_id'), 'nightcord_client');
    await page.goBack();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('nightcord-oauth-room')), 'nightcord-test');
  });

  await t.test('canceling OAuth returns to one expiry choice and can still continue as a guest', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
      nightcord.destroy();
      localStorage.removeItem('sekai_pass_access_token');
      localStorage.removeItem('sekai_pass_user');
      sessionStorage.setItem('nightcord-oauth-room', 'nightcord-test');
    });
    await page.goto(origin + '/?error=access_denied');
    await page.evaluate(() => { window.nightcord = new Nightcord(); nightcord.init(); });
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1);
    assert.equal(await dialog.getByRole('alert').textContent(), '重新登录未完成；请重试，或以访客身份继续。');
    assert.equal(page.url(), origin + '/?test');
    await dialog.getByRole('button', { name: '暂不登录，继续使用' }).click();
    await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.ui.currentUser?.authenticated === false);
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.evaluate(() => nightcord.chatRoom.roomname), 'nightcord-test');
  });
});
