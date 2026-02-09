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
    this.hostname = config.hostname || "edge-chat-demo.cloudflareworkers.com";
    this.eventBus = config.eventBus || new EventBus();
    this.username = null;
    this.roomname = null;
    this.lastSeenTimestamp = 0;
    this.wroteWelcomeMessages = false;
    this.roster = new Set();
    
    this.wsManager = new WebSocketManager({
      hostname: this.hostname,
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

    // Persist chosen username locally so UI can read it
    try { localStorage.setItem('nightcord-username', username); } catch (e) {}

    // Some servers only honor the name when it's the first message after opening
    // the websocket. If that's the case, we must reconnect so the server receives
    // the name as the first frame. Do a controlled disconnect/connect to avoid
    // triggering automatic rejoin.
    if (this.wsManager.isConnected()) {
      // Use the pause API to prevent automatic rejoin while we intentionally
      // close and reopen the socket.
      try { this.wsManager.pauseAutoReconnect(); } catch (e) {}

      // Emit a rename event so the UI can replace the username smoothly
      // without clearing/rebuilding the entire roster.
      this.eventBus.emit('user:rename', { oldUsername, newUsername: username });

      // Close current socket and then reconnect with the new username. We do
      // NOT clear the local roster or wroteWelcomeMessages here to avoid
      // triggering welcome messages on a simple rename; UI will update on
      // server-sent join/quit events as they arrive.
      this.wsManager.disconnect();
      this.wsManager.connect(this.roomname, username);

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
      const response = await fetch("https://" + this.hostname + "/api/room", {method: "POST"});
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

    if (this.roomname.length > 32 && !this.roomname.match(/^[0-9a-f]{64}$/)) {
      this.eventBus.emit('error', { message: 'Invalid room name' });
      return false;
    }

    this.eventBus.emit('room:joining', { roomname: this.roomname });
    this.wsManager.connect(this.roomname, this.username);
    return true;
  }

  /**
   * 发送消息
   * @param {string} message - 消息内容
   * @returns {boolean} 是否成功发送
   * @fires message:sent
   */
  sendMessage(message) {
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
    if (data.error) {
      this.eventBus.emit('message:error', { error: data.error });
    } else if (data.joined) {
      this.roster.add(data.joined);
      this.eventBus.emit('user:joined', { username: data.joined });
    } else if (data.quit) {
      this.roster.delete(data.quit);
      this.eventBus.emit('user:quit', { username: data.quit });
    } else if (data.ready) {
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

      if (message.startsWith('[Nako]')) {
        isNakoMessage = true;
        message = message.slice(6); // 去掉 [Nako] 前缀
        senderName = 'Nako'; // Nako 消息的发送者应该是 Nako，而不是转发者
      }

      this.eventBus.emit('message:received', {
        name: senderName,
        message: message,
        timestamp: data.timestamp,
        isNako: isNakoMessage
      });
    }
  }

  /**
   * 离开房间
   * @fires room:left
   */
  leave() {
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
    return Array.from(this.roster);
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
