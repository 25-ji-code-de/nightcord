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
    
    let storedName = localStorage.getItem('nightcord-username');
    if (!storedName) {
      storedName = window.prompt("请输入用户名：");
      localStorage.setItem('nightcord-username', storedName);
    }
    this.chatRoom.setUser(storedName);
    this.joinRoom(roomname || 'nightcord-default');
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
   * 销毁应用实例
   */
  destroy() {
    this.chatRoom.leave();
    this.eventBus.clear();
  }
}
