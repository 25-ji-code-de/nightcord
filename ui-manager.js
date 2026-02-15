/**
 * UIManager - UI 管理器
 * 负责处理所有用户界面相关的逻辑和 DOM 操作
 * 通过回调函数和事件总线与业务逻辑层通信
 *
 * @example
 * const eventBus = new EventBus();
 * const ui = new UIManager(eventBus);
 *
 * // 设置用户名选择器
 * ui.setupNameChooser((username) => {
 *   console.log('User chose name:', username);
 * });
 *
 * // 添加聊天消息
 * ui.addChatMessage('K', 'As always, at 25:00.');
 */
class UIManager {
  static MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
  static TWELVE_HOURS_MS = UIManager.MILLISECONDS_PER_DAY / 2;
  static STICKER_WIDTH_THRESHOLD = 180;

  /**
   * 简单节流函数，确保处理器每 wait 毫秒最多执行一次
   * @param {Function} fn 
   * @param {number} wait 
   * @returns {Function}
   */
  static throttle(fn, wait) {
    let lastTime = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastTime >= wait) {
        lastTime = now;
        fn.apply(this, args);
      }
    };
  }

  /**
   * 创建 UI 管理器实例
   * @param {EventBus} eventBus - 事件总线实例
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.isAtBottom = true;

    // 触摸和滚动检测
    this.lastUserActivityTime = Date.now(); // 最后一次用户活动时间（触摸、滚轮、滚动等），初始化为当前时间
    this.scrollThreshold = 150; // 距离底部超过此像素数认为在阅读历史消息
    this.interactionTimeWindow = 5000; // 5秒内有用户交互活动则不自动滚动

    // Nako AI 相关：跟踪本地显示的消息，用于去重
    this.localNakoMessages = new Map(); // fullContent -> { timestamp, messageId }

    // DOM elements
    this.elements = {
      main: document.querySelector(".main"),
      nameInput: document.querySelector("#name-input"),
      roomNameInput: document.querySelector("#room-name"),
      roomName: document.querySelector(".channel > span"),
      goPublicButton: document.querySelector("#go-public"),
      goPrivateButton: document.querySelector("#go-private"),
      chatroom: document.querySelector("#chatroom"),
      chatlog: document.querySelector("#messages"),
      chatInput: document.querySelector("#messageInput"),
      roster: document.querySelector("#voice-users"),
    };

    this.onSetUser = null;

    // 当前房间（由外部调用 setCurrentRoom / room:ready 设置）
    this.currentRoom = null;
    // 每条消息对象只保留 user/text/timestamp 存入 localStorage；渲染层会补充 avatar/color/time
    this.messages = [];
    this.lastMsgTimestamp = 0;
    this.roster = [];

    this.systemIcon = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13,10.69v2.72H10.23V10.69Zm3,0v2.69h2.69V10.72ZM23.29,12A11.31,11.31,0,1,1,12,.67,11.31,11.31,0,0,1,23.29,12Zm-.18.07a8.87,8.87,0,1,0-8.87,8.86A8.87,8.87,0,0,0,23.11,12.05Z" fill="white"></path></svg>`;

    // Storage manager (handles per-room keys and legacy migration)
    try {
      this.storage = new StorageManager();
    } catch (e) {
      // If StorageManager is not available for some reason, provide a fallback object
      console.warn('StorageManager not available, falling back to inline storage helpers');
      this.storage = null;
    }

    this.setupEventListeners();

    if (typeof StickerService !== 'undefined') {
      this.stickerService = new StickerService({
        stickerDir: this.stickerDir,
        widthThreshold: UIManager.STICKER_WIDTH_THRESHOLD
      });
      try {
        this.stickerService.loadAutocompleteData('https://api.nightcord.de5.net/sekai/stickers/autocomplete.json');
      } catch (error) {
        console.error('Failed to load sticker autocomplete data:', error);
        this.addChatMessage('系统', '无法加载贴纸数据，请稍后重试。', null, this.systemIcon, 'bg-red-600');
      }
    } else {
      console.warn('StickerService not available, sticker rendering/autocomplete disabled');
      this.stickerService = null;
    }

    if (typeof AutocompleteManager !== 'undefined') {
      this.autocomplete = new AutocompleteManager({
        input: this.elements.chatInput,
        list: document.querySelector('#mention-list'),
        atButton: document.querySelector('.input-btns button[title="@"]'),
        getAllUsers: () => this.getAllUsers(),
        getStickers: () => (this.stickerService ? this.stickerService.getStickers() : [])
      });
    } else {
      console.warn('AutocompleteManager not available, mention/sticker autocomplete disabled');
      this.autocomplete = null;
    }

    // 初始化 SEKAI Renderer
    if (typeof SekaiRenderer !== 'undefined') {
      this.sekaiRenderer = new SekaiRenderer({
        stickerService: this.stickerService,
        stickerDir: this.stickerDir,
        aiPersonas: window.AIConfig ? window.AIConfig.getAllDisplayNames() : [],
        imageWidthThreshold: 400
      });
    } else {
      console.warn('SekaiRenderer not available, falling back to basic text rendering');
      this.sekaiRenderer = null;
    }
  }

  /**
   * 设置事件监听器，订阅业务逻辑事件
   * @private
   */
  setupEventListeners() {
    // 设置移动端菜单
    this.setupMobileMenu();
    
    // Subscribe to chat room events
    this.eventBus.on('message:received', (data) => {
      // 只存储非系统消息
      if (data.name === '系统') return;

      // 如果是 Nako 消息，检查是否是本地刚发送的
      if (data.isNako) {
        const local = this.localNakoMessages.get(data.message);
        if (local) {
          // 这是本地刚显示过的 Nako 消息，忽略广播
          this.localNakoMessages.delete(data.message);
          return;
        }

        // 检查是否已经有本地流式消息元素（通过内容匹配）
        const existingLocalMsg = Array.from(this.elements.chatlog.querySelectorAll('[data-local-nako-message="true"]'))
          .find(el => {
            const textEl = el.querySelector('.message-text');
            return textEl && textEl.textContent.trim() === data.message.trim();
          });

        if (existingLocalMsg) {
          return;
        }
      }

      // 检查本地是否已存在该消息（通过时间戳和内容简单去重）
      const exists = this.messages.some(
        m => m.text === data.message && m.user === data.name && Math.abs(m.timestamp - data.timestamp) < 1000
      );
      if (!exists) {
        this.addChatMessage(data.name, data.message, data.timestamp);
      }
    });
    this.eventBus.on('message:error', (data) => this.showError(data.error));
    this.eventBus.on('message:sent', () => this.clearChatInput());
    this.eventBus.on('user:joined', (data) => this.addUserToRoster(data.username));
    this.eventBus.on('user:quit', (data) => this.removeUserFromRoster(data.username));
    this.eventBus.on('user:rename', (data) => this.handleUserRename(data.oldUsername, data.newUsername));
    this.eventBus.on('roster:clear', () => this.clearRoster());
    this.eventBus.on('room:ready', (data) => {
      // data.messages 为服务器返回的最新100条消息，格式应为 [{user, text, timestamp}, ...]
      const room = data.roomname || this.currentRoom || 'nightcord-default';
      this.currentRoom = room;
      let serverMsgs = Array.isArray(data.messages) ? data.messages : [];
      // 只保留非系统消息
      serverMsgs = serverMsgs.filter(m => m.user !== '系统');
      // 取本地消息中比服务器最早一条还早的部分
      let localMsgs = (this.storage ? this.storage.loadMessages(room) : this.loadLocalMessages(room)) || [];
      if (serverMsgs.length > 0 && localMsgs.length > 0) {
        const minServerTs = Math.min(...serverMsgs.map(m => m.timestamp));
        // 只取比服务器最早一条还早的本地消息
        localMsgs = localMsgs.filter(m => m.timestamp < minServerTs && m.user !== '系统');
      }
      // 合并：本地早期消息 + 服务器消息
      this.messages = [...localMsgs, ...serverMsgs].map(m => {
        // 兼容老数据
        const { user, text, timestamp } = m;
        const { name, avatar, color } = this.generateAvatar(user);
        return {
          user: name,
          avatar,
          color,
          time: timestamp ? this.formatDate(timestamp) : '',
          text,
          timestamp
        };
      });
      // 渲染
      this.renderMessages();
      // 记录最新消息时间戳 到 per-room lastmsg
      if (this.messages.length > 0) {
        const lastTs = this.messages[this.messages.length - 1].timestamp;
        if (this.storage) this.storage.setLastMsgTimestamp(room, lastTs); else this.setLastMsgTimestamp(room, lastTs);
      }
      // 欢迎消息
      this.showWelcomeMessages(data);
    });
    this.eventBus.on('error', (data) => this.showError(data.message));

    // Nako AI 事件监听
    this.setupNakoEventListeners();
  }

  /**
   * 设置 Nako AI 事件监听器
   * @private
   */
  setupNakoEventListeners() {
    // Nako 开始回复
    this.eventBus.on('nako:stream:start', (data) => {
      this.startStreamingMessage(data.messageId, data.user);
    });

    // Nako 流式片段
    this.eventBus.on('nako:stream:chunk', (data) => {
      this.appendStreamingContent(data.messageId, data.chunk);
    });

    // Nako 完成回复
    this.eventBus.on('nako:stream:end', (data) => {
      // 去掉开头和结尾的换行符
      const cleanContent = data.fullContent.trim();
      const reasoning = data.reasoning || ''; // 思考过程

      // 标记为本地已显示，用于去重
      this.localNakoMessages.set(cleanContent, {
        timestamp: Date.now(),
        messageId: data.messageId
      });

      // 完成流式显示
      this.finishStreamingMessage(data.messageId, data.user, cleanContent, reasoning);

      // 通过 WebSocket 发送给所有人（带人设标记，如 [Nako] 或 [Asagi]）
      if (this.onSendMessage) {
        this.onSendMessage(`[${data.user}]${cleanContent}`);
      }

      // 5秒后清理去重标记（防止内存泄漏）
      setTimeout(() => {
        this.localNakoMessages.delete(cleanContent);
      }, 5000);
    });

    // Nako 错误
    this.eventBus.on('nako:error', (data) => {
      this.showError(`Nako: ${data.error}`);

      // 移除流式消息
      if (data.messageId) {
        const msgDiv = this.elements.chatlog.querySelector(`[data-message-id="${data.messageId}"]`);
        if (msgDiv) msgDiv.remove();
      }
    });

    // Nako 取消
    this.eventBus.on('nako:cancelled', (data) => {
      // 移除流式消息
      if (data.messageId) {
        const msgDiv = this.elements.chatlog.querySelector(`[data-message-id="${data.messageId}"]`);
        if (msgDiv) msgDiv.remove();
      }
    });
  }

  /**
   * 初始化/显示用户名选择器
   * @param {Object} options -配置选项
   * @param {string} [options.mode='init'] - 模式: 'init' | 'change'
   * @param {string} [options.currentName=''] - 当前用户名（修改模式下使用）
   * @param {Function} callback - 成功时的回调函数 (username) => void
   */
  showNameChooser(options, callback, sekaiPassCallback) {
    const { mode = 'init', currentName = '' } = options;
    const { nameInput } = this.elements;
    const nameChooser = document.querySelector('#name-chooser');
    const nameSubmit = document.querySelector('#name-submit');
    const nameError = document.querySelector('#name-error');

    // Elements for dynamic text
    const titleEl = document.querySelector('#chooser-title');
    const subtitleEl = document.querySelector('#chooser-subtitle');
    const submitTextEl = document.querySelector('#chooser-submit-text');
    const closeBtn = document.querySelector('#chooser-close');

    if (!nameInput || !nameChooser) return;

    // Reset UI state
    nameInput.classList.remove('error');
    if (nameError) {
      nameError.classList.remove('visible');
      nameError.textContent = '';
    }

    // Configure UI based on mode
    if (mode === 'change') {
      titleEl.textContent = '修改昵称';
      subtitleEl.textContent = '想要换个新名字吗？';
      submitTextEl.textContent = '确认修改';
      closeBtn.classList.remove('hidden');
      nameInput.value = currentName;
    } else {
      titleEl.textContent = 'Nightcord';
      subtitleEl.textContent = '请输入你的昵称以加入';
      submitTextEl.textContent = '进入 Nightcord';
      closeBtn.classList.add('hidden');

      // Load saved username only in init mode
      try {
        const savedUsername = localStorage.getItem('nightcord-username');
        if (savedUsername) nameInput.value = savedUsername;
      } catch (e) {}
    }

    // Show Dialog
    nameChooser.classList.remove('hidden');
    // 移动设备上不自动聚焦，避免虚拟键盘自动弹出
    if (window.innerWidth > 768) {
      setTimeout(() => nameInput.focus(), 100);
    }

    // Save callback for the event handler
    this.pendingNameCallback = callback;
    this.pendingSekaiPassCallback = sekaiPassCallback;
    this.nameChooserMode = mode;

    // Bind events only once
    if (!this.nameChooserEventsBound) {
      this.bindNameChooserEvents();
      this.nameChooserEventsBound = true;
    }
  }

  bindNameChooserEvents() {
    const { nameInput } = this.elements;
    const nameChooser = document.querySelector('#name-chooser');
    const nameSubmit = document.querySelector('#name-submit');
    const nameError = document.querySelector('#name-error');
    const closeBtn = document.querySelector('#chooser-close');
    const sekaiPassLoginBtn = document.querySelector('#sekai-pass-login');

    const closeDialog = () => {
      nameChooser.classList.add('hidden');
      nameInput.blur();
    };

    const showInputError = (msg) => {
      if (nameError) {
        nameError.textContent = msg;
        nameError.classList.add('visible');
      }
      nameInput.classList.add('error');
      // Animation
      const content = document.querySelector('.name-chooser-content');
      if (content) {
        content.animate([
          { transform: 'translateX(0)' }, { transform: 'translateX(-10px)' },
          { transform: 'translateX(10px)' }, { transform: 'translateX(-10px)' },
          { transform: 'translateX(10px)' }, { transform: 'translateX(0)' }
        ], { duration: 400, easing: 'ease-in-out' });
      }
    };

    const clearInputError = () => {
      if (nameError) nameError.classList.remove('visible');
      nameInput.classList.remove('error');
    };

    const submit = () => {
      const username = nameInput.value.trim();
      const currentMode = this.nameChooserMode || 'init';

      if (!username) {
        showInputError('请输入昵称');
        if (window.innerWidth > 768) nameInput.focus();
        return;
      }

      if (username.length > 32) {
        showInputError('昵称太长了，请控制在 32 个字符以内');
        if (window.innerWidth > 768) nameInput.focus();
        return;
      }

      // Save to localStorage
      try {
        localStorage.setItem('nightcord-username', username);
      } catch (e) {
        console.warn('Failed to save username to localStorage:', e);
      }

      closeDialog();
      
      if (this.pendingNameCallback) {
        this.pendingNameCallback(username);
      }
    };

    // Events
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else {
        clearInputError();
      }
    });

    nameInput.addEventListener('input', clearInputError);

    if (nameSubmit) {
      nameSubmit.addEventListener('click', (e) => {
        e.preventDefault();
        submit();
      });
    }

    // SEKAI Pass 登录按钮
    if (sekaiPassLoginBtn) {
      sekaiPassLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.pendingSekaiPassCallback) {
          this.pendingSekaiPassCallback();
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeDialog();
      });
    }

    // Click outside to close (only in change mode)
    nameChooser.addEventListener('click', (e) => {
      if (this.nameChooserMode === 'change' && e.target === nameChooser) {
        closeDialog();
      }
    });
  }

  /**
   * 设置用户名选择器 (兼容旧接口，用于初始化)
   * @param {Function} callback - 用户名选择回调函数
   */
  setupNameChooser(callback, sekaiPassCallback) {
    // 持久保存 SEKAI Pass 回调，改昵称时也能用
    this.sekaiPassLoginCallback = sekaiPassCallback;
    this.showNameChooser({ mode: 'init' }, callback, sekaiPassCallback);
  }

  setCurrentRoom(roomname) {
    this.currentRoom = roomname;
    this.elements.roomName.textContent = roomname;
    // 切换到新房间时，尝试从本地存储加载消息并渲染（若随后有 room:ready 会被覆盖为合并后的消息）
    try {
      const local = (this.storage ? this.storage.loadMessages(this.currentRoom || 'nightcord-default') : this.loadLocalMessages(this.currentRoom || 'nightcord-default'));
      // transform similar to room:ready: ensure fields for rendering
      this.messages = (Array.isArray(local) ? local : []).map(m => {
        const { user, text, timestamp } = m;
        const { name, avatar, color } = this.generateAvatar(user);
        return {
          user: name,
          avatar,
          color,
          time: timestamp ? this.formatDate(timestamp) : '',
          text,
          timestamp
        };
      });
      this.lastMsgTimestamp = this.storage ? this.storage.getLastMsgTimestamp(this.currentRoom || 'nightcord-default') : this.getLastMsgTimestamp(this.currentRoom || 'nightcord-default');
      this.renderMessages();
    } catch (e) {
      // ignore
    }
  }

  // 如果 StorageManager 不可用，保留一组兼容的本地 helper（非常规情况）
  storageKeyMessages(room) { return `nightcord-messages:${room}`; }
  storageKeyLastMsg(room) { return `nightcord-lastmsg:${room}`; }
  loadLocalMessages(room) {
    try { return JSON.parse(localStorage.getItem(this.storageKeyMessages(room)) || '[]'); } catch (e) { return []; }
  }
  saveLocalMessages(room, msgs) {
    try { localStorage.setItem(this.storageKeyMessages(room), JSON.stringify(msgs)); } catch (e) {}
  }
  getLastMsgTimestamp(room) {
    try { return Number(localStorage.getItem(this.storageKeyLastMsg(room)) || 0); } catch (e) { return 0; }
  }
  setLastMsgTimestamp(room, ts) {
    try { localStorage.setItem(this.storageKeyLastMsg(room), String(ts)); } catch (e) {}
  }

  fnv1a(s) {
    if (typeof s !== 'string') throw new TypeError('Expected string');
    let h = 2166136261 >>> 0;
    s = 'nightcord:' + s;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h & 7;
  }

  generateAvatar(username) {
    const colors = ['bg-pink-500', 'bg-purple-400', 'bg-teal-400', 'bg-pink-400', 'bg-purple-600', 'bg-green-600', 'bg-red-600', 'bg-default'];
    const bucket = this.fnv1a(username);
    return {
      name: username,
      avatar: username[0].toUpperCase(),
      color: colors[bucket]
    };
  }

  /**
   * Sticker 相关配置与渲染
   */
  stickerDir = 'https://sticker.nightcord.de5.net/stickers';

  /**
   * 将文本进行 HTML 转义，防止 XSS。
   * @param {string} s
   * @returns {string}
   */
  escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  /**
   * 渲染语音用户列表
   */
  renderVoiceUsers() {
    this.elements.roster.innerHTML = '';
    // 获取当前用户名
    let currentName = null;
    try {
      currentName = localStorage.getItem('nightcord-username');
    } catch (e) {}
    this.roster.forEach(user => {
      const div = document.createElement('div');
      div.className = 'voice-user';
      div.innerHTML = `
          <div class="voice-user-info">
            <span class="avatar ${user.color}">${user.avatar}</span>
            <span style="font-size:14px;">${user.name}</span>
          </div>
        `;
      // 只有是自己才可点击
      if (user.name === currentName) {
        div.style.cursor = 'pointer';
        div.title = '点击修改你的昵称';
        div.addEventListener('click', () => {
          this.showNameChooser({ mode: 'change', currentName: user.name }, (newName) => {
            if (newName && newName !== user.name) {
              // localStorage set is handled in showNameChooser/submit
              // 通知业务逻辑层
              if (this.onSetUser) {
                this.onSetUser(newName);
              }
            }
          }, this.sekaiPassLoginCallback);
        });
      }
      this.elements.roster.appendChild(div);
    });
  }

  /**
   * 渲染消息列表
   */
  renderMessages() {
    this.elements.chatlog.innerHTML = '';
    this.messages.forEach(msg => {
      const msgDiv = this.createMessageElement(msg);
      this.elements.chatlog.appendChild(msgDiv);
    });

    // 智能滚动逻辑
    // 检查是否应该自动滚动到底部
    const shouldAutoScroll = this.shouldAutoScrollToBottom();
    if (shouldAutoScroll) {
      this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
    }
  }

  /**
   * 判断是否应该自动滚动到底部
   * 条件：
   * 1. 用户当前在底部附近 (距离底部 < scrollThreshold 像素)
   * 2. 或者用户最近没有触摸/滚动操作（超过指定时间窗口）
   * @returns {boolean}
   */
  shouldAutoScrollToBottom() {
    const timeSinceLastTouch = Date.now() - this.lastUserActivityTime;
    // 如果用户在底部附近，或者已经很久没有交互，就自动滚动
    return this.isAtBottom || timeSinceLastTouch > this.interactionTimeWindow;
  }

  /**
   * 开始流式消息
   * @param {string} messageId - 消息 ID
   * @param {string} user - 用户名
   */
  startStreamingMessage(messageId, user) {
    const messageData = this.createMessageData(user, '', Date.now());
    messageData.id = messageId;
    messageData.isStreaming = true;

    // 创建消息元素
    const msgDiv = this.createMessageElement(messageData);
    msgDiv.dataset.messageId = messageId;
    msgDiv.classList.add('streaming');

    // 添加到 DOM
    this.elements.chatlog.appendChild(msgDiv);

    // 智能滚动
    if (this.shouldAutoScrollToBottom()) {
      this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
    }

    return msgDiv;
  }

  /**
   * 追加流式内容
   * @param {string} messageId - 消息 ID
   * @param {string} chunk - 文本片段
   */
  appendStreamingContent(messageId, chunk) {
    const msgDiv = this.elements.chatlog.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgDiv) return;

    let textElement = msgDiv.querySelector('.message-text');

    // 如果还没有文本元素，创建一个
    if (!textElement) {
      textElement = document.createElement('p');
      textElement.className = 'message-text';
      const contentDiv = msgDiv.querySelector('.message-content');
      if (contentDiv) {
        contentDiv.appendChild(textElement);
      }
    }

    // 获取当前文本并追加
    const currentText = textElement.textContent + chunk;

    // 重新渲染（支持 SEKAI 富文本）
    textElement.innerHTML = '';
    if (this.sekaiRenderer) {
      textElement.appendChild(this.sekaiRenderer.render(currentText));
    } else if (this.stickerService) {
      textElement.appendChild(this.stickerService.renderTextWithStickers(currentText));
    } else {
      textElement.textContent = currentText;
    }

    // 智能滚动
    if (this.shouldAutoScrollToBottom()) {
      this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
    }
  }

  /**
   * 完成流式消息
   * @param {string} messageId - 消息 ID
   * @param {string} user - 用户名
   * @param {string} fullContent - 完整内容
   * @param {string} reasoning - 思考过程
   */
  finishStreamingMessage(messageId, user, fullContent, reasoning = '') {
    // 移除流式标记，但保留消息元素
    const msgDiv = this.elements.chatlog.querySelector(`[data-message-id="${messageId}"]`);
    if (msgDiv) {
      delete msgDiv.dataset.messageId;
      msgDiv.classList.remove('streaming');

      // 标记这个消息元素，避免被 message:received 重复添加
      msgDiv.dataset.localNakoMessage = 'true';

      // 更新消息内容（去掉开头和结尾的空白）
      const textElement = msgDiv.querySelector('.message-text');
      if (textElement) {
        const cleanContent = fullContent.trim();
        textElement.innerHTML = '';
        if (this.sekaiRenderer) {
          textElement.appendChild(this.sekaiRenderer.render(cleanContent));
        } else if (this.stickerService) {
          textElement.appendChild(this.stickerService.renderTextWithStickers(cleanContent));
        } else {
          textElement.textContent = cleanContent;
        }
      }

      // 如果有思考过程，在昵称旁边添加思考图标（仅桌面端显示）
      if (reasoning && reasoning.trim()) {
        const headerDiv = msgDiv.querySelector('.message-header');
        if (headerDiv) {
          const thinkingIcon = document.createElement('span');
          thinkingIcon.className = 'nako-thinking-icon';
          thinkingIcon.textContent = '💭';
          thinkingIcon.title = reasoning.trim();
          headerDiv.appendChild(thinkingIcon);
        }
      }
    }

    // 保存到 messages 数组和 localStorage（使用清理后的内容）
    const cleanContent = fullContent.trim();
    const messageData = this.createMessageData(user, cleanContent, Date.now());
    this.messages.push(messageData);

    const msgObj = {
      user: user,
      text: cleanContent,
      timestamp: messageData.timestamp
    };
    this.saveMessageToStorage(msgObj);
  }

  /**
   * 设置聊天室界面
   * @param {Function} onSendMessage - 发送消息时的回调函数 (message) => void
   * @param {Function} onSetUser - 设置用户名时的回调函数 (username) => void
   */
  setupChatRoom(onSendMessage, onSetUser) {
    const { chatInput, chatlog } = this.elements;

    // 保存回调函数
    if (onSendMessage) {
      this.onSendMessage = onSendMessage;
    }
    if (onSetUser) {
      this.onSetUser = onSetUser;
    }

    // 监听滚动事件，检测用户是否接近底部
    chatlog.addEventListener("scroll", UIManager.throttle(() => {
      const distanceFromBottom = chatlog.scrollHeight - chatlog.scrollTop - chatlog.clientHeight;
      // 如果距离底部小于阈值，认为用户在底部附近
      this.isAtBottom = distanceFromBottom < this.scrollThreshold;
      this.updateUserActivityTime();
    }, 100).bind(this));

    // 监听触摸事件（移动端）
    chatlog.addEventListener("touchmove", UIManager.throttle(() => {
      this.updateUserActivityTime();
    }, 100).bind(this));

    // 监听鼠标滚轮事件（桌面端）
    chatlog.addEventListener("wheel", UIManager.throttle(() => {
      this.updateUserActivityTime();
    }, 100).bind(this));

    // Submit message
    chatInput.addEventListener("keydown", async (event) => {
      // 如果提及/贴纸列表正在显示，按 Enter 时不发送消息（交给自动补全处理）
      if (event.key === "Enter" && this.autocomplete && this.autocomplete.isOpen()) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && chatInput.value.trim() !== "") {
        let message = chatInput.value.trim();

        // 检测 /clear 命令（清除 Nako 上下文）
        if (message.match(/^\/clear$/i)) {
          event.preventDefault();

          // 清空输入框
          chatInput.value = '';

          // 触发清除上下文事件
          this.eventBus.emit('nako:clear');

          // 显示确认消息
          this.addChatMessage('系统', 'Nako 的对话上下文已清除。下次对话将不携带历史消息。', null, this.systemIcon, 'bg-default');

          return;
        }

        // 检测 AI 触发
        // 使用统一的配置驱动检测，支持：@Nako、@Asagi、@Miku、@汤川唯、/nako、/asagi、/miku、/yui 等
        const aiTrigger = window.AIConfig.detectAITrigger(message);

        // 统一处理 AI 调用
        if (aiTrigger) {
          event.preventDefault();

          const { persona, displayName, prompt } = aiTrigger;

          if (!prompt.trim()) {
            this.showError(`请输入要问 ${displayName} 的问题`);
            return;
          }

          // 清空输入框
          chatInput.value = '';

          // 先广播用户的问题（让所有人看到）
          if (onSendMessage) {
            onSendMessage(message);
          }

          // 触发 AI 调用事件（传递 persona 参数）
          this.eventBus.emit('nako:ask', {
            prompt: prompt.trim(),
            persona: persona
          });

          return;
        }

        // 普通消息处理
        if (message && onSendMessage) {
          if (pangu) {
            // 保护表情符号不被 pangu 处理（提取表情符号，处理后再恢复）
            const stickerPlaceholders = [];
            message = message.replace(/\[[^\]]+\]/g, (match) => {
              const index = stickerPlaceholders.length;
              stickerPlaceholders.push(match);
              return `__STICKER_${index}__`;
            });
            message = pangu.spacingText(message);
            // 恢复表情符号
            stickerPlaceholders.forEach((sticker, index) => {
              message = message.replace(`__STICKER_${index}__`, sticker);
            });
          }
          // Normalize stamp emoji format: replace [stamp_0806] with [stamp0806] to unify sticker rendering
          // 规范化 stamp 表情格式：将 [stamp_0806] 替换为 [stamp0806]，以统一处理 sticker 渲染
          message = message.replace(/\[stamp_(\d+)\]/g, (_, p1) => `[stamp${p1}]`);
          // 用户主动发送消息，重置交互时间并标记在底部
          // 发送消息后标记在底部，确保下次渲染会自动滚动
          this.isAtBottom = true;
          this.updateUserActivityTime();
          onSendMessage(message);
        }
      }
    });

    // Limit message length
    chatInput.addEventListener("input", (event) => {
      if (event.currentTarget.value.length > 256) {
        event.currentTarget.value = event.currentTarget.value.slice(0, 256);
      }
    });

    /**
     * Handles bracket insertion with auto-pairing for both keyboard and emoji button inputs.
     * - If there is a selection, wraps the selected text with [ and ] and places the caret after the closing bracket.
     * - If the next character is ']', skips over it instead of inserting a duplicate.
     * - Otherwise, inserts paired [] and places the caret between them.
     *
     * @param {HTMLInputElement|HTMLTextAreaElement} input - The input element to modify.
     */
    const handleLeftBracket = (input) => {
      const val = input.value || '';
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;

      if (start !== end) {
        // wrap selection with [ ... ] and place caret after the closing bracket
        const newVal = val.slice(0, start) + '[' + val.slice(start, end) + ']' + val.slice(end);
        input.value = newVal;
        const caretPos = end + 2; // after the closing ]
        input.setSelectionRange(caretPos, caretPos);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (window.innerWidth > 768) input.focus();
        return;
      }

      // if next char is ']', skip over it
      if (val.charAt(start) === ']') {
        input.setSelectionRange(start + 1, start + 1);
        if (window.innerWidth > 768) input.focus();
        return;
      }

      // insert paired [] and put caret between
      const newVal = val.slice(0, start) + '[]' + val.slice(end);
      input.value = newVal;
      const caretPos = start + 1;
      input.setSelectionRange(caretPos, caretPos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (window.innerWidth > 768) input.focus();
    };

    // Bracket auto-pairing and overwrite behavior for keyboard input
    chatInput.addEventListener('keydown', (event) => {
      try {
        const val = chatInput.value || '';
        const start = chatInput.selectionStart ?? 0;
        const end = chatInput.selectionEnd ?? start;

        // '[': use shared handler
        if (event.key === '[') {
          event.preventDefault();
          handleLeftBracket(chatInput);
          return;
        }

        // ']': if next is ']', skip over instead of inserting duplicate
        if (event.key === ']') {
          if (start === end && val.charAt(start) === ']') {
            event.preventDefault();
            chatInput.setSelectionRange(start + 1, start + 1);
            return;
          }
          // otherwise allow default insertion
        }

        // Backspace: if caret is between an empty pair [] then delete both
        if (event.key === 'Backspace') {
          if (start === end && start > 0 && val.charAt(start - 1) === '[' && val.charAt(start) === ']') {
            event.preventDefault();
            const newVal = val.slice(0, start - 1) + val.slice(start + 1);
            const caretPos = start - 1;
            chatInput.value = newVal;
            chatInput.setSelectionRange(caretPos, caretPos);
            chatInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
      } catch (e) {
        // don't block typing on unexpected errors
        console.warn('Error in keydown handler (bracket auto-pairing and backspace) for key:', event.key, {
          value: chatInput.value,
          selectionStart: chatInput.selectionStart,
          selectionEnd: chatInput.selectionEnd
        }, e);
      }
    });

    // Focus chat input on click
    this.elements.main.addEventListener("click", (e) => {
      // 如果点击的是提及列表项，不要聚焦输入框（因为点击事件会先触发，然后才是列表项的点击处理）
      // 或者更简单地，让列表项的点击处理完后再聚焦
      if (e.target.closest('.mention-list') || e.target.closest('.mention-item')) return;

      if (window.getSelection().toString() == "") {
        if (window.innerWidth > 768) chatInput.focus();
      }
    });

    // 移动设备上不自动聚焦聊天输入框
    if (window.innerWidth > 768) {
      chatInput.focus();
    }

    // 表情按钮：使用与按键 '[' 相同的自动配对逻辑
    try {
      const emojiBtn = document.querySelector('.input-btns button[title="表情"]');
      if (emojiBtn) {
        emojiBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const input = this.elements.chatInput;
          if (!input) return;
          handleLeftBracket(input);
        });
      }
    } catch (e) {
      const emojiBtn = document.querySelector('.input-btns button[title="表情"]');
      if (!emojiBtn) {
        console.warn('绑定表情按钮失败: 未找到表情按钮元素', e);
      } else {
        console.warn('绑定表情按钮失败: 事件监听器绑定异常', e, e && e.stack);
      }
    }
  }


  /**
   * 更新用户活动时间
   */
  updateUserActivityTime() {
    this.lastUserActivityTime = Date.now();
  }

  /**
   * 添加聊天消息到聊天日志
   * @param {string} name - 发送者名称
   * @param {string} message - 消息内容
   * @param {string} [avatar] - 发送者头像
   * @param {string} [color='bg-default'] - 头像背景颜色
   */
  addChatMessage(user, message, timestamp, avatar, color) {
    if (user === '系统') {
      this.addSystemMessage(message, timestamp, avatar, color);
    } else {
      this.addUserMessage(user, message, timestamp, avatar, color);
    }
  }

  /**
   * 添加系统消息（不保存到本地存储）
   * @private
   */
  addSystemMessage(message, timestamp, avatar, color) {
    const messageData = this.createMessageData('系统', message, timestamp, avatar, color);
    this.messages.push(messageData);

    // 直接创建并添加消息元素，而不是重新渲染整个列表
    const msgDiv = this.createMessageElement(messageData);

    // 如果有正在流式显示的消息，插入到它之前，否则添加到末尾
    const streamingMsg = this.elements.chatlog.querySelector('.streaming');
    if (streamingMsg) {
      this.elements.chatlog.insertBefore(msgDiv, streamingMsg);
    } else {
      this.elements.chatlog.appendChild(msgDiv);
    }

    // 智能滚动
    if (this.shouldAutoScrollToBottom()) {
      this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
    }
  }

  /**
   * 添加用户消息（保存到本地存储）
   * @private
   */
  addUserMessage(user, message, timestamp, avatar, color) {
    const messageData = this.createMessageData(user, message, timestamp, avatar, color);
    this.messages.push(messageData);

    const msgObj = {
      user: messageData.user,
      text: message,
      timestamp: messageData.timestamp
    };

    this.saveMessageToStorage(msgObj);
    this.lastMsgTimestamp = msgObj.timestamp;

    // 直接创建并添加消息元素，而不是重新渲染整个列表
    const msgDiv = this.createMessageElement(messageData);

    // 如果有正在流式显示的消息，插入到它之前，否则添加到末尾
    const streamingMsg = this.elements.chatlog.querySelector('.streaming');
    if (streamingMsg) {
      this.elements.chatlog.insertBefore(msgDiv, streamingMsg);
    } else {
      this.elements.chatlog.appendChild(msgDiv);
    }

    // 智能滚动
    if (this.shouldAutoScrollToBottom()) {
      this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
    }
  }

  /**
   * 创建消息数据对象
   * @private
   */
  createMessageData(user, message, timestamp, avatar, color) {
    const { name, avatar: userAvatar, color: userColor } = this.generateAvatar(user);
    return {
      user: name,
      avatar: avatar ?? userAvatar,
      color: color ?? userColor,
      time: timestamp ? this.formatDate(timestamp) : new Date().toLocaleTimeString(),
      text: message,
      timestamp: timestamp || Date.now()
    };
  }

  /**
   * 保存消息到本地存储
   * @private
   */
  saveMessageToStorage(msgObj) {
    try {
      const room = this.currentRoom || 'nightcord-default';
      let localMsgs = this.storage 
        ? this.storage.loadMessages(room) 
        : (this.loadLocalMessages(room) || []);
      
      localMsgs.push(msgObj);
      
      if (localMsgs.length > 2000) {
        localMsgs = localMsgs.slice(localMsgs.length - 2000);
      }
      
      if (this.storage) {
        this.storage.saveMessages(room, localMsgs);
        this.storage.setLastMsgTimestamp(room, msgObj.timestamp);
      } else {
        this.saveLocalMessages(room, localMsgs);
        this.setLastMsgTimestamp(room, msgObj.timestamp);
      }
    } catch (e) {
      // 静默失败，存储错误不应影响消息显示
    }
  }

  /**
   * 清空聊天输入框
   */
  clearChatInput() {
    this.elements.chatInput.value = "";
  }

  /**
   * 添加用户到在线用户列表
   * @param {string} username - 用户名
   */
  addUserToRoster(username) {
    // Avoid adding duplicate entries for the same username. Server may emit
    // a user:joined after we have locally renamed the user, so skip if
    // username already exists in the roster.
    if (this.roster.some(u => u.name === username)) return;
    this.roster.push(this.generateAvatar(username));
    this.renderVoiceUsers();
  }

  /**
   * 平滑处理用户名变更：只替换指定用户的显示，而不清空整个列表
   * @param {string} oldUsername
   * @param {string} newUsername
   */
  handleUserRename(oldUsername, newUsername) {
    if (!oldUsername || !newUsername) return;
    const idx = this.roster.findIndex(u => u.name === oldUsername);
    if (idx !== -1) {
      this.roster[idx] = this.generateAvatar(newUsername);
      this.renderVoiceUsers();
    } else {
      // If not present, just add the new username
      this.addUserToRoster(newUsername);
    }
  }

  /**
   * 从在线用户列表移除用户
   * @param {string} username - 用户名
   */
  removeUserFromRoster(username) {
    // Remove all matching users with the provided username to guard against
    // duplicates and then re-render only if something changed.
    const newRoster = this.roster.filter(user => user.name !== username);
    if (newRoster.length !== this.roster.length) {
      this.roster = newRoster;
      this.renderVoiceUsers();
    }
  }

  /**
   * 清空在线用户列表
   */
  clearRoster() {
    this.roster = [];
    this.renderVoiceUsers();
  }

  /**
   * 获取所有已知用户（在线 + 历史消息中的用户）
   * @returns {Array<{name: string, status: 'online'|'offline'}>}
   */
  getAllUsers() {
    const allUsers = new Map();

    // 1. 添加在线用户
    this.roster.forEach(u => {
      allUsers.set(u.name, { name: u.name, status: 'online', avatar: u.avatar, color: u.color });
    });

    // 2. 添加历史消息中的用户（作为离线用户，除非已在线）
    this.messages.forEach(msg => {
      if (msg.user && msg.user !== '系统' && !allUsers.has(msg.user)) {
        const { avatar, color } = this.generateAvatar(msg.user);
        allUsers.set(msg.user, { name: msg.user, status: 'offline', avatar, color });
      }
    });

    return Array.from(allUsers.values());
  }

  /**
   * 显示欢迎消息
   * @param {Object} data - 欢迎消息数据
   */
  showWelcomeMessages(data) {
    this.addChatMessage('系统', `警告: 此聊天室的参与者是互联网上的随机用户。用户名未经认证，任何人都可以冒充任何人。聊天记录将被保存。`, null, this.systemIcon, 'bg-red-600');
    this.addChatMessage('系统', '提示: 若要修改你的昵称，点击左侧在线用户列表中你的昵称并输入新昵称。', null, this.systemIcon, 'bg-default');
    this.addChatMessage('系统', `欢迎来到聊天室: ${data.roomname}`, null, this.systemIcon, 'bg-default');
  }

  /**
   * 显示错误消息
   * @param {string} message - 错误消息内容
   */
  showError(message) {
    this.addChatMessage('系统', `错误: ${message}`, null, this.systemIcon, 'bg-red-600');
  }

  /**
   * 获取所有 DOM 元素引用
   * @returns {Object} DOM 元素对象
   */
  getElements() {
    return this.elements;
  }

  /**
   * 检查消息是否提及了当前用户
   * @param {string} text - 消息内容
   * @returns {boolean}
   */
  isMentioned(text) {
    // 假设当前用户名存储在某个地方，或者通过某种方式获取
    // 这里暂时简单实现：如果消息包含 "@我的名字"
    // 由于没有明确的当前用户状态，我们可能需要从 localStorage 或其他地方获取
    // 暂时假设用户名为 localStorage 中的 'nightcord-username'
    const myName = localStorage.getItem('nightcord-username');
    if (!myName) return false;
    return text.includes(`@${myName}`);
  }

  /**
   * 渲染单条消息
   * @param {Object} msg - 消息对象
   * @returns {HTMLElement}
   */
  createMessageElement(msg) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    
    // 检查是否被提及
    if (this.isMentioned(msg.text)) {
      msgDiv.classList.add('mentioned');
    }

    // Avatar
    const avatarSpan = document.createElement('span');
    avatarSpan.className = `avatar ${msg.color}`;
    avatarSpan.innerHTML = msg.avatar;

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Header
    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';
    const userSpan = document.createElement('span');
    userSpan.className = 'message-user';
    userSpan.textContent = msg.user;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = msg.time;
    headerDiv.appendChild(userSpan);
    headerDiv.appendChild(timeSpan);
    contentDiv.appendChild(headerDiv);

    // Message text - 使用 SEKAI Renderer 或降级到 StickerService
    if (msg.text) {
      const p = document.createElement('p');
      p.className = 'message-text';

      let frag;
      if (this.sekaiRenderer) {
        // 使用 SEKAI Renderer（支持富文本）
        frag = this.sekaiRenderer.render(msg.text);
      } else if (this.stickerService) {
        // 降级到 StickerService（仅支持 stickers）
        frag = this.stickerService.renderTextWithStickers(msg.text);
      } else {
        // 最终降级到纯文本
        frag = document.createTextNode(msg.text);
      }

      p.appendChild(frag);
      contentDiv.appendChild(p);
    }

    msgDiv.appendChild(avatarSpan);
    msgDiv.appendChild(contentDiv);
    
    return msgDiv;
  }

  /**
   * Format a timestamp into a human-readable string with special handling for a "30-hour" night-shift display.

   *
   * Behavior summary:
   * - If `timestamp` is falsy, returns an empty string.
   * - Final returned formats:
   *   - Same day (diffDays === 0): "HH:MM:SS" (plus the 30-hour parenthetical if applicable)
   *   - Yesterday (diffDays === 1): "昨天 HH:MM:SS"
   *   - Within the last week but not yesterday (1 < diffDays < 7): "周X HH:MM:SS" where 周X is one of ["周日","周一",...,"周六"]
   *   - Older than a week (diffDays >= 7): "M月D日 HH:MM:SS"
   *
   * Notes:
   * - This function depends on UIManager.MILLISECONDS_PER_DAY to calculate full-day differences and UIManager.TWELVE_HOURS_MS (12 hours) to compute the 30-hour adjustment.
   * - The "30-hour" clock is a display convention: times from 00:00 to 05:59 are treated as belonging to the previous night's extended shift.
   *
   * @param {number|string|Date|null|undefined} timestamp - Value accepted by `new Date(timestamp)`. If falsy, the function returns an empty string.
   * @returns {string} A formatted, localized time string with contextual day label and optional 30-hour parenthetical.
   *
   * @example
   * // Same day
   * formatDate(Date.now()) // => "14:23:05"
   *
   * @example
   * // Early morning treated as previous night (30-hour clock shown in parentheses)
   * formatDate(new Date("2025-11-13T01:05:00").getTime()) // => "01:05:00（昨天 25:05:00）"
   *
   * @example
   * // Yesterday
   * formatDate(* timestamp from yesterday *) // => "昨天 23:15:10"
   *
   * @example
   * // Within last week
   * formatDate(* timestamp from last Wednesday *) // => "周三 09:00:00"
   *
   * @example
   * // Older than a week
   * formatDate(* timestamp from months ago *) // => "11月5日 07:30:00"
   */
  formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    let timeString = date.toLocaleTimeString();

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((startToday - startDate) / UIManager.MILLISECONDS_PER_DAY);

    let adjustedTimeString = '';

    // For messages sent before 6 AM, display them as belonging to the previous night.
    // According to 30-hour clock system.
    if (date.getHours() < 6) {
      const adjustedDate = new Date(date.getTime() - UIManager.TWELVE_HOURS_MS);
      adjustedTimeString = this.formatDate(adjustedDate.getTime()).replace(/(\d{1,2}):(\d{2}):(\d{2})/, (match, p1, p2, p3) => {
        return `${parseInt(p1) + 12}:${p2}:${p3}`;
      });
      adjustedTimeString = `（${adjustedTimeString}）`;
    }

    timeString += adjustedTimeString;

    if (diffDays === 0) return timeString;
    if (diffDays === 1) return `昨天 ${timeString}`;
    if (diffDays > 1 && diffDays < 7) {
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `${weekdays[date.getDay()]} ${timeString}`;
    }
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeString}`;
  }

  /**
   * 设置移动端菜单
   */
  setupMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const chatHeader = document.querySelector('.chat-header');
    
    if (!sidebar || !chatHeader) return;
    
    // 点击头部左侧区域切换侧边栏
    chatHeader.addEventListener('click', (e) => {
      // 只在点击左侧区域时触发（前50px）
      if (e.clientX < 50) {
        sidebar.classList.toggle('show');
      }
    });
    
    // 点击侧边栏外部区域关闭侧边栏
    document.addEventListener('click', (e) => {
      if (sidebar.classList.contains('show')) {
        // 检查点击是否在侧边栏外部且不是头部按钮
        if (!sidebar.contains(e.target) && !e.target.closest('.chat-header')) {
          sidebar.classList.remove('show');
        }
      }
    });
    
    // 点击侧边栏内的频道时关闭侧边栏（移动端）
    const channels = sidebar.querySelectorAll('.channel, .voice-user');
    channels.forEach(channel => {
      channel.addEventListener('click', () => {
        // 只在移动端关闭（通过检测窗口宽度）
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('show');
        }
      });
    });
  }
}
