class Nightcord {
  /**
   * 创建 Nightcord 实例
   * @param {Object} config - 配置对象
   * @param {string} [config.hostname] - 服务器主机名
   */
  constructor(config = {}) {
    this.eventBus = new EventBus();
    this.chatRoom = new NightcordManager({
      hostname: config.hostname,
      eventBus: this.eventBus
    });
    this.ui = new UIManager(this.eventBus);

    // 初始化 Nako AI 服务
    this.nakoService = new NakoAIService({
      eventBus: this.eventBus,
      apiUrl: config.nakoApiUrl || 'https://nako.nightcord.de5.net/api/chat',
      nakoName: config.nakoName || 'Nako',
      stream: config.nakoStream !== false // 默认启用流式
    });

    // Nako 上下文清除时间戳（只获取此时间戳之后的消息）
    // 从 localStorage 读取持久化的时间戳
    this.nakoClearTimestamp = this.loadNakoClearTimestamp();

    // 监听 Nako 清除上下文请求
    this.eventBus.on('nako:clear', () => {
      this.nakoClearTimestamp = Date.now();
      this.saveNakoClearTimestamp(this.nakoClearTimestamp);
    });

    // 监听 Nako 调用请求
    this.eventBus.on('nako:ask', (data) => {
      // 获取当前用户名
      const userId = this.chatRoom.username || 'Anonymous';

      // 获取对话历史（最近 15 条消息，只获取清除时间戳之后的）
      const history = this.getRecentHistory(15);

      // 调用 Nako
      this.nakoService.ask(data.prompt, {
        userId: userId,
        history: history
      });
    });

    // Application state
    this.state = {
      phase: 'name-choosing' // name-choosing, chatting
    };
  }

  /**
   * 初始化应用
   */
  init(roomname) {
    this.state.phase = 'name-choosing';
    
    // 尝试从 localStorage 获取已保存的用户名
    const storedName = localStorage.getItem('nightcord-username');
    
    if (storedName) {
      // 如果已有用户名，直接加入房间
      this.chatRoom.setUser(storedName);
      this.joinRoom(roomname || 'nightcord-default');
    } else {
      // 如果没有用户名，设置用户名选择器
      this.ui.setupNameChooser((username) => {
        this.chatRoom.setUser(username);
        this.joinRoom(roomname || 'nightcord-default');
      });
    }
  }

  /**
   * 加入聊天室
   * @param {string} roomname - 房间名称
   */
  joinRoom(roomname) {
    this.state.phase = 'chatting';
    // this.ui.hideRoomChooser();
    
    const success = this.chatRoom.joinRoom(roomname);
    if (success) {
      this.ui.setCurrentRoom(this.chatRoom.roomname);
      this.ui.setupChatRoom((message) => {
        this.chatRoom.sendMessage(message);
      }, (username) => {
        this.chatRoom.setUser(username);
      });
    }
  }

  /**
   * 离开聊天室
   */
  leaveRoom() {
    this.chatRoom.leave();
    this.state.phase = 'room-choosing';
  }

  /**
   * 获取当前应用状态
   * @returns {Object} 状态对象
   * @property {string} phase - 当前阶段
   * @property {string} username - 当前用户名
   * @property {string} roomname - 当前房间名
   * @property {string[]} roster - 房间成员列表
   */
  getState() {
    return {
      ...this.state,
      username: this.chatRoom.username,
      roomname: this.chatRoom.roomname,
      roster: this.chatRoom.getRoster()
    };
  }

  /**
   * 获取事件总线实例（用于外部扩展）
   * @returns {EventBus} 事件总线
   */
  getEventBus() {
    return this.eventBus;
  }

  /**
   * 获取聊天室管理器实例（用于外部扩展）
   * @returns {NightcordManager} 聊天室管理器
   */
  getChatRoomManager() {
    return this.chatRoom;
  }

  /**
   * 获取 UI 管理器实例（用于外部扩展）
   * @returns {UIManager} UI 管理器
   */
  getUIManager() {
    return this.ui;
  }

  /**
   * 获取最近的对话历史
   * @param {number} limit - 最多返回多少条
   * @returns {Array} 历史消息数组
   */
  getRecentHistory(limit = 10) {
    const messages = this.ui.messages || [];

    // 获取最近的消息，排除系统消息
    // 如果设置了清除时间戳，只获取该时间戳之后的消息
    const recentMessages = messages
      .filter(msg => msg.user !== '系统')
      .filter(msg => msg.timestamp > this.nakoClearTimestamp)
      .slice(-limit)
      .map(msg => ({
        userId: msg.user,
        message: msg.text,
        isBot: msg.user === 'Nako'
      }));

    return recentMessages;
  }

  /**
   * 获取 Nako AI 服务实例（用于外部扩展）
   * @returns {NakoAIService} Nako AI 服务
   */
  getNakoService() {
    return this.nakoService;
  }

  /**
   * 从 localStorage 加载 Nako 清除时间戳
   * @returns {number} 时间戳
   */
  loadNakoClearTimestamp() {
    try {
      const timestamp = localStorage.getItem('nightcord-nako-clear-timestamp');
      return timestamp ? Number(timestamp) : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 保存 Nako 清除时间戳到 localStorage
   * @param {number} timestamp - 时间戳
   */
  saveNakoClearTimestamp(timestamp) {
    try {
      localStorage.setItem('nightcord-nako-clear-timestamp', String(timestamp));
    } catch (e) {
      console.warn('Failed to save Nako clear timestamp:', e);
    }
  }

  /**
   * 销毁应用实例
   */
  destroy() {
    this.nakoService.cancelAll();
    this.chatRoom.leave();
    this.eventBus.clear();
  }
}
