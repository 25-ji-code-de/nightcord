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
    this.hostname = config.hostname || 'edge-chat-demo.cloudflareworkers.com';
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

    const wss = 'wss://';
    const ws = new WebSocket(wss + this.hostname + '/api/room/' + encodeURIComponent(roomname) + '/websocket');
    this.ws = ws;

    ws.addEventListener('open', (event) => {
      if (gen !== this._gen || this.ws !== ws) return;
      try {
        ws.send(JSON.stringify({ name: username }));
      } catch (e) {
        console.warn('WebSocketManager: failed to send join name', e);
      }
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
      this.onMessage(data);
    });

    ws.addEventListener('close', (event) => {
      if (gen !== this._gen) return;
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
