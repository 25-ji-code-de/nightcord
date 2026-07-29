/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 *
 * nightcord SEKAI Pass 适配层的契约测试。
 *
 * nightcord 与 hub / 25ji 的语义差异最大，这里逐条钉住：
 *   - getAccessToken() 未登录时 **抛异常**（sekai-analytics 靠它静默跳过上报）
 *   - handleCallback() 无参、从 URL 读、返回 userInfo 而不是 tokens
 *   - getUserInfo() 总是写缓存，getCurrentUser() 读缓存不发请求
 *   - storage 前缀是 sekai_pass_，与 hub / 25ji 的 sekai_ 隔离
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const local = new MemoryStorage();
const session = new MemoryStorage();
let redirectedTo = '';
let search = '';
let fetchQueue = [];
let fetchCalls = [];

const sandbox = {
  console,
  crypto,
  TextEncoder,
  URLSearchParams,
  URL,
  btoa,
  Date,
  Number,
  Math,
  JSON,
  Promise,
  Error,
  Array,
  Object,
  String,
  Uint8Array,
  setTimeout,
  localStorage: local,
  sessionStorage: session,
  async fetch(url, init) {
    fetchCalls.push({ url: String(url), init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  },
  location: {
    origin: 'https://nightcord.de5.net',
    hostname: 'nightcord.de5.net',
    get search() {
      return search;
    },
    get href() {
      return redirectedTo;
    },
    set href(v) {
      redirectedTo = v;
    },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
for (const file of ['vendor/sekai-auth.global.js', 'sekai-pass-auth.js']) {
  vm.runInContext(readFileSync(join(root, file), 'utf8'), context, { filename: file });
}

const { SekaiPassAuth } = sandbox.window;

function stubFetch(queue) {
  fetchQueue = queue;
  fetchCalls = [];
  return fetchCalls;
}

let auth;
beforeEach(() => {
  local.clear();
  session.clear();
  redirectedTo = '';
  search = '';
  fetchQueue = [];
  fetchCalls = [];
  auth = new SekaiPassAuth({ clientId: 'nightcord_client' });
});

describe('构造与默认值', () => {
  test('沿用 nightcord 的默认 clientId 与 redirectUri', () => {
    const a = new SekaiPassAuth();
    assert.equal(a.clientId, 'nightcord_client');
    assert.equal(a.redirectUri, 'https://nightcord.de5.net/auth/callback');
  });

  test('redirectUri 可被覆盖（本地开发用）', () => {
    const a = new SekaiPassAuth({ redirectUri: 'http://localhost:8080' });
    assert.equal(a.redirectUri, 'http://localhost:8080');
  });

  test('storagePrefix 是 sekai_pass_，与 hub / 25ji 隔离', () => {
    assert.equal(auth.storagePrefix, 'sekai_pass_');
    assert.equal(auth.sdk.keys.accessToken, 'sekai_pass_access_token');
    assert.equal(auth.sdk.keys.refreshToken, 'sekai_pass_refresh_token');
    assert.equal(auth.sdk.keys.expiresAt, 'sekai_pass_expires_at');
    assert.equal(auth.sdk.keys.user, 'sekai_pass_user');
    assert.equal(auth.sdk.keys.codeVerifier, 'sekai_pass_code_verifier');
    assert.equal(auth.sdk.keys.state, 'sekai_pass_state');
  });

  test('真的能读到迁移前写下的 token', async () => {
    local.setItem('sekai_pass_access_token', 'OLD');
    local.setItem('sekai_pass_refresh_token', 'OLD_R');
    local.setItem('sekai_pass_expires_at', String(Date.now() + 60 * 60 * 1000));
    assert.equal(auth.isAuthenticated(), true);
    assert.equal(await auth.getAccessToken(), 'OLD');
  });
});

describe('getAccessToken 的 throw 语义', () => {
  // sekai-analytics.js 的 reportEvent 用 try/catch 把"未登录"当作静默跳过。
  // 如果这里改成返回 null，未登录时每个事件都会发一次注定 401 的请求。
  test('完全未登录时抛异常，而不是返回 null', async () => {
    await assert.rejects(() => auth.getAccessToken(), /Not authenticated/);
  });

  test('有 refresh token 但刷新失败时也抛异常', async () => {
    local.setItem('sekai_pass_access_token', 'OLD');
    local.setItem('sekai_pass_refresh_token', 'RT');
    local.setItem('sekai_pass_expires_at', String(Date.now() - 1));
    stubFetch([{ status: 400, body: { error: 'invalid_grant' } }]);

    await assert.rejects(() => auth.getAccessToken(), /Not authenticated/);
  });

  test('refreshToken 失败时抛异常', async () => {
    await assert.rejects(() => auth.refreshToken(), /Token refresh failed/);
  });

  test('onAuthExpired 在 refresh 失败时触发', async () => {
    let fired = 0;
    const a = new SekaiPassAuth({ onAuthExpired: () => (fired += 1) });
    local.setItem('sekai_pass_access_token', 'OLD');
    local.setItem('sekai_pass_refresh_token', 'RT');
    local.setItem('sekai_pass_expires_at', String(Date.now() - 1));
    stubFetch([{ status: 400, body: { error: 'invalid_grant' } }]);

    await assert.rejects(() => a.getAccessToken());
    assert.equal(fired, 1);
  });
});

describe('handleCallback 返回 userInfo 而不是 tokens', () => {
  test('从 URL 读参数，换 token 后再拉 userInfo', async () => {
    session.setItem('sekai_pass_state', 'S1');
    session.setItem('sekai_pass_code_verifier', 'V1');
    search = '?code=CODE&state=S1';

    const calls = stubFetch([
      { body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } },
      { body: { sub: 'u1', name: 'Enanan', preferred_username: 'enanan' } },
    ]);

    const userInfo = await auth.handleCallback();

    // nightcord.js 直接读 userInfo.name —— 返回值必须是 userInfo
    assert.equal(userInfo.name, 'Enanan');
    assert.equal(userInfo.sub, 'u1');
    assert.equal(calls.length, 2, '一次换 token，一次拉 userInfo');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer AT');
  });

  test('OAuth error 参数会抛异常（nightcord.js 会 catch 并 alert）', async () => {
    search = '?error=access_denied&error_description=User+denied';
    stubFetch([]);
    await assert.rejects(() => auth.handleCallback(), /denied/i);
  });

  test('state 不匹配时抛异常', async () => {
    session.setItem('sekai_pass_state', 'S1');
    session.setItem('sekai_pass_code_verifier', 'V1');
    search = '?code=CODE&state=WRONG';
    stubFetch([]);
    await assert.rejects(() => auth.handleCallback(), /state/i);
  });
});

describe('用户信息缓存', () => {
  test('getUserInfo 写缓存，getCurrentUser 读缓存不发请求', async () => {
    local.setItem('sekai_pass_access_token', 'AT');
    local.setItem('sekai_pass_expires_at', String(Date.now() + 60 * 60 * 1000));
    stubFetch([{ body: { sub: 'u1', name: 'Enanan' } }]);

    await auth.getUserInfo();

    const calls = stubFetch([]);
    assert.deepEqual(auth.getCurrentUser(), { sub: 'u1', name: 'Enanan' });
    assert.equal(calls.length, 0, 'getCurrentUser 不得发请求');
  });

  test('无缓存时 getCurrentUser 返回 null', () => {
    assert.equal(auth.getCurrentUser(), null);
  });

  test('缓存损坏时返回 null 而不抛', () => {
    local.setItem('sekai_pass_user', '{not json');
    assert.equal(auth.getCurrentUser(), null);
  });

  test('getUserInfo 失败时抛异常', async () => {
    stubFetch([]);
    await assert.rejects(() => auth.getUserInfo(), /user info/i);
  });
});

describe('login 与 logout', () => {
  test('login 构造 S256 授权 URL', async () => {
    await auth.login();
    const url = new URL(redirectedTo);
    assert.equal(url.origin + url.pathname, 'https://id.nightcord.de5.net/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'nightcord_client');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid profile');
    assert.ok(session.getItem('sekai_pass_code_verifier'));
  });

  test('logout 清空全部本地状态且不跳转', async () => {
    local.setItem('sekai_pass_access_token', 'AT');
    local.setItem('sekai_pass_refresh_token', 'RT');
    local.setItem('sekai_pass_user', '{"sub":"u1"}');
    stubFetch([{ body: {} }, { body: {} }]);

    await auth.logout();

    assert.equal(local.getItem('sekai_pass_access_token'), null);
    assert.equal(local.getItem('sekai_pass_refresh_token'), null);
    assert.equal(local.getItem('sekai_pass_user'), null);
    assert.equal(redirectedTo, '', 'nightcord 的 logout 不跳转');
  });
});
