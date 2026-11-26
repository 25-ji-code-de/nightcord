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

class Nightcord {
  get identity() { return this._identity ||= new IdentityController(this); }
  createAIConversation() {
    return new AIConversation({
      eventBus: this.eventBus,
      loadMessages: room => this.ui.storage?.loadMessages(room) || [],
      aiConfig: window.AIConfig,
      getUser: () => this.chatRoom.currentUser,
      getUsername: () => this.chatRoom.username,
      getRoom: () => this.chatRoom.roomname,
      ask: (prompt, options) => this.nakoService.ask(prompt, options),
      send: message => this.chatRoom.sendMessage(message),
      settings: {
        getItem: key => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value)
      }
    });
  }
  get nakoClearTimestamp() { return this.ai.clearTimestamp; }
  set nakoClearTimestamp(value) { this.ai.clearTimestamp = value; }

  /** @param {Object} config - 服务器和 AI 服务配置 */
  constructor(config = {}) {
    this.eventBus = new EventBus();
    this.chatRoom = new NightcordManager({
      hostname: config.hostname,
      getAccessToken: () => this.identity.getAccessToken(),
      eventBus: this.eventBus,
      aiConfig: window.AIConfig
    });
    this.ui = new UIManager(this.eventBus);
    this.eventBus.on('room:visibility:set', ({ visibility }) => {
      if (this.ui.managedChat) void this.rooms.setVisibility(visibility);
      else this.chatRoom.setVisibility(visibility);
    });
    this.commands = new MessageCommands({
      eventBus: this.eventBus,
      send: message => this.chatRoom.sendMessage(message),
      aiConfig: window.AIConfig,
      mentions: this.ui.mentions,
      spacing: text => typeof pangu !== 'undefined' ? pangu.spacingText(text) : text,
      typeSource: SekaiRenderer.V2_TYPE_SOURCE
    });
    this.sidebarFeatures = new SidebarFeatures(this.ui);
    this.ui.sidebarFeatures = this.sidebarFeatures;
    this.directMessages = new DirectMessageManager({
      eventBus: this.eventBus, hostname: config.hostname,
      getAccessToken: () => this.identity.getAccessToken()
    });
    this.directMessageView = new DirectMessageView(this.ui, this.directMessages);
    this.ui.directMessages = this.directMessages;
    this.ui.directMessageView = this.directMessageView;
    this.rooms = new RoomManager({ eventBus: this.eventBus, hostname: config.hostname, getAccessToken: () => this.identity.getAccessToken() });
    this.roomsView = new RoomsView(this.ui, this.rooms, { enter: () => this.chatRoom.leave(), official: id => this.joinRoom(id || 'nightcord-default') });
    this.voice = new VoiceManager({ eventBus: this.eventBus, chatRoom: this.chatRoom });
    this.voiceUI = new VoiceUI(this.voice, this.eventBus);

    this.identity.setup();

    // 大文件上传（> 512 MiB）需 SEKAI Pass token。给上传服务注入与 Nako 同形的
    // provider：未登录或取 token 失败时返回 null，绝不向上抛。
    if (this.ui && this.ui.fileUploadService &&
        typeof this.ui.fileUploadService.setGetAccessToken === 'function') {
      this.ui.fileUploadService.setGetAccessToken(async () => {
        if (this.sekaiPassAuth.isAuthenticated()) {
          try {
            return await this.sekaiPassAuth.getAccessToken();
          } catch (error) {
            console.warn('Failed to get access token for upload:', error);
            return null;
          }
        }
        return null;
      });
    }

    // 初始化 Nako AI 服务
    this.nakoService = new NakoAIService({
      eventBus: this.eventBus,
      apiUrl: config.nakoApiUrl || 'https://nako.nightcord.de5.net/api/chat',
      nakoName: config.nakoName || 'Nako',
      stream: false, // 禁用流式输出
      getAccessToken: async () => {
        // 如果用户已登录 SEKAI Pass，返回 access token
        if (this.sekaiPassAuth.isAuthenticated()) {
          try {
            return await this.sekaiPassAuth.getAccessToken();
          } catch (error) {
            console.warn('Failed to get access token for Nako:', error);
            return null;
          }
        }
        return null;
      }
    });

    // Instantiate the event-driven AI workflow after its service and UI.
    this.ai = this.createAIConversation();
    this.analytics = null;

    this.voiceSounds = new VoiceSounds(this.eventBus, () => this.ui.alerts.preferences.read());
    this.sounds = this.voiceSounds.sounds;

    // Application state
    this.state = {
      phase: 'name-choosing' // name-choosing, chatting
    };
  }

  init(...args) { return this.identity.init(...args); }

  handleOAuthCallback(...args) { return this.identity.handleOAuthCallback(...args); }

  /**
   * 加入聊天室
   * @param {string} roomname - 房间名称
   */
  joinRoom(roomname) {
    if (this.ui.managedChat) this.roomsView.close();
    this.state.phase = 'chatting';
    // this.ui.hideRoomChooser();

    const success = this.chatRoom.joinRoom(roomname);
    if (success) {
      this.ui.setCurrentRoom(this.chatRoom.roomname);
      this.ui.setupChatRoom((message) => {
        return this.commands.submit(message);
      }, (username) => {
        this.chatRoom.setUser(username);
      });
    }
  }

  broadcastIdentityChange(...args) { return this.identity.broadcastIdentityChange(...args); }

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

  getRecentHistory(...args) { return this.ai.getRecentHistory(...args); }

  /**
   * 获取 Nako AI 服务实例（用于外部扩展）
   * @returns {NakoAIService} Nako AI 服务
   */
  getNakoService() {
    return this.nakoService;
  }

  loadNakoClearTimestamp(...args) { return this.ai.loadNakoClearTimestamp(...args); }

  saveNakoClearTimestamp(...args) { return this.ai.saveNakoClearTimestamp(...args); }

  /**
   * 销毁应用实例
   */
  destroy() {
    this.directMessageView.destroy();
    this.roomsView.destroy(); this.rooms.destroy();
    this.directMessages.destroy();
    this.identity.destroy();
    this.voiceSounds.destroy();
    this.ui.alerts.destroy();
    this.voice.destroy();
    this.voiceUI.destroy();
    // 停止事件上报
    if (this.analytics) {
      this.analytics.stopOnlineTracking();
    }

    this.nakoService.cancelAll();
    this.chatRoom.leave();
    this.eventBus.clear();
  }
}
