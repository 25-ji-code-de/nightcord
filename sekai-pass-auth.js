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
 * SEKAI Pass OAuth 客户端
 * 实现 OAuth 2.1 + PKCE 授权流程
 */
(function (global) {
  class SekaiPassAuth {
    constructor({ clientId, redirectUri, authEndpoint, tokenEndpoint, userInfoEndpoint, onAuthExpired } = {}) {
      this.clientId = clientId || 'nightcord_client';
      this.redirectUri = redirectUri || `${window.location.origin}/auth/callback`;
      this.authEndpoint = authEndpoint || 'https://id.nightcord.de5.net/oauth/authorize';
      this.tokenEndpoint = tokenEndpoint || 'https://id.nightcord.de5.net/oauth/token';
      this.userInfoEndpoint = userInfoEndpoint || 'https://id.nightcord.de5.net/oauth/userinfo';
      this.onAuthExpired = onAuthExpired; // 授权过期回调

      this.storagePrefix = 'sekai_pass_';
      /** @type {Promise<string>|null} single-flight refresh */
      this._refreshPromise = null;
    }

    /**
     * 生成随机字符串
     */
    generateRandomString(length = 43) {
      const array = new Uint8Array(length);
      crypto.getRandomValues(array);
      return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
    }

    /**
     * SHA-256 哈希
     */
    async sha256(plain) {
      const encoder = new TextEncoder();
      const data = encoder.encode(plain);
      const hash = await crypto.subtle.digest('SHA-256', data);
      return hash;
    }

    /**
     * Base64 URL 编码
     */
    base64UrlEncode(arrayBuffer) {
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    }

    /**
     * 生成 PKCE code_verifier 和 code_challenge
     */
    async generatePKCE() {
      const codeVerifier = this.generateRandomString(128);
      const hashed = await this.sha256(codeVerifier);
      const codeChallenge = this.base64UrlEncode(hashed);

      return {
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: 'S256'
      };
    }

    /**
     * 开始 OAuth 授权流程
     */
    async login() {
      try {
        // 生成 PKCE 参数
        const { codeVerifier, codeChallenge } = await this.generatePKCE();
        const state = this.generateRandomString(32);

        // 保存到 sessionStorage（临时存储）
        sessionStorage.setItem(`${this.storagePrefix}code_verifier`, codeVerifier);
        sessionStorage.setItem(`${this.storagePrefix}state`, state);

        // 构造授权 URL
        const params = new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: this.redirectUri,
          response_type: 'code',
          scope: 'openid profile email',
          state: state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
        });

        const authUrl = `${this.authEndpoint}?${params.toString()}`;

        // 跳转到授权页面
        window.location.href = authUrl;
      } catch (error) {
        console.error('Login failed:', error);
        throw error;
      }
    }

    /**
     * 处理授权回调
     */
    async handleCallback() {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const state = params.get('state');
        const error = params.get('error');

        // 检查错误
        if (error) {
          throw new Error(`OAuth error: ${error} - ${params.get('error_description')}`);
        }

        // 验证 state
        const savedState = sessionStorage.getItem(`${this.storagePrefix}state`);
        if (!state || state !== savedState) {
          throw new Error('Invalid state parameter');
        }

        // 获取 code_verifier
        const codeVerifier = sessionStorage.getItem(`${this.storagePrefix}code_verifier`);
        if (!codeVerifier) {
          throw new Error('Missing code_verifier');
        }

        // 交换 access token
        const tokenResponse = await fetch(this.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: this.redirectUri,
            client_id: this.clientId,
            code_verifier: codeVerifier
          })
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json();
          throw new Error(`Token exchange failed: ${errorData.error}`);
        }

        const tokens = await tokenResponse.json();

        // 保存 tokens 到 localStorage
        localStorage.setItem(`${this.storagePrefix}access_token`, tokens.access_token);
        localStorage.setItem(`${this.storagePrefix}refresh_token`, tokens.refresh_token);
        const expiresIn = Number(tokens.expires_in) || 3600;
        localStorage.setItem(`${this.storagePrefix}expires_at`, String(Date.now() + expiresIn * 1000));

        // 清理 sessionStorage
        sessionStorage.removeItem(`${this.storagePrefix}code_verifier`);
        sessionStorage.removeItem(`${this.storagePrefix}state`);

        // 获取用户信息
        const userInfo = await this.getUserInfo();

        return userInfo;
      } catch (error) {
        console.error('Callback handling failed:', error);
        throw error;
      }
    }

    /**
     * 刷新 access token（并发调用共享同一 Promise，避免多路 refresh）
     */
    async refreshToken() {
      if (this._refreshPromise) {
        return this._refreshPromise;
      }

      this._refreshPromise = this._doRefreshToken().finally(() => {
        this._refreshPromise = null;
      });
      return this._refreshPromise;
    }

    async _doRefreshToken() {
      const refreshToken = localStorage.getItem(`${this.storagePrefix}refresh_token`);
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      try {
        const tokenResponse = await fetch(this.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.clientId
          })
        });

        if (!tokenResponse.ok) {
          let errorData = {};
          try {
            errorData = await tokenResponse.json();
          } catch (_) {
            /* ignore */
          }
          // 如果 refresh token 也失效了，清理所有数据并触发重新登录
          // 按 error code 判断，而非 HTTP status —— 服务端对 invalid_client 返回 400
          // （RFC 6749 §5.2），按 status 码判断会漏掉这种情况
          if (errorData.error === 'invalid_grant' || errorData.error === 'invalid_client') {
            console.log('Refresh token expired, triggering re-authentication...');
            this.logout();

            // 触发授权过期回调
            if (this.onAuthExpired) {
              this.onAuthExpired();
            }
          }
          throw new Error(`Token refresh failed: ${errorData.error || tokenResponse.status}`);
        }

        const tokens = await tokenResponse.json();

        // 更新 tokens
        localStorage.setItem(`${this.storagePrefix}access_token`, tokens.access_token);
        if (tokens.refresh_token) {
          // OAuth 2.1 支持 refresh token 轮换
          localStorage.setItem(`${this.storagePrefix}refresh_token`, tokens.refresh_token);
        }
        const expiresIn = Number(tokens.expires_in) || 3600;
        localStorage.setItem(`${this.storagePrefix}expires_at`, String(Date.now() + expiresIn * 1000));

        return tokens.access_token;
      } catch (error) {
        console.error('Token refresh failed:', error);
        throw error;
      }
    }

    /**
     * 获取有效的 access token（自动刷新）
     */
    async getAccessToken() {
      const accessToken = localStorage.getItem(`${this.storagePrefix}access_token`);
      const expiresAt = localStorage.getItem(`${this.storagePrefix}expires_at`);

      if (!accessToken || !expiresAt) {
        throw new Error('Not authenticated');
      }

      // 如果 token 已过期或即将过期（5 分钟内），自动刷新
      const now = Date.now();
      const expiresAtTime = parseInt(expiresAt, 10);
      const fiveMinutes = 5 * 60 * 1000;

      if (!Number.isFinite(expiresAtTime) || now >= expiresAtTime || (expiresAtTime - now) < fiveMinutes) {
        console.log('Access token expired or expiring soon, refreshing...');
        return await this.refreshToken();
      }

      return accessToken;
    }

    /**
     * 获取用户信息
     */
    async getUserInfo() {
      try {
        const accessToken = await this.getAccessToken();

        const response = await fetch(this.userInfoEndpoint, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch user info');
        }

        const userInfo = await response.json();

        // 保存用户信息到 localStorage
        localStorage.setItem(`${this.storagePrefix}user`, JSON.stringify(userInfo));

        return userInfo;
      } catch (error) {
        console.error('Failed to get user info:', error);
        throw error;
      }
    }

    /**
     * 检查是否已登录
     * 有 refresh token 时视为已登录（access 可静默刷新）— 与 hub/25ji 一致
     */
    isAuthenticated() {
      const accessToken = localStorage.getItem(`${this.storagePrefix}access_token`);
      if (!accessToken) return false;
      if (localStorage.getItem(`${this.storagePrefix}refresh_token`)) return true;
      const expiresAt = localStorage.getItem(`${this.storagePrefix}expires_at`);
      if (!expiresAt) return false;
      const exp = parseInt(expiresAt, 10);
      return Number.isFinite(exp) && Date.now() < exp;
    }

    /**
     * 获取当前用户
     */
    getCurrentUser() {
      const userJson = localStorage.getItem(`${this.storagePrefix}user`);
      if (!userJson) return null;
      try {
        return JSON.parse(userJson);
      } catch {
        return null;
      }
    }

    /**
     * 登出：尽力撤销服务端 token，再清理本地
     */
    logout() {
      const accessToken = localStorage.getItem(`${this.storagePrefix}access_token`);
      const refreshToken = localStorage.getItem(`${this.storagePrefix}refresh_token`);

      // Best-effort RFC 7009 revoke (fire-and-forget)
      const revoke = (token, hint) => {
        if (!token) return;
        try {
          void fetch(this.tokenEndpoint.replace(/\/token$/, '/revoke'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token,
              token_type_hint: hint,
              client_id: this.clientId,
            }),
            keepalive: true,
          }).catch(() => {});
        } catch (_) {
          /* ignore */
        }
      };
      revoke(refreshToken, 'refresh_token');
      revoke(accessToken, 'access_token');

      // 清理所有存储的数据
      localStorage.removeItem(`${this.storagePrefix}access_token`);
      localStorage.removeItem(`${this.storagePrefix}refresh_token`);
      localStorage.removeItem(`${this.storagePrefix}expires_at`);
      localStorage.removeItem(`${this.storagePrefix}user`);
      sessionStorage.removeItem(`${this.storagePrefix}code_verifier`);
      sessionStorage.removeItem(`${this.storagePrefix}state`);
    }
  }

  global.SekaiPassAuth = SekaiPassAuth;
})(window);
