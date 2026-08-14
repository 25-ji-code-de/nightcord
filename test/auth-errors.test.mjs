/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 *
 * auth-errors.js 的映射契约测试。
 *
 * 只验证「真实会发生的错误 → 预期错误码」的映射，映射依据是
 * sekai-auth/src/index.js 与 sekai-pass-auth.js 里的原始抛错文案。
 * 沿用 sekai-pass-auth.test.mjs 的 vm.createContext 加载方式，因为
 * auth-errors.js 是浏览器全局脚本（挂 window.describeAuthError）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'auth-errors.js'), 'utf8'), context, {
  filename: 'auth-errors.js',
});

const { describeAuthError } = sandbox.window;

/** 模拟 SDK 的 SekaiAuthError（带 code + message）。 */
function sdkError(code, message) {
  return { name: 'SekaiAuthError', code, message };
}

describe('describeAuthError — 基本契约', () => {
  test('挂到全局且是函数', () => {
    assert.equal(typeof describeAuthError, 'function');
  });

  test('始终保留 sourceCode 与 originalMessage', () => {
    const d = describeAuthError(sdkError('invalid_id_token', 'ID token was issued in the future'));
    assert.equal(d.sourceCode, 'invalid_id_token');
    assert.equal(d.originalMessage, 'ID token was issued in the future');
    // 面向用户的四要素齐全
    assert.ok(d.code && d.title && d.description && d.solution);
  });
});

describe('invalid_id_token 的子情况互不串味', () => {
  const cases = [
    ['ID token was issued in the future', 'ERR_ID_TOKEN_FUTURE'],
    ['ID token has expired', 'ERR_ID_TOKEN_EXPIRED'],
    ['ID token signature is invalid', 'ERR_ID_TOKEN_SIGNATURE'],
    ['ID token issuer mismatch: https://evil.example', 'ERR_ID_TOKEN_ISSUER'],
    ['ID token audience does not include this client', 'ERR_ID_TOKEN_AUDIENCE'],
    ['ID token has multiple audiences but no azp', 'ERR_ID_TOKEN_AUDIENCE'],
    ['ID token azp is another client: other_client', 'ERR_ID_TOKEN_AUDIENCE'],
    ['ID token nonce mismatch — possible token injection', 'ERR_ID_TOKEN_NONCE'],
    ['Unsupported ID token algorithm: none', 'ERR_ID_TOKEN_ALG'],
    ['No JWKS key matches ID token header (kid=abc)', 'ERR_ID_TOKEN_KEY'],
    ['Cannot import JWKS key: bad key', 'ERR_ID_TOKEN_KEY'],
    ['ID token is missing sub', 'ERR_ID_TOKEN_CLAIMS'],
    ['ID token is missing iat', 'ERR_ID_TOKEN_CLAIMS'],
    ['ID token is malformed', 'ERR_ID_TOKEN_MALFORMED'],
    ['ID token payload is not valid JSON', 'ERR_ID_TOKEN_MALFORMED'],
    ['ID token header is not valid JSON', 'ERR_ID_TOKEN_MALFORMED'],
  ];

  for (const [message, expected] of cases) {
    test(`"${message}" → ${expected}`, () => {
      const d = describeAuthError(sdkError('invalid_id_token', message));
      assert.equal(d.code, expected, `期望 ${expected}，实际 ${d.code}`);
    });
  }

  test('未知的 invalid_id_token 子情况落到 ERR_ID_TOKEN_INVALID', () => {
    const d = describeAuthError(sdkError('invalid_id_token', '某种我们没见过的 id token 问题'));
    assert.equal(d.code, 'ERR_ID_TOKEN_INVALID');
    assert.equal(d.originalMessage, '某种我们没见过的 id token 问题');
  });
});

describe('按 SDK code 直接命中', () => {
  const cases = [
    ['invalid_config', 'ERR_AUTH_CONFIG'],
    ['discovery_failed', 'ERR_AUTH_DISCOVERY'],
    ['jwks_failed', 'ERR_AUTH_JWKS'],
    ['network_error', 'ERR_AUTH_NETWORK'],
    ['invalid_token_response', 'ERR_AUTH_TOKEN_RESPONSE'],
    ['token_request_failed', 'ERR_AUTH_TOKEN_REQUEST'],
    ['invalid_state', 'ERR_AUTH_STATE'],
    ['invalid_request', 'ERR_AUTH_REQUEST'],
    ['access_denied', 'ERR_AUTH_ACCESS_DENIED'],
    ['invalid_grant', 'ERR_AUTH_GRANT'],
    ['invalid_client', 'ERR_AUTH_CLIENT'],
    ['unsupported_grant_type', 'ERR_AUTH_GRANT_TYPE'],
  ];

  for (const [code, expected] of cases) {
    test(`${code} → ${expected}`, () => {
      const d = describeAuthError(sdkError(code, 'some description'));
      assert.equal(d.code, expected);
      assert.equal(d.sourceCode, code);
    });
  }
});

describe('无 code 的 plain Error（nightcord 适配层抛出）', () => {
  const cases = [
    ['Not authenticated', 'ERR_AUTH_NOT_AUTHENTICATED'],
    ['Token refresh failed', 'ERR_AUTH_REFRESH_FAILED'],
    ['Failed to fetch user info', 'ERR_AUTH_USERINFO_FAILED'],
  ];

  for (const [message, expected] of cases) {
    test(`"${message}" → ${expected}`, () => {
      const d = describeAuthError(new Error(message));
      assert.equal(d.code, expected);
      assert.equal(d.sourceCode, null, 'plain Error 没有 code');
      assert.equal(d.originalMessage, message);
    });
  }
});

describe('兜底与健壮性', () => {
  test('完全未知的错误落到 ERR_AUTH_UNKNOWN 且保留原文', () => {
    const d = describeAuthError(new Error('天塌了'));
    assert.equal(d.code, 'ERR_AUTH_UNKNOWN');
    assert.equal(d.originalMessage, '天塌了');
    assert.ok(d.title && d.description && d.solution);
  });

  test('未收录的 code 也走 message 兜底，不抛异常', () => {
    const d = describeAuthError(sdkError('some_new_code', 'whatever'));
    assert.equal(d.code, 'ERR_AUTH_UNKNOWN');
    assert.equal(d.sourceCode, 'some_new_code');
  });

  test('非 Error 入参（字符串）不抛，落兜底', () => {
    const d = describeAuthError('bare string');
    assert.equal(d.code, 'ERR_AUTH_UNKNOWN');
    assert.equal(d.originalMessage, 'bare string');
  });

  test('null / undefined 入参不抛', () => {
    assert.equal(describeAuthError(null).code, 'ERR_AUTH_UNKNOWN');
    assert.equal(describeAuthError(undefined).code, 'ERR_AUTH_UNKNOWN');
  });
});
