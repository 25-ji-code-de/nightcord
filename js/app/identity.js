/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** IdentityController: identity component; app supplies shared presentation context. */
class IdentityController {
  constructor(app) {
    this.app = app;
    this.sessionExpected = false;
    this.authExpired = false;
    this.sessionVersion = 0;
  }

  setup() {
    // 初始化 SEKAI Pass OAuth 客户端（需要在 Nako 之前初始化）
    const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    this.app.sekaiPassAuth = new SekaiPassAuth({
      clientId: 'nightcord_client',
      redirectUri: isLocalDev ? window.location.origin : `${window.location.origin}/auth/callback`,
      onAuthExpired: () => this.handleAuthExpired()
    });
    this.app.ui.sekaiPassLoginCallback = () => this.app.sekaiPassAuth.login();
    this.app.ui.onRefreshProfile = () => this.app.chatRoom.refreshAuthentication();
    this.app.ui.onLogout = async () => {
      void window.NightcordPWA?.logout();
      this.resetSession(false);
      this.app.chatRoom.leave();
      this.app.ui.setSessionUnavailable();
      await this.app.sekaiPassAuth.logout();
      this.app.broadcastIdentityChange();
      this.app.restoreGuest();
    };
    this.onStorage = (event) => {
      if (event.key === 'nightcord-identity-event') {
        this.resetSession(this.app.sekaiPassAuth.isAuthenticated());
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
      } else if (event.key === 'nightcord-sekai-session' && !event.newValue) {
        // An explicit logout/guest choice in another tab precedes token removal.
        this.resetSession(false);
      } else if (event.key === null || (event.key?.startsWith('sekai_pass_') && !event.newValue)) {
        void this.checkSession();
      } else if (event.key === 'nightcord-guest-name' && event.newValue && !this.app.sekaiPassAuth.isAuthenticated()
        && this.app.chatRoom.currentUser && !this.app.chatRoom.currentUser.authenticated && this.app.chatRoom.username !== event.newValue) {
        this.app.chatRoom.setUser(event.newValue);
      }
    };
    window.addEventListener('storage', this.onStorage);
    this.onResume = () => { void this.checkSession(); };
    document.addEventListener('visibilitychange', this.onResume);
    for (const event of ['pageshow', 'focus', 'online']) window.addEventListener(event, this.onResume);
    // Mobile browsers suspend timers in the background; resume events check immediately.
    this.sessionTimer = setInterval(this.onResume, 60000);
    this.app.eventBus.on('guest:required', ({ error }) => {
      this.app.ui.showError(error.message);
      this.app.ui.setSessionUnavailable();
    });
    this.app.eventBus.on('auth:required', () => this.handleAuthExpired());

    this.app.restoreGuest = () => {
      this.app.chatRoom.currentUser = null;
      this.app.ui.currentUser = null;
      let guestName;
      try { guestName = localStorage.getItem('nightcord-guest-name'); } catch (e) {}
      if (guestName) {
        this.app.chatRoom.setUser(guestName);
        this.app.joinRoom(this.app.chatRoom.roomname || this.initialRoom || 'nightcord-default');
        return;
      }
      this.app.ui.showNameChooser({ mode: 'init' }, (username) => {
        this.app.chatRoom.setUser(username);
        this.app.joinRoom(this.app.chatRoom.roomname || this.initialRoom || 'nightcord-default');
      }, this.app.ui.sekaiPassLoginCallback);
    };


    this.app.eventBus.on('user:set', ({ username }) => {
      try { localStorage.setItem('nightcord-username', username); } catch {}
    });
    this.app.eventBus.on('session:updated', ({ user }) => {
      if (user.authenticated) this.resetSession(true);
      else if (this.sessionExpected) this.handleAuthExpired();
      try {
        localStorage.setItem('nightcord-username', user.displayName);
        if (!user.authenticated) localStorage.setItem('nightcord-guest-name', user.displayName);
      } catch {}
    });
  }

  setSessionExpected(expected) {
    this.sessionExpected = expected;
    try {
      if (expected) localStorage.setItem('nightcord-sekai-session', '1');
      else localStorage.removeItem('nightcord-sekai-session');
    } catch {}
  }

  resetSession(expected) {
    this.sessionVersion += 1;
    this.setSessionExpected(expected);
    this.authExpired = false;
    this.dismissAuthExpired?.();
    this.dismissAuthExpired = null;
  }

  /** Token provider for chat: never silently reconnect a signed-in user as a guest. */
  async getAccessToken() {
    if (this.authExpired) throw new Error('SEKAI Pass session expired');
    const auth = this.app.sekaiPassAuth;
    if (!auth.isAuthenticated()) {
      if (!this.sessionExpected) return null;
      this.handleAuthExpired();
      throw new Error('SEKAI Pass session expired');
    }
    this.setSessionExpected(true);
    const version = this.sessionVersion;
    try {
      return await auth.getAccessToken();
    } catch (error) {
      if (version === this.sessionVersion) this.handleAuthExpired();
      throw error;
    }
  }

  async checkSession() {
    if (this.destroyed || document.visibilityState === 'hidden' || this.checkingSession || this.authExpired || !this.sessionExpected) return;
    // Missing local credentials are detectable even while offline.
    if (!this.app.sekaiPassAuth.isAuthenticated()) {
      this.handleAuthExpired();
      return;
    }
    if (navigator.onLine === false) return;
    this.checkingSession = true;
    const version = this.sessionVersion;
    try {
      await this.getAccessToken();
      if (!this.destroyed && version === this.sessionVersion && !this.authExpired) {
        // Ask the chat server to validate too, so revoked tokens are detected without sending a message.
        if (this.app.chatRoom.wsManager.isConnected()) await this.app.chatRoom.refreshAuthentication();
        else await this.app.sekaiPassAuth.getUserInfo();
      }
    } catch {
      // A userinfo 401 clears local credentials. Network/5xx errors leave them intact.
      if (version === this.sessionVersion && !this.app.sekaiPassAuth.isAuthenticated()) this.handleAuthExpired();
    }
    finally { this.checkingSession = false; }
  }

  handleAuthExpired(notice) {
    if (this.destroyed || this.authExpired || !this.sessionExpected) return;
    this.authExpired = true;
    void window.NightcordPWA?.logout();
    this.app.chatRoom.wsManager.pauseAutoReconnect();
    this.app.chatRoom.leave();
    this.app.chatRoom.currentUser = null;
    this.app.ui.setSessionUnavailable();
    this.dismissAuthExpired = this.app.ui.showAuthExpired({
      notice,
      onRetry: () => this.app.sekaiPassAuth.login(),
      onContinue: async () => {
        this.resetSession(false);
        await this.app.sekaiPassAuth.clearSession();
        this.app.broadcastIdentityChange();
        this.app.restoreGuest();
      }
    });
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.sessionTimer);
    window.removeEventListener('storage', this.onStorage);
    document.removeEventListener('visibilitychange', this.onResume);
    for (const event of ['pageshow', 'focus', 'online']) window.removeEventListener(event, this.onResume);
    this.dismissAuthExpired?.();
  }

  /**
   * 初始化应用
   */
  init(roomname) {
    this.initialRoom = roomname;
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

    let previousSession = false;
    try { previousSession = localStorage.getItem('nightcord-sekai-session') === '1'; } catch {}
    this.setSessionExpected(previousSession || this.app.sekaiPassAuth.isAuthenticated() || !!this.app.sekaiPassAuth.getCurrentUser());
    if (this.sessionExpected && !this.app.sekaiPassAuth.isAuthenticated()) {
      this.handleAuthExpired();
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
      this.resetSession(true);

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
      let recoveringSession = this.sessionExpected;
      try { recoveringSession ||= localStorage.getItem('nightcord-sekai-session') === '1'; } catch {}
      if (recoveringSession) {
        // A canceled/failed relogin returns to the same choice, without stacking error dialogs.
        window.history.replaceState({}, document.title, returnPath);
        this.initialRoom = roomname;
        this.setSessionExpected(true);
        this.handleAuthExpired('重新登录未完成；请重试，或以访客身份继续。');
        return;
      }
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
