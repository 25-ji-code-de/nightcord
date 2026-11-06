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
 * WebSocketManager - WebSocket 连接管理器
 * 负责管理 WebSocket 连接的生命周期，包括连接、断开、重连等
 *
 * @example
 * const wsManager = new WebSocketManager({
 *   hostname: 'example.com',
 *   onMessage: (data) => console.log('Message:', data),
 *   onOpen: () => console.log('Connected'),
 *   onClose: () => console.log('Disconnected')
 * });
 *
 * wsManager.connect('nightcord-default', 'K');
 * wsManager.send({ message: 'As always, at 25:00.' });
 * wsManager.disconnect();
 */
class WebSocketManager {
  static guestRequests = new Map();
  /**
   * 创建 WebSocket 管理器实例
   * @param {Object} config - 配置对象
   * @param {string} [config.hostname] - WebSocket 服务器主机名
   * @param {number} [config.reconnectDelay=10000] - 重连延迟（毫秒）
   * @param {Function} [config.onOpen] - 连接打开时的回调
   * @param {Function} [config.onMessage] - 收到消息时的回调
   * @param {Function} [config.onClose] - 连接关闭时的回调
   * @param {Function} [config.onError] - 发生错误时的回调
   * @param {Function} [config.onReconnect] - 重连时的回调
   */
  constructor(config = {}) {
    this.hostname = config.hostname || 'chat.nightcord.de5.net';
    this.reconnectDelay = config.reconnectDelay || 10000;
    this.ws = null;
    this.rejoined = false;
    // Whether disconnection should attempt to reconnect. When user intentionally
    // requests to pause auto-reconnect, this will be false.
    this.shouldReconnect = true;
    this.startTime = null;
    this.roomname = null;
    this.username = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._reconnectTimer = null;
    /** Generation token so stale sockets/timers cannot rejoin after a new connect */
    this._gen = 0;
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
    this.ready = false;

    // Callbacks
    this.onOpen = config.onOpen || (() => {});
    this.onMessage = config.onMessage || (() => {});
    this.onClose = config.onClose || (() => {});
    this.onError = config.onError || (() => {});
    this.onReconnect = config.onReconnect || (() => {});
  }

  /**
   * 连接到 WebSocket 服务器
   * @param {string} roomname - 房间名称
   * @param {string} username - 用户名
   */
  connect(roomname, username) {
    this.roomname = roomname;
    this.username = username;
    this.rejoined = false;
    this.shouldReconnect = true;
    this.startTime = Date.now();
    this._gen += 1;
    const gen = this._gen;
    clearTimeout(this._authTimer);
    clearTimeout(this._guestTimer);
    this._authRefreshing = false;
    this.ready = false;
    this.authExpiresAt = 0;
    this.guestExpiresAt = 0;

    // Drop previous socket without triggering a parallel reconnect loop
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
      this.ws = null;
    }

    this.connectionPromise = this.openConnection(gen, roomname, username);
    return this.connectionPromise;
  }

  async prepareGuestSession() {
    const url = 'https://' + this.hostname + '/api/guest/session';
    if (!WebSocketManager.guestRequests.has(url)) {
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
      WebSocketManager.guestRequests.set(url, request);
      request.then(() => WebSocketManager.guestRequests.delete(url), () => WebSocketManager.guestRequests.delete(url));
    }
    return WebSocketManager.guestRequests.get(url);
  }

  async openConnection(gen, roomname, username) {
    let token;
    try { token = await this.getAccessToken(); }
    catch (error) {
      if (gen === this._gen) { this.pauseAutoReconnect(); this.onAuthError(error); }
      return;
    }
    if (gen !== this._gen) return;
    try { if (!token) await this.prepareGuestSession(); }
    catch (error) {
      if (gen === this._gen) {
        this.onError(error);
        if (this.shouldReconnect) void this.rejoin();
      }
      return;
    }
    if (gen !== this._gen) return;
    let ws;
    try { ws = new WebSocket('wss://' + this.hostname + '/api/room/' + encodeURIComponent(roomname) + '/websocket'); }
    catch (error) { this.onError(error); if (this.shouldReconnect) void this.rejoin(); return; }
    this.ws = ws;

    ws.addEventListener('open', async (event) => {
      if (gen !== this._gen || this.ws !== ws) return;
      ws.send(JSON.stringify(token ? { accessToken: token } : { name: username }));
      this.onOpen(event);
    });

    ws.addEventListener('message', (event) => {
      if (gen !== this._gen || this.ws !== ws) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('WebSocketManager: invalid JSON message', e);
        return;
      }
      if (data.type === 'session') {
        this._authRefreshing = false;
        this.authExpiresAt = data.authExpiresAt || 0;
        this.guestExpiresAt = data.guestExpiresAt || 0;
        this.username = data.user.displayName;
        this.scheduleGuestRenewal();
        clearTimeout(this._authTimer);
        if (this.authExpiresAt) {
          this._authTimer = setTimeout(() => this.refreshAuthentication(), Math.max(1000, this.authExpiresAt - Date.now() - 60000));
        }
      }
      if (data.ready) { this.ready = true; this._guestRecoveries = 0; }
      if (data.code === 'guest_session_required') {
        this.ready = false;
        if (this._guestRecoveries++ < 1) {
          this.onReconnect();
          this.connect(this.roomname, this.username);
        } else {
          this.pauseAutoReconnect();
          this.onGuestError(new Error('浏览器未允许保存访客身份。请允许此站点使用 Cookie，或使用 SEKAI Pass 登录。'));
        }
        return;
      }
      if (data.code === 'auth_invalid') {
        this.ready = false;
        this.pauseAutoReconnect();
        this.onAuthError(new Error(data.error));
      }
      if (data.code === 'auth_required') void this.refreshAuthentication();
      if (data.code === 'auth_unavailable') ws.close(1013, 'Authentication service unavailable');
      this.onMessage(data);
    });

    ws.addEventListener('close', (event) => {
      if (gen !== this._gen) return;
      this.ready = false;
      this._authRefreshing = false;
      clearTimeout(this._authTimer);
      clearTimeout(this._guestTimer);
      if (event.code === 4001) this.pauseAutoReconnect();
      console.log('WebSocket closed, reconnecting:', event.code, event.reason);
      this.onClose(event);
      if (this.shouldReconnect) this.rejoin();
    });

    ws.addEventListener('error', (event) => {
      if (gen !== this._gen) return;
      console.log('WebSocket error:', event);
      this.onError(event);
      // close event will usually follow; only rejoin here if socket already closed
      if (this.shouldReconnect && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
        this.rejoin();
      }
    });
  }

  /**
   * 重新连接到服务器
   * @private
   */
  async rejoin() {
    if (this.rejoined || !this.shouldReconnect) return;
    if (!this.roomname || !this.username) return;

    this.rejoined = true;
    this.ws = null;
    this.onReconnect();

    const timeSinceLastJoin = Date.now() - (this.startTime || 0);
    const wait = Math.max(0, this.reconnectDelay - timeSinceLastJoin);

    if (wait > 0) {
      await new Promise((resolve) => {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          resolve();
        }, wait);
      });
    }

    if (!this.shouldReconnect) return;
    this.connect(this.roomname, this.username);
  }

  /**
   * 发送消息到服务器
   * @param {Object} message - 要发送的消息对象
   * @returns {boolean} 是否成功发送
   */
  send(message) {
    if (this._authRefreshing) return false;
    if (this.guestExpiresAt && Date.now() >= this.guestExpiresAt) {
      this.ready = false;
      this.onReconnect();
      this.connect(this.roomname, this.username);
      return false;
    }
    if (this.authExpiresAt && Date.now() >= this.authExpiresAt) {
      void this.refreshAuthentication();
      return false;
    }
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return true;
      } catch (e) {
        console.warn('WebSocketManager: send failed', e);
        return false;
      }
    }
    return false;
  }

  /**
   * 断开连接
   */
  disconnect() {
    clearTimeout(this._authTimer);
    clearTimeout(this._guestTimer);
    this.ready = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._gen += 1;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /**
   * Pause automatic reconnection. Call this before intentionally closing the
   * socket when you don't want the manager to try rejoining.
   */
  pauseAutoReconnect() {
    this.shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Resume automatic reconnection.
   */
  resumeAutoReconnect() {
    this.shouldReconnect = true;
  }

  scheduleGuestRenewal() {
    clearTimeout(this._guestTimer);
    if (!this.guestExpiresAt) return;
    const remaining = this.guestExpiresAt - Date.now() - 30 * 86400000;
    this._guestTimer = setTimeout(() => {
      if (remaining > 2147483647) this.scheduleGuestRenewal();
      else {
        this.ready = false;
        this.onReconnect();
        this.connect(this.roomname, this.username);
      }
    }, Math.min(2147483647, Math.max(1000, remaining)));
  }

  async refreshAuthentication() {
    if (this._authRefreshing || !this.isConnected()) return;
    this._authRefreshing = true;
    const ws = this.ws;
    try {
      const token = await this.getAccessToken();
      if (!token) throw new Error('SEKAI Pass session expired');
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
        clearTimeout(this._authTimer);
        this._authTimer = setTimeout(() => {
          if (this.ws === ws && this._authRefreshing) ws.close(1013, 'Authentication timed out');
        }, 12000);
        ws.send(JSON.stringify({ type: 'auth', accessToken: token }));
      } else this._authRefreshing = false;
    } catch (error) {
      if (this.ws === ws) {
        this.pauseAutoReconnect();
        this.ready = false;
        this._authRefreshing = false;
        this.onAuthError(error);
        ws.close(4001, 'Authentication required');
      }
    }
  }

  /**
   * 检查是否已连接
   * @returns {boolean} 是否已连接
   */
  isConnected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /**
   * 获取当前连接状态
   * @returns {number} WebSocket 状态码
   */
  getReadyState() {
    return this.ws ? this.ws.readyState : WebSocket.CLOSED;
  }

  /**
   * 获取连接信息
   * @returns {Object} 连接信息对象
   */
  getConnectionInfo() {
    return {
      hostname: this.hostname,
      roomname: this.roomname,
      username: this.username,
      connected: this.isConnected(),
      readyState: this.getReadyState(),
    };
  }
}
