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
 * SEKAI Pass OAuth 客户端 —— 实现已移至 @25-ji-code-de/sekai-auth（Apache-2.0）。
 *
 * 这个文件此前是四份独立 OAuth 实现之一（另外三份在 hub、25ji-sagyo、
 * stickers-maker），行为已经开始漂移。现在只保留 nightcord 特有的语义差异：
 *
 *   - getAccessToken() 未登录时 **抛异常**，不是返回 null。
 *     sekai-analytics.js 的 reportEvent 靠这个异常来"静默跳过"上报；
 *     改成返回 null 会让未登录时每个事件都白发一次注定 401 的请求。
 *   - handleCallback() 不接参数，从 URL 读，且返回 **userInfo** 而不是 tokens。
 *   - getUserInfo() 总是把结果缓存进 localStorage（SDK 默认不缓存）。
 *   - storagePrefix 为 sekai_pass_，与 hub / 25ji 的 sekai_ 隔离。
 *
 * vendor/sekai-auth.global.js 是从上游 tag 原样复制的，请勿手工编辑。
 * 必须在本文件之前加载。
 */
(function (global) {
  'use strict';

  const { SekaiAuth, SEKAI_PASS_ENDPOINTS } = global.SekaiAuthSDK;

  class SekaiPassAuth {
    /**
     * @param {object} [options]
     * @param {string} [options.clientId]
     * @param {string} [options.redirectUri]
     * @param {string} [options.authEndpoint]
     * @param {string} [options.tokenEndpoint]
     * @param {string} [options.userInfoEndpoint]
     * @param {() => void} [options.onAuthExpired]
     */
    constructor(options = {}) {
      this.clientId = options.clientId || 'nightcord_client';
      this.redirectUri = options.redirectUri || `${global.location.origin}/auth/callback`;
      this.onAuthExpired = options.onAuthExpired;
      this.storagePrefix = 'sekai_pass_';

      this._auth = new SekaiAuth({
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        scope: 'openid profile email',
        endpoints: {
          authorize: options.authEndpoint || SEKAI_PASS_ENDPOINTS.authorize,
          token: options.tokenEndpoint || SEKAI_PASS_ENDPOINTS.token,
          userinfo: options.userInfoEndpoint || SEKAI_PASS_ENDPOINTS.userinfo,
          revoke: SEKAI_PASS_ENDPOINTS.revoke,
        },
        // 默认 key 由前缀拼出，与迁移前完全一致：
        //   sekai_pass_access_token / refresh_token / expires_at / user
        //   sekai_pass_code_verifier / state
        storagePrefix: 'sekai_pass_',
        onAuthExpired: options.onAuthExpired,
      });
    }

    /** 底层 SDK 实例。 */
    get sdk() {
      return this._auth;
    }

    /** 开始 OAuth 授权流程。 */
    async login() {
      return this._auth.login();
    }

    /**
     * 处理授权回调。从 URL 读取 code / state / error。
     * @returns {Promise<object>} userInfo（**不是** tokens）
     */
    async handleCallback() {
      await this._auth.handleCallback();
      return this.getUserInfo();
    }

    /**
     * 取有效 access token，必要时自动刷新。
     * @returns {Promise<string>}
     * @throws {Error} 未登录或刷新失败时抛出 —— 调用方（sekai-analytics）依赖这个行为
     */
    async getAccessToken() {
      const token = await this._auth.getAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }
      return token;
    }

    /**
     * 刷新 access token。
     * @returns {Promise<string>}
     * @throws {Error} 刷新失败时抛出
     */
    async refreshToken() {
      const token = await this._auth.refresh();
      if (!token) {
        throw new Error('Token refresh failed');
      }
      return token;
    }

    /**
     * 取用户信息，并缓存进 localStorage。
     * @returns {Promise<object>}
     * @throws {Error} 未登录或请求失败时抛出
     */
    async getUserInfo() {
      const userInfo = await this._auth.getUserInfo({ cache: true });
      if (!userInfo) {
        throw new Error('Failed to fetch user info');
      }
      return userInfo;
    }

    /** @returns {boolean} 有 refresh token 时即使 access 过期也算已登录。 */
    isAuthenticated() {
      return this._auth.isAuthenticated();
    }

    /** @returns {object|null} 缓存的用户信息，不发请求。 */
    getCurrentUser() {
      return this._auth.getCachedUser();
    }

    /** 登出：best-effort 撤销服务端 token，再清理本地。不跳转。 */
    logout() {
      return this._auth.logout();
    }
  }

  global.SekaiPassAuth = SekaiPassAuth;
})(window);
