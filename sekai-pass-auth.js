/**
 * SEKAI Pass OAuth 客户端
 * 实现 OAuth 2.1 + PKCE 授权流程
 */
(function (global) {
  class SekaiPassAuth {
    constructor({ clientId, redirectUri, authEndpoint, tokenEndpoint, userInfoEndpoint } = {}) {
      this.clientId = clientId || 'nightcord_client';
      this.redirectUri = redirectUri || `${window.location.origin}/auth/callback`;
      this.authEndpoint = authEndpoint || 'https://id.nightcord.de5.net/oauth/authorize';
      this.tokenEndpoint = tokenEndpoint || 'https://id.nightcord.de5.net/oauth/token';
      this.userInfoEndpoint = userInfoEndpoint || 'https://id.nightcord.de5.net/oauth/userinfo';

      this.storagePrefix = 'sekai_pass_';
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
        localStorage.setItem(`${this.storagePrefix}expires_at`, Date.now() + tokens.expires_in * 1000);

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
     * 获取用户信息
     */
    async getUserInfo() {
      const accessToken = localStorage.getItem(`${this.storagePrefix}access_token`);
      if (!accessToken) {
        throw new Error('Not authenticated');
      }

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
    }

    /**
     * 检查是否已登录
     */
    isAuthenticated() {
      const accessToken = localStorage.getItem(`${this.storagePrefix}access_token`);
      const expiresAt = localStorage.getItem(`${this.storagePrefix}expires_at`);

      if (!accessToken || !expiresAt) {
        return false;
      }

      // 检查是否过期
      return Date.now() < parseInt(expiresAt);
    }

    /**
     * 获取当前用户
     */
    getCurrentUser() {
      const userJson = localStorage.getItem(`${this.storagePrefix}user`);
      return userJson ? JSON.parse(userJson) : null;
    }

    /**
     * 登出
     */
    logout() {
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
