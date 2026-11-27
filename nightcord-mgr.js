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
 * NightcordManager - 聊天室管理器
 * 负责处理聊天室的业务逻辑，包括用户管理、消息处理、房间管理等
 * 完全独立于 UI 层，通过事件总线与外部通信
 *
 * @example
 * const eventBus = new EventBus();
 * const chatRoom = new NightcordManager({
 *   hostname: 'example.com',
 *   eventBus
 * });
 *
 * // 监听事件
 * eventBus.on('message:received', (data) => {
 *   console.log(`${data.name}: ${data.message}`);
 * });
 *
 * // 使用管理器
 * chatRoom.setUser('K');
 * chatRoom.joinRoom('nightcord-default');
 * chatRoom.sendMessage('As always, at 25:00.');
 */
class NightcordManager {
  /**
   * 创建聊天室管理器实例
   * @param {Object} config - 配置对象
   * @param {string} [config.hostname] - 服务器主机名
   * @param {EventBus} [config.eventBus] - 事件总线实例
   */
  constructor(config = {}) {
    this.hostname = config.hostname || "chat.nightcord.de5.net";
    this.eventBus = config.eventBus || new EventBus();
    this.username = null;
    this.roomname = null;
    this.lastSeenTimestamp = 0;
    this.wroteWelcomeMessages = false;
    this.roster = new Map();
    this.currentUser = null;
    this.aiConfig = config.aiConfig || { getAllDisplayNames: () => [] };
    // 语C角色解析器（可选）：decode(message, room) → { name, text } | null
    this.roleplay = config.roleplay || null;
    this.fetch = config.fetch || ((...args) => globalThis.fetch(...args));
    this.visibilityState = { visibility: null, pending: null, available: false, reason: 'disconnected', error: '' };
    
    const createTransport = config.createTransport || (options => new WebSocketManager({
      ...options,
      protocol: new ChatSessionProtocol(options)
    }));
    this.wsManager = createTransport({
      hostname: this.hostname,
      getAccessToken: config.getAccessToken,
      fetch: this.fetch,
      onAuthError: (error) => this.eventBus.emit('auth:required', { error }),
      onGuestError: (error) => this.eventBus.emit('guest:required', { error }),
      onOpen: () => this.handleConnectionOpen(),
      onMessage: (data) => this.handleMessage(data),
      onClose: () => this.handleConnectionClose(),
      onError: (error) => this.handleConnectionError(error),
      onReconnect: () => this.handleReconnect()
    });
  }

  /**
   * 设置当前用户
   * @param {string} username - 用户名
   * @fires user:set
   */
  setUser(username) {
    const oldUsername = this.username;
    this.username = username;

    // Some servers only honor the name when it's the first message after opening
    // the websocket. If that's the case, we must reconnect so the server receives
    // the name as the first frame. Do a controlled disconnect/connect to avoid
    // triggering automatic rejoin.
    if (this.wsManager.isConnected()) {
      // Use the pause API to prevent automatic rejoin while we intentionally
      // close and reopen the socket.
      try { this.wsManager.pauseAutoReconnect(); } catch (e) {}

      // Reconnect to update the name; the signed cookie preserves guest identity.
      this.wsManager.disconnect();
      this.joinRoom(this.roomname);

      // Resume normal auto-reconnect behavior (connect() also enables it but
      // call resume to be explicit for implementations that check the flag).
      try { this.wsManager.resumeAutoReconnect(); } catch (e) {}
    }

    // Notify listeners that local username changed
    this.eventBus.emit('user:set', { username, oldUsername });
  }

  /**
   * 创建私人房间
   * @returns {Promise<string>} 房间名称
   * @throws {Error} 创建失败时抛出错误
   * @fires error
   */
  async createPrivateRoom() {
    try {
      const response = await this.fetch("https://" + this.hostname + "/api/room", {method: "POST"});
      if (!response.ok) {
        throw new Error("Failed to create private room");
      }
      return await response.text();
    } catch (error) {
      this.eventBus.emit('error', { message: 'Failed to create private room', error });
      throw error;
    }
  }

  /**
   * 加入房间
   * @param {string} roomname - 房间名称
   * @returns {boolean} 是否成功加入
   * @fires room:joining
   * @fires error
   */
  joinRoom(roomname) {
    // Normalize the room name
    this.roomname = roomname.replace(/[^a-zA-Z0-9_-]/g, "").replace(/_/g, "-").toLowerCase();
    this.resetVisibility();
    this.lastSeenTimestamp = 0;
    this.wroteWelcomeMessages = false;
    this.roster.clear();
    this.eventBus.emit('roster:clear');

    if (this.roomname.length > 32 && !this.roomname.match(/^[0-9a-f]{64}$/)) {
      this.eventBus.emit('error', { message: 'Invalid room name' });
      return false;
    }

    this.eventBus.emit('room:joining', { roomname: this.roomname });
    this.wsManager.connect(this.roomname, this.username);
    return true;
  }

  refreshAuthentication() {
    return this.wsManager.refreshAuthentication();
  }

  publishVisibility(change) {
    Object.assign(this.visibilityState, change);
    this.eventBus.emit('room:visibility', { ...this.visibilityState });
  }

  resetVisibility(reason = 'connecting') {
    if (this._visibilityTimer) clearTimeout(this._visibilityTimer);
    this._visibilityTimer = null;
    this._visibilityRequestId = null;
    this._visibilitySynced = false;
    this.publishVisibility({ visibility: null, pending: null, available: false, reason, error: '' });
  }

  setVisibility(visibility) {
    if (!['online', 'offline', 'hidden'].includes(visibility) || !this.visibilityState.available
        || this.visibilityState.pending || !this.wsManager.isConnected()) return false;
    const requestId = `visibility-${this._visibilitySequence = (this._visibilitySequence || 0) + 1}`;
    this._visibilityRequestId = requestId;
    this.publishVisibility({ pending: visibility, error: '' });
    if (!this.wsManager.send({ type: 'room:visibility', visibility, requestId })) {
      this._visibilityRequestId = null;
      this.publishVisibility({ pending: null, error: '暂时无法发送设置，请等待连接恢复后重试。' });
      return false;
    }
    this._visibilityTimer = setTimeout(() => {
      this._visibilityTimer = null;
      this.publishVisibility({ pending: null, available: false, error: '未收到保存确认，请重新连接后核对显示状态。' });
    }, 10000);
    return true;
  }

  /**
   * 发送消息
   * @param {string} message - 消息内容
   * @returns {boolean} 是否成功发送
   * @fires message:sent
   */
  sendMessage(message) {
    if (typeof message !== 'string' || !message.trim() || message.length > 256) {
      this.eventBus.emit('message:error', { error: '消息不能为空或超过 256 字符。' });
      return false;
    }
    if (this.wsManager.send({ message })) {
      this.eventBus.emit('message:sent', { message });
      return true;
    }
    return false;
  }

  /**
   * 处理连接打开事件
   * @private
   * @fires connection:open
   */
  handleConnectionOpen() {
    this.eventBus.emit('connection:open', { roomname: this.roomname });
  }

  /**
   * 处理连接关闭事件
   * @private
   * @fires connection:close
   */
  handleConnectionClose() {
    this.resetVisibility('disconnected');
    this.eventBus.emit('connection:close', { roomname: this.roomname });
  }

  /**
   * 处理连接错误事件
   * @private
   * @param {Error} error - 错误对象
   * @fires connection:error
   */
  handleConnectionError(error) {
    this.eventBus.emit('connection:error', { error });
  }

  /**
   * 处理重连事件
   * @private
   * @fires roster:clear
   */
  handleReconnect() {
    this.resetVisibility();
    this.roster.clear();
    this.eventBus.emit('roster:clear');
  }

  /**
   * 处理收到的消息
   * @private
   * @param {Object} data - 消息数据
   * @fires message:error
   * @fires user:joined
   * @fires user:quit
   * @fires room:ready
   * @fires message:received
   */
  handleMessage(data) {
    if (data.type === 'room:visibility') {
      if (data.error) {
        if (data.requestId !== this._visibilityRequestId) return;
      } else if (data.userId !== this.currentUser?.id || !['online', 'offline', 'hidden'].includes(data.visibility)) return;
      // Other tabs update the confirmed value but cannot acknowledge this tab's pending request.
      if (data.requestId && data.requestId === this._visibilityRequestId) {
        if (this._visibilityTimer) clearTimeout(this._visibilityTimer);
        this._visibilityTimer = null;
        this._visibilityRequestId = null;
        this.publishVisibility({ pending: null, error: data.error || '', ...(data.error ? {} : { visibility: data.visibility, available: this._visibilitySynced }) });
      } else if (!data.error) this.publishVisibility({ visibility: data.visibility });
      return;
    }
    if (data.type === 'room:members') {
      this.eventBus.emit('room:members', { users: data.users });
      return;
    }
    if (data.type === 'voice:ticket' || data.type === 'voice:state') {
      this.eventBus.emit(data.type, data);
      return;
    }
    if (data.type === 'session') {
      if (this.currentUser && this.currentUser.id !== data.user.id) {
        const synced = this._visibilitySynced;
        this.resetVisibility();
        this._visibilitySynced = synced;
      }
      this.currentUser = data.user;
      this.username = data.user.displayName;
      this.wsManager.username = this.username;
      this.eventBus.emit('session:updated', { user: data.user, visibility: data.visibility });
      this.publishVisibility({ visibility: ['online', 'offline', 'hidden'].includes(data.visibility) ? data.visibility : null,
        available: this._visibilitySynced && ['online', 'offline', 'hidden'].includes(data.visibility),
        reason: ['online', 'offline', 'hidden'].includes(data.visibility) ? '' : 'unsupported' });
    } else if (data.type === 'profile') {
      if (this.roster.has(data.user.id)) this.roster.set(data.user.id, data.user);
      this.eventBus.emit('user:profile', { user: data.user });
    } else if (data.error) {
      this.eventBus.emit('message:error', { error: data.error });
    } else if (data.joined) {
      this.roster.set(data.user?.id || data.joined, data.user || { displayName: data.joined });
      this.eventBus.emit('user:joined', { username: data.joined, user: data.user, silent: data.silent === true });
    } else if (data.quit) {
      this.roster.delete(data.userId || data.quit);
      this.eventBus.emit('user:quit', { username: data.quit, userId: data.userId, silent: data.silent === true });
    } else if (data.ready) {
      this._visibilitySynced = true;
      this.publishVisibility({ available: this.visibilityState.visibility !== null });
      this.eventBus.emit('room:synced', { roomname: this.roomname });
      if (!this.wroteWelcomeMessages) {
        this.wroteWelcomeMessages = true;
        this.eventBus.emit('room:ready', { 
          roomname: this.roomname,
          isPrivate: this.roomname.length === 64
        });
      }
    } else if (data.timestamp > this.lastSeenTimestamp) {
      this.lastSeenTimestamp = data.timestamp;

      // 检测是否是 Nako AI 消息
      let message = data.message;
      let isNakoMessage = false;
      let senderName = data.name;

      // 检测 AI 人设标记（如 [Nako], [Asagi] 等）
      // 使用统一配置获取 AI 人设列表
      const aiPersonas = this.aiConfig.getAllDisplayNames();
      let aiPersona = null;

      for (const persona of aiPersonas) {
        if (message.startsWith(`[${persona}]`)) {
          isNakoMessage = true;
          aiPersona = persona;
          message = message.slice(persona.length + 2); // 去掉 [Persona] 前缀
          senderName = persona; // AI 消息的发送者应该是 AI 本身，而不是转发者
          break;
        }
      }

      // 语C角色消息（[角色:名字]正文）：与 AI 转发共用「由……转发」显示，
      // 但不是 AI，因此不参与 Nako 的预览确认与上下文逻辑。AI 前缀优先。
      let isRoleplayMessage = false;
      if (!isNakoMessage) {
        const role = this.roleplay?.decode(message, this.roomname);
        if (role) {
          isRoleplayMessage = true;
          message = role.text;
          senderName = role.name;
        }
      }
      const forwarded = isNakoMessage || isRoleplayMessage;

      this.eventBus.emit('message:received', {
        name: senderName,
        message: message,
        timestamp: data.timestamp,
        user: forwarded ? null : data.user,
        sender: forwarded ? data.user : null,
        isNako: isNakoMessage,
        isRoleplay: isRoleplayMessage
      });
    }
  }

  /**
   * 离开房间
   * @fires room:left
   */
  leave() {
    this.resetVisibility('disconnected');
    this.wsManager.disconnect();
    this.roster.clear();
    this.wroteWelcomeMessages = false;
    this.eventBus.emit('room:left', { roomname: this.roomname });
  }

  /**
   * 获取房间成员列表
   * @returns {string[]} 成员用户名数组
   */
  getRoster() {
    return Array.from(this.roster.values()).map(user => user.displayName);
  }

  /**
   * 获取当前房间信息
   * @returns {Object} 房间信息对象
   */
  getRoomInfo() {
    return {
      username: this.username,
      roomname: this.roomname,
      memberCount: this.roster.size,
      members: this.getRoster(),
      connected: this.wsManager.isConnected()
    };
  }

  /**
   * 检查是否已连接
   * @returns {boolean} 是否已连接
   */
  isConnected() {
    return this.wsManager.isConnected();
  }
}
