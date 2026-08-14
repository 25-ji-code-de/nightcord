/*
 * Nightcord - A modern, modular real-time chat application
 * Copyright (C) 2025 The 25-ji-code-de Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 认证错误码目录 —— 把 SEKAI Pass 登录过程中**真实会抛出**的异常，翻译成
 * 一条对用户有意义的说明。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 *
 * 底层 SDK（vendor/sekai-auth.global.js）抛的 `SekaiAuthError` 上已经带了
 * 稳定的 `code`（`invalid_id_token` / `invalid_state` / `network_error` …），
 * 但此前 nightcord.js 只做了 `alert('登录失败：' + error.message)` —— 把英文
 * 原文直接糊到用户脸上，既没有错误码，也没有「这是什么、我该怎么办」。
 *
 * 这个模块**只**负责翻译，不产生错误、不吞掉错误：返回的对象始终带上
 * `sourceCode` 与 `originalMessage`，控制台仍能看到原始信息。
 *
 * ── 映射依据（全部来自真实代码，不臆造）─────────────────────────────
 *
 *  - SDK `SekaiAuthError.code`：见 sekai-auth/src/index.js。其中
 *    `invalid_id_token` 一个 code 覆盖十几种子情况，只能靠 message 区分，
 *    所以对它做二级分派。
 *  - SDK 冒泡上来的 OAuth 服务端 error（access_denied / invalid_grant …），
 *    同样落在 `code` 上。
 *  - nightcord 适配层（sekai-pass-auth.js）自己抛的 plain Error（无 code）：
 *    'Not authenticated' / 'Token refresh failed' / 'Failed to fetch user info'，
 *    按 message 匹配。
 *
 * 认不出来的错误落到 ERR_AUTH_UNKNOWN，原样带出 message —— 宁可显示得朴素，
 * 也不假装了解一个我们没见过的错误。
 */
(function (global) {
  'use strict';

  /**
   * @typedef {Object} AuthErrorDescriptor
   * @property {string} code        错误码，如 ERR_ID_TOKEN_FUTURE
   * @property {string} title       中文标题
   * @property {string} description 原因说明
   * @property {string} solution    解决方案
   */

  /** 按 SDK `code` 直接命中的错误。`invalid_id_token` 不在这里（见下方二级分派）。 */
  const BY_CODE = {
    invalid_config: {
      code: 'ERR_AUTH_CONFIG',
      title: '登录客户端配置有误',
      description: 'Nightcord 的登录配置不完整或不正确，无法向 SEKAI Pass 发起授权。这通常是部署配置的问题，而不是你的操作导致的。',
      solution: '请刷新页面重试；若持续出现，请联系站点维护者检查登录配置。',
    },
    discovery_failed: {
      code: 'ERR_AUTH_DISCOVERY',
      title: '无法获取登录服务配置',
      description: '连接 SEKAI Pass 的服务发现端点失败，可能是登录服务临时不可用或网络受阻。',
      solution: '请检查网络后刷新重试；若持续出现，可能是登录服务正在维护，请稍后再试。',
    },
    jwks_failed: {
      code: 'ERR_AUTH_JWKS',
      title: '无法获取登录签名密钥',
      description: '拉取 SEKAI Pass 的签名密钥（JWKS）失败，导致无法校验登录令牌的真伪。',
      solution: '请刷新页面重新登录；若持续出现，请稍后再试或联系站点维护者。',
    },
    network_error: {
      code: 'ERR_AUTH_NETWORK',
      title: '网络连接失败',
      description: '与 SEKAI Pass 通信时网络请求失败，可能是网络中断、代理或防火墙拦截。',
      solution: '请检查网络连接后重试；若使用了代理或 VPN，可尝试切换或关闭后再登录。',
    },
    invalid_token_response: {
      code: 'ERR_AUTH_TOKEN_RESPONSE',
      title: '登录服务返回异常',
      description: 'SEKAI Pass 返回的令牌响应中缺少必要字段（access_token），无法完成登录。',
      solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
    },
    token_request_failed: {
      code: 'ERR_AUTH_TOKEN_REQUEST',
      title: '令牌请求被拒绝',
      description: '用授权码换取登录令牌时被 SEKAI Pass 拒绝，可能是授权码已失效或请求参数不匹配。',
      solution: '请返回重新发起一次登录；若持续出现，请稍后再试。',
    },
    invalid_state: {
      code: 'ERR_AUTH_STATE',
      title: '登录状态校验失败',
      description: '本次回调的 state 与发起登录时不一致。可能是登录页面停留太久、在多个标签页重复登录，或遭遇跨站请求伪造（CSRF）。',
      solution: '请关闭多余的登录标签页，回到 Nightcord 重新发起登录。',
    },
    invalid_request: {
      code: 'ERR_AUTH_REQUEST',
      title: '登录请求不完整',
      description: '登录回调缺少必要参数（授权码或 PKCE 校验值），登录流程可能被中断或篡改。',
      solution: '请回到 Nightcord 重新点击登录，不要直接打开或刷新回调链接。',
    },
    // 以下是 SDK 冒泡上来的 OAuth 服务端标准 error
    access_denied: {
      code: 'ERR_AUTH_ACCESS_DENIED',
      title: '你取消了授权',
      description: '在 SEKAI Pass 授权页面选择了拒绝，或未完成授权就返回，因此没有登录。',
      solution: '如果想登录，请重新点击登录并在授权页选择「允许访问」。',
    },
    invalid_grant: {
      code: 'ERR_AUTH_GRANT',
      title: '授权码无效或已过期',
      description: '本次登录使用的授权码已被使用过或已过期，SEKAI Pass 不再接受。',
      solution: '请回到 Nightcord 重新发起登录以获取新的授权码。',
    },
    invalid_client: {
      code: 'ERR_AUTH_CLIENT',
      title: '客户端未被授权',
      description: 'SEKAI Pass 不认可 Nightcord 这个登录客户端，可能是客户端配置或注册信息有误。',
      solution: '这通常需要站点维护者处理，请刷新重试或反馈该问题。',
    },
    unsupported_grant_type: {
      code: 'ERR_AUTH_GRANT_TYPE',
      title: '不支持的授权类型',
      description: 'SEKAI Pass 不支持本次请求使用的授权类型，通常是客户端与服务端版本不匹配导致的。',
      solution: '请刷新页面重试；若持续出现，请联系站点维护者。',
    },
  };

  /**
   * `invalid_id_token` 的二级分派：按 message 子串匹配。
   * 子串取自 sekai-auth/src/index.js 的原始抛错文案，按从具体到宽泛排列。
   * @type {Array<{ match: string, descriptor: AuthErrorDescriptor }>}
   */
  const ID_TOKEN_RULES = [
    {
      match: 'issued in the future',
      descriptor: {
        code: 'ERR_ID_TOKEN_FUTURE',
        title: '登录令牌的时间戳异常',
        description: '服务器认为该身份令牌的签发时间晚于当前时间，通常是你的设备系统时间与服务器不同步（快了）导致的。',
        solution: '请开启系统「自动设置时间」后刷新页面重新登录；仍失败请稍后重试。',
      },
    },
    {
      match: 'has expired',
      descriptor: {
        code: 'ERR_ID_TOKEN_EXPIRED',
        title: '登录令牌已过期',
        description: '收到的身份令牌已超过有效期。可能是登录页面停留太久，也可能是设备系统时间不准（慢了）。',
        solution: '请刷新页面重新登录；若反复出现，请检查设备系统时间是否正确。',
      },
    },
    {
      match: 'signature is invalid',
      descriptor: {
        code: 'ERR_ID_TOKEN_SIGNATURE',
        title: '登录令牌签名无效',
        description: '身份令牌的签名未能通过校验，令牌可能已损坏或不可信。',
        solution: '请刷新页面重新登录；若持续出现，请勿在此登录并联系站点维护者。',
      },
    },
    {
      match: 'issuer mismatch',
      descriptor: {
        code: 'ERR_ID_TOKEN_ISSUER',
        title: '登录令牌来源不符',
        description: '身份令牌的签发者与预期的 SEKAI Pass 不一致，可能指向配置错误或不可信的令牌。',
        solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
      },
    },
    {
      match: 'audience',
      descriptor: {
        code: 'ERR_ID_TOKEN_AUDIENCE',
        title: '登录令牌不是发给本站的',
        description: '身份令牌的受众（audience/azp）不包含 Nightcord，说明该令牌并非为本站签发。',
        solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
      },
    },
    {
      // "ID token azp is another client: X" —— 不含 audience 子串，单列一条
      match: 'azp',
      descriptor: {
        code: 'ERR_ID_TOKEN_AUDIENCE',
        title: '登录令牌不是发给本站的',
        description: '身份令牌的受众（audience/azp）不包含 Nightcord，说明该令牌并非为本站签发。',
        solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
      },
    },
    {
      match: 'nonce mismatch',
      descriptor: {
        code: 'ERR_ID_TOKEN_NONCE',
        title: '登录令牌校验值不符',
        description: '身份令牌的 nonce 与本次登录发起时不一致，可能存在令牌被注入的风险。',
        solution: '请关闭其它登录标签页，回到 Nightcord 重新发起登录。',
      },
    },
    {
      match: 'Unsupported ID token algorithm',
      descriptor: {
        code: 'ERR_ID_TOKEN_ALG',
        title: '登录令牌签名算法不受支持',
        description: '身份令牌使用了本站不接受的签名算法，出于安全考虑已拒绝。',
        solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
      },
    },
    {
      match: 'JWKS key',
      descriptor: {
        code: 'ERR_ID_TOKEN_KEY',
        title: '找不到匹配的签名密钥',
        description: '在 SEKAI Pass 的密钥集合中找不到能校验该令牌的密钥，可能是密钥刚刚轮换。',
        solution: '请刷新页面重新登录以获取最新令牌；若持续出现，请稍后再试。',
      },
    },
    // 缺 sub / 缺 iat / 缺失结构等剩余情况
    {
      match: 'missing',
      descriptor: {
        code: 'ERR_ID_TOKEN_CLAIMS',
        title: '登录令牌缺少必要字段',
        description: '身份令牌缺少必需的声明（如用户标识 sub 或签发时间 iat），无法据此建立登录身份。',
        solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
      },
    },
    {
      match: 'malformed',
      descriptor: {
        code: 'ERR_ID_TOKEN_MALFORMED',
        title: '登录令牌格式错误',
        description: '身份令牌的结构无法解析，令牌可能在传输中损坏。',
        solution: '请刷新页面重新登录；若持续出现，请检查网络或联系站点维护者。',
      },
    },
    {
      match: 'not valid JSON',
      descriptor: {
        code: 'ERR_ID_TOKEN_MALFORMED',
        title: '登录令牌格式错误',
        description: '身份令牌的内容无法解析为合法数据，令牌可能已损坏。',
        solution: '请刷新页面重新登录；若持续出现，请检查网络或联系站点维护者。',
      },
    },
  ];

  /** `invalid_id_token` 未命中任何具体规则时的兜底。 */
  const ID_TOKEN_FALLBACK = {
    code: 'ERR_ID_TOKEN_INVALID',
    title: '登录令牌校验失败',
    description: '身份令牌未能通过校验，无法据此完成登录。',
    solution: '请刷新页面重新登录；若持续出现，请联系站点维护者。',
  };

  /**
   * nightcord 适配层抛的 plain Error（无 code），按 message 匹配。
   * @type {Array<{ match: string, descriptor: AuthErrorDescriptor }>}
   */
  const PLAIN_MESSAGE_RULES = [
    {
      match: 'Not authenticated',
      descriptor: {
        code: 'ERR_AUTH_NOT_AUTHENTICATED',
        title: '尚未登录',
        description: '当前没有有效的登录状态，需要先登录 SEKAI Pass 才能继续。',
        solution: '请点击「使用 SEKAI Pass 登录」完成登录后重试。',
      },
    },
    {
      match: 'Token refresh failed',
      descriptor: {
        code: 'ERR_AUTH_REFRESH_FAILED',
        title: '登录状态刷新失败',
        description: '尝试续期登录状态失败，登录可能已经过期或被撤销。',
        solution: '请重新登录 SEKAI Pass。',
      },
    },
    {
      match: 'Failed to fetch user info',
      descriptor: {
        code: 'ERR_AUTH_USERINFO_FAILED',
        title: '获取用户信息失败',
        description: '登录令牌已拿到，但向 SEKAI Pass 获取用户资料时失败，可能是令牌已失效或网络异常。',
        solution: '请刷新页面重新登录；若持续出现，请检查网络后再试。',
      },
    },
  ];

  /** 兜底：认不出来的错误。 */
  const UNKNOWN = {
    code: 'ERR_AUTH_UNKNOWN',
    title: '登录失败',
    description: '登录过程中发生了未预期的错误。',
    solution: '请刷新页面重新登录；若持续出现，请把下方的错误信息反馈给站点维护者。',
  };

  /**
   * @param {string} message
   * @param {Array<{ match: string, descriptor: AuthErrorDescriptor }>} rules
   * @returns {AuthErrorDescriptor|null}
   */
  function firstMatch(message, rules) {
    for (const rule of rules) {
      if (message.indexOf(rule.match) !== -1) return rule.descriptor;
    }
    return null;
  }

  /**
   * 把任意登录异常翻译成用户可读的错误描述。
   *
   * @param {unknown} error 通常是 SekaiAuthError 或 Error
   * @returns {{code: string, title: string, description: string, solution: string, sourceCode: string|null, originalMessage: string}}
   */
  function describeAuthError(error) {
    const originalMessage =
      error && typeof error === 'object' && 'message' in error && error.message != null
        ? String(error.message)
        : String(error == null ? '' : error);
    const sourceCode =
      error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;

    let descriptor = null;

    if (sourceCode === 'invalid_id_token') {
      descriptor = firstMatch(originalMessage, ID_TOKEN_RULES) || ID_TOKEN_FALLBACK;
    } else if (sourceCode && BY_CODE[sourceCode]) {
      descriptor = BY_CODE[sourceCode];
    } else {
      // 无 code 或未收录的 code：先按 plain message 试，再兜底
      descriptor = firstMatch(originalMessage, PLAIN_MESSAGE_RULES) || UNKNOWN;
    }

    return {
      code: descriptor.code,
      title: descriptor.title,
      description: descriptor.description,
      solution: descriptor.solution,
      sourceCode,
      originalMessage,
    };
  }

  global.describeAuthError = describeAuthError;

  // 便于 Node 测试用 vm.createContext 后取用（浏览器里无副作用）。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { describeAuthError };
  }
})(typeof window !== 'undefined' ? window : globalThis);
