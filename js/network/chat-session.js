/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Nightcord authentication/guest handshake. The socket transport does not interpret these frames. */
class ChatSessionProtocol {
  static guestRequests = new Map();
  static isMobileDevice() {
    const device = globalThis.navigator;
    return device?.userAgentData?.mobile === true
      || /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini|BlackBerry|webOS|Kindle|Silk|Dalvik|HarmonyOS/i.test(device?.userAgent || '')
      || (/Macintosh/i.test(device?.userAgent || '') && device?.maxTouchPoints > 1);
  }

  constructor(config = {}) {
    this.hostname = config.hostname || 'chat.nightcord.de5.net';
    this.getAccessToken = config.getAccessToken || (async () => null);
    this.onAuthError = config.onAuthError || (() => {});
    this._authTimer = null;
    this._authRefreshing = false;
    this.authExpiresAt = 0;
    this.guestExpiresAt = 0;
    this._guestTimer = null;
    this._guestRecoveries = 0;
    this.fetch = config.fetch || ((...args) => globalThis.fetch(...args));
    this.onGuestError = config.onGuestError || (() => {});

  }

  attach(connection) { this.connection = connection; }
  url(room) { return 'wss://' + this.hostname + '/api/room/' + encodeURIComponent(room) + '/websocket'; }

  reset() {
    clearTimeout(this._authTimer);
    clearTimeout(this._guestTimer);
    this._authRefreshing = false;
    this.authExpiresAt = 0;
    this.guestExpiresAt = 0;
  }

  async prepare(gen) {
    let token;
    try { token = await this.getAccessToken(); }
    catch (error) {
      if (gen === this.connection._gen) { this.connection.pauseAutoReconnect(); this.onAuthError(error); }
      return;
    }
    if (gen !== this.connection._gen) return;
    try { if (!token) await this.prepareGuestSession(); }
    catch (error) {
      if (gen === this.connection._gen) {
        this.connection.onError(error);
        if (this.connection.shouldReconnect) void this.connection.rejoin();
      }
      return;
    }
    if (gen !== this.connection._gen) return;
    return { token };
  }

  open(ws, { token }, username) {
    ws.send(JSON.stringify({ ...(token ? { accessToken: token } : { name: username }), isMobile: ChatSessionProtocol.isMobileDevice() }));
  }

  message(data, ws) {
    if (data.type === 'session') {
      this._authRefreshing = false;
      this.authExpiresAt = data.authExpiresAt || 0;
      this.guestExpiresAt = data.guestExpiresAt || 0;
      this.connection.username = data.user.displayName;
      this.scheduleGuestRenewal();
      clearTimeout(this._authTimer);
      if (this.authExpiresAt) {
        this._authTimer = setTimeout(() => this.refreshAuthentication(), Math.max(1000, this.authExpiresAt - Date.now() - 60000));
      }
    }
    if (data.ready) { this.connection.ready = true; this._guestRecoveries = 0; }
    if (data.code === 'guest_session_required') {
      this.connection.ready = false;
      if (this._guestRecoveries++ < 1) {
        this.connection.onReconnect();
        this.connection.connect(this.connection.roomname, this.connection.username);
      } else {
        this.connection.pauseAutoReconnect();
        this.onGuestError(new Error('浏览器未允许保存访客身份。请允许此站点使用 Cookie，或使用 SEKAI Pass 登录。'));
      }
      return false;
    }
    if (data.code === 'auth_invalid') {
      this.connection.ready = false;
      this.connection.pauseAutoReconnect();
      this.onAuthError(new Error(data.error));
    }
    if (data.code === 'auth_required') void this.refreshAuthentication();
    if (data.code === 'auth_unavailable') ws.close(1013, 'Authentication service unavailable');
    return true;
  }

  close(event) {
    this.reset();
    if (event.code === 4001) {
      const notify = this.connection.shouldReconnect;
      this.connection.pauseAutoReconnect();
      // The preceding auth_invalid frame can be lost during a mobile network change.
      if (notify) this.onAuthError(new Error('SEKAI Pass session expired'));
    }
  }

  canSend() {
    if (this._authRefreshing) return false;
    if (this.guestExpiresAt && Date.now() >= this.guestExpiresAt) {
      this.connection.ready = false;
      this.connection.onReconnect();
      this.connection.connect(this.connection.roomname, this.connection.username);
      return false;
    }
    if (this.authExpiresAt && Date.now() >= this.authExpiresAt) {
      void this.refreshAuthentication();
      return false;
    }
    return true;
  }

  async prepareGuestSession() {
    const url = 'https://' + this.hostname + '/api/guest/session';
    if (!ChatSessionProtocol.guestRequests.has(url)) {
      const initialize = async () => {
        const response = await this.fetch(url, {
          method: 'POST', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(12000),
        });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || 'Guest identity unavailable'), { code: data.code });
        if (!/^guest:[0-9a-f-]{36}$/.test(data.id) || !Number.isSafeInteger(data.expiresAt)) throw new Error('Invalid guest session response');
      };
      const request = globalThis.navigator?.locks
        ? navigator.locks.request('nightcord:guest:' + this.hostname, initialize) : initialize();
      ChatSessionProtocol.guestRequests.set(url, request);
      request.then(() => ChatSessionProtocol.guestRequests.delete(url), () => ChatSessionProtocol.guestRequests.delete(url));
    }
    return ChatSessionProtocol.guestRequests.get(url);
  }

  scheduleGuestRenewal() {
    clearTimeout(this._guestTimer);
    if (!this.guestExpiresAt) return;
    const remaining = this.guestExpiresAt - Date.now() - 30 * 86400000;
    this._guestTimer = setTimeout(() => {
      if (remaining > 2147483647) this.scheduleGuestRenewal();
      else {
        this.connection.ready = false;
        this.connection.onReconnect();
        this.connection.connect(this.connection.roomname, this.connection.username);
      }
    }, Math.min(2147483647, Math.max(1000, remaining)));
  }

  async refreshAuthentication() {
    if (this._authRefreshing || !this.connection.isConnected()) return;
    this._authRefreshing = true;
    const ws = this.connection.ws;
    try {
      const token = await this.getAccessToken();
      if (!token) throw new Error('SEKAI Pass session expired');
      if (this.connection.ws === ws && ws.readyState === WebSocket.OPEN) {
        clearTimeout(this._authTimer);
        this._authTimer = setTimeout(() => {
          if (this.connection.ws === ws && this._authRefreshing) ws.close(1013, 'Authentication timed out');
        }, 12000);
        ws.send(JSON.stringify({ type: 'auth', accessToken: token }));
      } else this._authRefreshing = false;
    } catch (error) {
      if (this.connection.ws === ws) {
        this.connection.pauseAutoReconnect();
        this.connection.ready = false;
        this._authRefreshing = false;
        this.onAuthError(error);
        ws.close(4001, 'Authentication required');
      }
    }
  }
}
