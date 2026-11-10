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
  /**
   * 创建 Nightcord 实例
   * @param {Object} config - 配置对象
   * @param {string} [config.hostname] - 服务器主机名
   */
  constructor(config = {}) {
    this.eventBus = new EventBus();
    this.chatRoom = new NightcordManager({
      hostname: config.hostname,
      getAccessToken: async () => this.sekaiPassAuth.isAuthenticated() ? this.sekaiPassAuth.getAccessToken() : null,
      eventBus: this.eventBus
    });
    this.ui = new UIManager(this.eventBus);
    this.voice = new VoiceManager({ eventBus: this.eventBus, chatRoom: this.chatRoom });
    this.voiceUI = new VoiceUI(this.voice, this.eventBus);

    // 初始化 SEKAI Pass OAuth 客户端（需要在 Nako 之前初始化）
    const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    this.sekaiPassAuth = new SekaiPassAuth({
      clientId: 'nightcord_client',
      redirectUri: isLocalDev ? window.location.origin : `${window.location.origin}/auth/callback`,
      onAuthExpired: () => {
        console.log('授权已过期，正在重新登录...');
        setTimeout(() => {
          this.sekaiPassAuth.login();
        }, 1000);
      }
    });
    this.ui.sekaiPassLoginCallback = () => this.sekaiPassAuth.login();
    this.ui.onRefreshProfile = () => this.chatRoom.wsManager.refreshAuthentication();
    this.ui.onLogout = async () => {
      this.chatRoom.leave();
      this.ui.setSessionUnavailable();
      await this.sekaiPassAuth.logout();
      this.broadcastIdentityChange();
      this.restoreGuest();
    };
    window.addEventListener('storage', (event) => {
      if (event.key === 'nightcord-identity-event') {
        this.chatRoom.leave();
        this.ui.setSessionUnavailable();
        if (this.sekaiPassAuth.isAuthenticated()) {
          const user = this.sekaiPassAuth.getCurrentUser();
          const name = user && (user.name || user.display_name || user.preferred_username || user.username || user.sub);
          if (name) {
            this.chatRoom.setUser(name);
            this.joinRoom(this.chatRoom.roomname || 'nightcord-default');
            return;
          }
        }
        this.restoreGuest();
      } else if (event.key === 'nightcord-guest-name' && event.newValue && !this.sekaiPassAuth.isAuthenticated()
        && this.chatRoom.currentUser && !this.chatRoom.currentUser.authenticated && this.chatRoom.username !== event.newValue) {
        this.chatRoom.setUser(event.newValue);
      }
    });
    this.eventBus.on('guest:required', ({ error }) => {
      this.ui.showError(error.message);
      this.ui.setSessionUnavailable();
    });
    this.eventBus.on('auth:required', () => {
      this.ui.showError('SEKAI Pass 登录已失效，请重新登录。');
      this.ui.setSessionUnavailable();
    });

    this.restoreGuest = () => {
      this.chatRoom.currentUser = null;
      this.ui.currentUser = null;
      let guestName;
      try { guestName = localStorage.getItem('nightcord-guest-name'); } catch (e) {}
      if (guestName) {
        this.chatRoom.setUser(guestName);
        this.joinRoom(this.chatRoom.roomname || 'nightcord-default');
        return;
      }
      this.ui.showNameChooser({ mode: 'init' }, (username) => {
        this.chatRoom.setUser(username);
        this.joinRoom(this.chatRoom.roomname || 'nightcord-default');
      }, this.ui.sekaiPassLoginCallback);
    };

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

    // Nako 上下文清除时间戳（只获取此时间戳之后的消息）
    // 从 localStorage 读取持久化的时间戳
    this.nakoClearTimestamp = this.loadNakoClearTimestamp();

    // 初始化 SEKAI Analytics（事件上报服务）
    // 注意：sekaiPassAuth 会在 init() 中初始化，这里先设为 null
    this.analytics = null;

    // 监听 Nako 清除上下文请求
    this.eventBus.on('nako:clear', () => {
      this.nakoClearTimestamp = Date.now();
      this.saveNakoClearTimestamp(this.nakoClearTimestamp);
    });

    // 监听 AI 调用请求（支持多人设）
    this.eventBus.on('nako:ask', (data) => {
      // 获取当前用户名
      const userId = this.chatRoom.username || 'Anonymous';

      // 获取对话历史（最近 15 条消息，只获取清除时间戳之后的）
      const history = this.getRecentHistory(15);

      // 调用 AI（传递 persona 参数）
      this.nakoService.ask(data.prompt, {
        userId: userId,
        history: history,
        persona: data.persona || 'nako' // 默认使用 nako
      });
    });

    // 语音聊天加入、退出音效（优先 Opus，回退 MP3）
    const canOpus = new Audio().canPlayType('audio/ogg; codecs=opus');
    const ext = canOpus ? 'opus' : 'mp3';
    this.sounds = {
      join: new Audio(`se_cord.${ext}?v=2`),
      quit: new Audio(`se_dcord.${ext}?v=2`)
    };
    const playSound = name => this.sounds[name].cloneNode().play().catch(() => {});
    // voiceJoined：本地上一次是否处于语音通话中，用于判断“刚加入”或“刚退出”。
    let voiceJoined = false;
    let voiceMembers = new Set();
    this.eventBus.on('voice:changed', ({ joined, members }) => {
      // joined：这次事件上报时，本地当前是否处于语音通话中。
      const memberIds = new Set(members.map(member => member.memberId));
      // joined 与 voiceJoined 不同时，说明状态刚刚发生了加入/退出变化。
      if (joined !== voiceJoined) {
        playSound(joined ? 'join' : 'quit');
      } else if (joined) {
        // 仅在通话中提示成员进出，重复快照和麦克风状态更新保持安静。
        if ([...memberIds].some(id => !voiceMembers.has(id))) playSound('join');
        if ([...voiceMembers].some(id => !memberIds.has(id))) playSound('quit');
      }
      voiceJoined = joined;
      voiceMembers = memberIds;
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

    // 初始化 SEKAI Analytics（事件上报服务）
    this.analytics = new SekaiAnalytics({
      apiUrl: 'https://api.nightcord.de5.net',
      eventBus: this.eventBus,
      sekaiPassAuth: this.sekaiPassAuth
    });

    // 检查是否是 OAuth 回调（通过 URL 参数判断）
    const urlParams = new URLSearchParams(window.location.search);
    if ((urlParams.has('code') && urlParams.has('state')) || urlParams.has('error')) {
      this.handleOAuthCallback(roomname);
      return;
    }

    // 检查是否已通过 SEKAI Pass 登录
    if (this.sekaiPassAuth.isAuthenticated()) {
      const user = this.sekaiPassAuth.getCurrentUser();
      // 优先使用 name，其次 preferred_username，最后 sub
      const username = user && (user.name || user.display_name || user.preferred_username || user.username || user.sub);
      if (user && username) {
        this.chatRoom.setUser(username);
        this.joinRoom(roomname || 'nightcord-default');
        return;
      }
    }

    // 尝试从 localStorage 获取已保存的用户名（降级方案）
    const storedName = localStorage.getItem('nightcord-guest-name') || localStorage.getItem('nightcord-username');

    if (storedName) {
      // 如果已有用户名，直接加入房间
      this.chatRoom.setUser(storedName);
      // 保存 SEKAI Pass 回调，改昵称时可用
      this.ui.sekaiPassLoginCallback = () => this.sekaiPassAuth.login();
      this.joinRoom(roomname || 'nightcord-default');
    } else {
      // 如果没有用户名，设置用户名选择器
      this.ui.setupNameChooser((username) => {
        this.chatRoom.setUser(username);
        this.joinRoom(roomname || 'nightcord-default');
      }, () => {
        // SEKAI Pass 登录回调
        this.sekaiPassAuth.login();
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
      const userInfo = await this.sekaiPassAuth.handleCallback();

      // 优先使用 name，其次 preferred_username，最后 sub
      const username = userInfo.name || userInfo.display_name || userInfo.preferred_username || userInfo.username || userInfo.sub;

      // 使用 SEKAI Pass 的用户名
      this.chatRoom.setUser(username);
      this.broadcastIdentityChange();

      // 清理 URL（移除查询参数）
      window.history.replaceState({}, document.title, returnPath);

      // 加入房间
      this.joinRoom(roomname || 'nightcord-default');
    } catch (error) {
      // 把 SDK / 适配层抛出的原始异常翻译成带错误码的可读描述。
      // describeAuthError 始终保留 sourceCode 与 originalMessage，控制台不丢信息。
      const descriptor = window.describeAuthError(error);
      console.error('[Nightcord Auth]', descriptor, error);
      this.ui.showAuthError(descriptor, {
        onRetry: () => this.sekaiPassAuth.login(),
      });

      // 清理 URL 并回到名称选择
      window.history.replaceState({}, document.title, returnPath);
      this.init(roomname);
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
        return this.chatRoom.sendMessage(message);
      }, (username) => {
        this.chatRoom.setUser(username);
      });
    }
  }

  broadcastIdentityChange() {
    // A notification only: each tab obtains credentials and the server verifies them.
    try { localStorage.setItem('nightcord-identity-event', JSON.stringify({ at: Date.now(), nonce: crypto.randomUUID() })); } catch (e) {}
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
        isBot: window.AIConfig.getAllDisplayNames().includes(msg.user)
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
