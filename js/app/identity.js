/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** IdentityController: identity component; app supplies shared presentation context. */
class IdentityController {
  constructor(app) { this.app = app; }

  setup() {
    // 初始化 SEKAI Pass OAuth 客户端（需要在 Nako 之前初始化）
    const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    this.app.sekaiPassAuth = new SekaiPassAuth({
      clientId: 'nightcord_client',
      redirectUri: isLocalDev ? window.location.origin : `${window.location.origin}/auth/callback`,
      onAuthExpired: () => {
        console.log('授权已过期，正在重新登录...');
        setTimeout(() => {
          this.app.sekaiPassAuth.login();
        }, 1000);
      }
    });
    this.app.ui.sekaiPassLoginCallback = () => this.app.sekaiPassAuth.login();
    this.app.ui.onRefreshProfile = () => this.app.chatRoom.refreshAuthentication();
    this.app.ui.onLogout = async () => {
      this.app.chatRoom.leave();
      this.app.ui.setSessionUnavailable();
      await this.app.sekaiPassAuth.logout();
      this.app.broadcastIdentityChange();
      this.app.restoreGuest();
    };
    this.onStorage = (event) => {
      if (event.key === 'nightcord-identity-event') {
        this.app.chatRoom.leave();
        this.app.ui.setSessionUnavailable();
        if (this.app.sekaiPassAuth.isAuthenticated()) {
          const user = this.app.sekaiPassAuth.getCurrentUser();
          const name = user && (user.name || user.display_name || user.preferred_username || user.username || user.sub);
          if (name) {
            this.app.chatRoom.setUser(name);
            this.app.joinRoom(this.app.chatRoom.roomname || 'nightcord-default');
            return;
          }
        }
        this.app.restoreGuest();
      } else if (event.key === 'nightcord-guest-name' && event.newValue && !this.app.sekaiPassAuth.isAuthenticated()
        && this.app.chatRoom.currentUser && !this.app.chatRoom.currentUser.authenticated && this.app.chatRoom.username !== event.newValue) {
        this.app.chatRoom.setUser(event.newValue);
      }
    };
    window.addEventListener('storage', this.onStorage);
    this.app.eventBus.on('guest:required', ({ error }) => {
      this.app.ui.showError(error.message);
      this.app.ui.setSessionUnavailable();
    });
    this.app.eventBus.on('auth:required', () => {
      this.app.ui.showError('SEKAI Pass 登录已失效，请重新登录。');
      this.app.ui.setSessionUnavailable();
    });

    this.app.restoreGuest = () => {
      this.app.chatRoom.currentUser = null;
      this.app.ui.currentUser = null;
      let guestName;
      try { guestName = localStorage.getItem('nightcord-guest-name'); } catch (e) {}
      if (guestName) {
        this.app.chatRoom.setUser(guestName);
        this.app.joinRoom(this.app.chatRoom.roomname || 'nightcord-default');
        return;
      }
      this.app.ui.showNameChooser({ mode: 'init' }, (username) => {
        this.app.chatRoom.setUser(username);
        this.app.joinRoom(this.app.chatRoom.roomname || 'nightcord-default');
      }, this.app.ui.sekaiPassLoginCallback);
    };


    this.app.eventBus.on('user:set', ({ username }) => {
      try { localStorage.setItem('nightcord-username', username); } catch {}
    });
    this.app.eventBus.on('session:updated', ({ user }) => {
      try {
        localStorage.setItem('nightcord-username', user.displayName);
        if (!user.authenticated) localStorage.setItem('nightcord-guest-name', user.displayName);
      } catch {}
    });
  }

  destroy() { window.removeEventListener('storage', this.onStorage); }

  /**
   * 初始化应用
   */
  init(roomname) {
    this.app.state.phase = 'name-choosing';

    // 初始化 SEKAI Analytics（事件上报服务）
    this.app.analytics = new SekaiAnalytics({
      apiUrl: 'https://api.nightcord.de5.net',
      eventBus: this.app.eventBus,
      sekaiPassAuth: this.app.sekaiPassAuth
    });

    // 检查是否是 OAuth 回调（通过 URL 参数判断）
    const urlParams = new URLSearchParams(window.location.search);
    if ((urlParams.has('code') && urlParams.has('state')) || urlParams.has('error')) {
      this.app.handleOAuthCallback(roomname);
      return;
    }

    // 检查是否已通过 SEKAI Pass 登录
    if (this.app.sekaiPassAuth.isAuthenticated()) {
      const user = this.app.sekaiPassAuth.getCurrentUser();
      // 优先使用 name，其次 preferred_username，最后 sub
      const username = user && (user.name || user.display_name || user.preferred_username || user.username || user.sub);
      if (user && username) {
        this.app.chatRoom.setUser(username);
        this.app.joinRoom(roomname || 'nightcord-default');
        return;
      }
    }

    // 尝试从 localStorage 获取已保存的用户名（降级方案）
    const storedName = localStorage.getItem('nightcord-guest-name') || localStorage.getItem('nightcord-username');

    if (storedName) {
      // 如果已有用户名，直接加入房间
      this.app.chatRoom.setUser(storedName);
      // 保存 SEKAI Pass 回调，改昵称时可用
      this.app.ui.sekaiPassLoginCallback = () => this.app.sekaiPassAuth.login();
      this.app.joinRoom(roomname || 'nightcord-default');
    } else {
      // 如果没有用户名，设置用户名选择器
      this.app.ui.setupNameChooser((username) => {
        this.app.chatRoom.setUser(username);
        this.app.joinRoom(roomname || 'nightcord-default');
      }, () => {
        // SEKAI Pass 登录回调
        this.app.sekaiPassAuth.login();
      });
    }
  }

  /**
   * 处理 OAuth 回调
   */
  async handleOAuthCallback(roomname) {
    try {
      const savedRoom = sessionStorage.getItem('nightcord-oauth-room');
      if (!roomname && savedRoom === 'nightcord-test') roomname = savedRoom;
      sessionStorage.removeItem('nightcord-oauth-room');
    } catch (e) {}
    const returnPath = roomname === 'nightcord-test' ? '/?test' : '/';
    try {
      const userInfo = await this.app.sekaiPassAuth.handleCallback();

      // 优先使用 name，其次 preferred_username，最后 sub
      const username = userInfo.name || userInfo.display_name || userInfo.preferred_username || userInfo.username || userInfo.sub;

      // 使用 SEKAI Pass 的用户名
      this.app.chatRoom.setUser(username);
      this.app.broadcastIdentityChange();

      // 清理 URL（移除查询参数）
      window.history.replaceState({}, document.title, returnPath);

      // 加入房间
      this.app.joinRoom(roomname || 'nightcord-default');
    } catch (error) {
      // 把 SDK / 适配层抛出的原始异常翻译成带错误码的可读描述。
      // describeAuthError 始终保留 sourceCode 与 originalMessage，控制台不丢信息。
      const descriptor = window.describeAuthError(error);
      console.error('[Nightcord Auth]', descriptor, error);
      this.app.ui.showAuthError(descriptor, {
        onRetry: () => this.app.sekaiPassAuth.login(),
      });

      // 清理 URL 并回到名称选择
      window.history.replaceState({}, document.title, returnPath);
      this.app.init(roomname);
    }
  }

  broadcastIdentityChange() {
    // A notification only: each tab obtains credentials and the server verifies them.
    try { localStorage.setItem('nightcord-identity-event', JSON.stringify({ at: Date.now(), nonce: crypto.randomUUID() })); } catch (e) {}
  }
}
