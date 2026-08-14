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

    // 文件上传服务：上传走 storage，公开资源解析走 r2 门面（SEKAI v2）
    this.fileUploadService = new FileUploadService({
      baseUrl: 'https://storage.nightcord.de5.net',
      resourceBaseUrl: 'https://r2.nightcord.de5.net',
      useSekaiV2: true
    });

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
      attachmentBtn: document.querySelector("#attachmentBtn"),
      fileUploadMenu: document.querySelector("#fileUploadMenu"),
      imageInput: document.querySelector("#imageInput"),
      musicInput: document.querySelector("#musicInput"),
      fileInput: document.querySelector("#fileInput"),
      uploadProgress: document.querySelector("#fileUploadProgress"),
      uploadFilename: document.querySelector("#uploadFilename"),
      uploadPercent: document.querySelector("#uploadPercent"),
      uploadFill: document.querySelector("#uploadFill"),
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

    if (typeof EmojiService !== 'undefined') {
      this.emojiService = new EmojiService();
    } else {
      console.warn('EmojiService not available, emoji rendering disabled');
      this.emojiService = null;
    }

    if (typeof AutocompleteManager !== 'undefined') {
      this.autocomplete = new AutocompleteManager({
        input: this.elements.chatInput,
        list: document.querySelector('#mention-list'),
        atButton: document.querySelector('.input-btns button[title="@"]'),
        getAllUsers: () => this.getAllUsers(),
        getStickers: () => (this.stickerService ? this.stickerService.getStickers() : []),
        getEmojis: () => (this.emojiService ? this.emojiService.getEmojis() : [])
      });
    } else {
      console.warn('AutocompleteManager not available, mention/sticker autocomplete disabled');
      this.autocomplete = null;
    }

    // 消息索引：timestamp → message element (for reply jumps)
    // 必须在 SekaiRenderer 初始化前创建，供 lookupReply 闭包使用
    this.messageIndex = new Map();
    // 消息元数据：timestamp → { user, text }（v2 Reply 客户端派生预览）
    this.messageMeta = new Map();

    // 初始化 SEKAI Renderer（v1 + v2 双解析）
    if (typeof SekaiRenderer !== 'undefined') {
      const fus = this.fileUploadService;
      this.sekaiRenderer = new SekaiRenderer({
        stickerService: this.stickerService,
        emojiService: this.emojiService,
        stickerDir: this.stickerDir,
        aiPersonas: window.AIConfig ? window.AIConfig.getAllDisplayNames() : [],
        imageWidthThreshold: 400,
        // v2 typed paths (images|files|stickers/{uuid}) — may be r2.* host later
        resourceBaseUrl: fus
          ? (fus.resourceBaseUrl || fus.baseUrl)
          : 'https://r2.nightcord.de5.net',
        // legacy keys are public media too; storage is kept for API/compat upload.
        storageBaseUrl: fus
          ? (fus.resourceBaseUrl || fus.baseUrl)
          : 'https://r2.nightcord.de5.net',
        lookupReply: (ts) => this.lookupReplyMeta(ts)
      });
    } else {
      console.warn('SekaiRenderer not available, falling back to basic text rendering');
      this.sekaiRenderer = null;
    }

    // 监听回复跳转事件
    this.setupReplyJumpListener();
  }

  /**
   * 查找被回复消息的预览信息（SEKAI v2 Reply）
   * @param {number|string} ts
   * @returns {{ name?: string, preview?: string } | null}
   */
  lookupReplyMeta(ts) {
    const key = Number(ts) || ts;
    const meta = this.messageMeta.get(key) || this.messageMeta.get(String(ts));
    if (!meta) return null;
    const plain = this.extractPlainTextForReply(meta.text || '');
    const preview = plain.length > 50 ? plain.substring(0, 50) + '...' : plain;
    return {
      name: meta.user || '',
      preview: preview.replace(/\n/g, ' ')
    };
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
      // 欢迎消息（在渲染之前添加到 messages 数组）
      this.showWelcomeMessages(data);
      // 渲染（包含欢迎消息）
      this.renderMessages();
      // 记录最新消息时间戳 到 per-room lastmsg
      if (this.messages.length > 0) {
        const lastTs = this.messages[this.messages.length - 1].timestamp;
        if (this.storage) this.storage.setLastMsgTimestamp(room, lastTs); else this.setLastMsgTimestamp(room, lastTs);
      }
    });
    this.eventBus.on('error', (data) => this.showError(data.message));

    // Nako AI 事件监听
    this.setupNakoEventListeners();
  }

  /**
   * 设置回复跳转事件监听器
   * @private
   */
  setupReplyJumpListener() {
    document.addEventListener('reply-jump', (event) => {
      const { timestamp } = event.detail;
      const messageEl = this.messageIndex.get(timestamp);

      if (messageEl) {
        // 滚动到目标消息
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 添加高亮动画
        messageEl.classList.add('message-highlighted');
        setTimeout(() => {
          messageEl.classList.remove('message-highlighted');
        }, 2000);
      } else {
        // 消息不存在或不在当前视图中
        console.warn('Reply target message not found:', timestamp);
      }
    });
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
      /*
       * user.name 来自别的用户 —— SEKAI Pass 的 name / preferred_username
       * claim，那边只校验长度（≤ 50 字符）。不转义的话，
       * `"><img src=x onerror=alert(1)>` 这样的昵称会在每个看到成员列表的
       * 人的浏览器里执行。
       *
       * color 与 avatar 本来是由 generateAvatar 生成的（固定色板 + 名字首字符），
       * 但它们跟名字来自同一个对象，一并转义，省得以后有人改了来源还要重新论证。
       */
      div.innerHTML = `
          <div class="voice-user-info">
            <span class="avatar ${escapeHtml(user.color)}">${escapeHtml(user.avatar)}</span>
            <span style="font-size:14px;">${escapeHtml(user.name)}</span>
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
   * 渲染消息列表（性能优化版本）
   */
  renderMessages() {
    // Performance optimization: Use PerformanceOptimizer if available
    if (typeof PerformanceOptimizer !== 'undefined') {
      PerformanceOptimizer.mark('renderMessages-start');
    }

    // Batch DOM operations to avoid layout thrashing
    const batchOperation = () => {
      this.elements.chatlog.innerHTML = '';

      // Use DocumentFragment for efficient batch insertion
      const fragment = document.createDocumentFragment();

      this.messages.forEach(msg => {
        const msgDiv = this.createMessageElement(msg);
        fragment.appendChild(msgDiv);
      });

      this.elements.chatlog.appendChild(fragment);
    };

    // Execute batch operation using RAF if available
    if (typeof PerformanceOptimizer !== 'undefined') {
      PerformanceOptimizer.raf(batchOperation);
    } else {
      batchOperation();
    }

    // 智能滚动逻辑（延迟到下一帧避免强制布局）
    const scrollOperation = () => {
      const shouldAutoScroll = this.shouldAutoScrollToBottom();
      if (shouldAutoScroll) {
        this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
      }
    };

    if (typeof PerformanceOptimizer !== 'undefined') {
      PerformanceOptimizer.raf(scrollOperation);
      PerformanceOptimizer.mark('renderMessages-end');
      PerformanceOptimizer.measure('renderMessages', 'renderMessages-start', 'renderMessages-end');
    } else {
      setTimeout(scrollOperation, 0);
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
      textElement.className = 'message-text sekai-message__text';
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

      // Shift+Enter 换行逻辑
      if (event.key === "Enter" && event.shiftKey) {
        // 允许默认行为（textarea 自动插入换行符）
        // 触发自适应高度调整
        setTimeout(() => {
          chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        }, 0);
        return; // 不执行发送逻辑
      }

      if (event.key === "Enter" && !event.shiftKey && chatInput.value.trim() !== "") {
        event.preventDefault(); // 阻止 textarea 默认换行行为
        let message = chatInput.value.trim();

        // 检测 /clear 命令（清除 Nako 上下文）
        if (message.match(/^\/clear$/i)) {
          event.preventDefault();

          // 清空输入框
          chatInput.value = '';
          chatInput.style.height = 'auto'; // 重置为单行高度

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
          chatInput.style.height = 'auto'; // 重置为单行高度

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
            // 保护 SEKAI / Markdown 语法不被 pangu 插入空格
            const placeholders = [];
            const protect = (match) => {
              const index = placeholders.length;
              placeholders.push(match);
              return `__SEKAI_${index}__`;
            };

            // 0. 保护 SEKAI v2 multi-line blocks (<$SEKAI:…>\n…\n<&SEKAI>)
            message = message.replace(this._v2BlockRe(), protect);

            // 1. 保护 SEKAI v2 single-line tokens
            message = message.replace(this._v2TokenRe('g'), protect);

            // 2. 保护 SEKAI v1 [type:data] 与 legacy stickers
            message = message.replace(/\[([^\]]+)\]/g, protect);

            // 3. 保护 markdown 格式标记
            message = message.replace(/\*\*([^*]+)\*\*/g, protect);
            message = message.replace(/\*([^*\s][^*]*[^*\s])\*/g, protect);
            message = message.replace(/~~([^~]+)~~/g, protect);
            message = message.replace(/\|\|([^|]+)\|\|/g, protect);
            message = message.replace(/`([^`]+)`/g, protect);

            message = pangu.spacingText(message);

            placeholders.forEach((original, index) => {
              message = message.replace(`__SEKAI_${index}__`, original);
            });
          }

          // 发送侧 stamp 保持 v1 短语法（256 预算 + autocomplete 生态）
          // [stamp_0806] / [stamp0806] → [stamp:0806]；不改写成 v2
          message = message
            .replace(/\[stamp_(\d+)\]/gi, (_, n) => `[stamp:${n}]`)
            .replace(/\[stamp(\d+)\]/gi, (_, n) => `[stamp:${n}]`);

          // 用户主动发送消息，重置交互时间并标记在底部
          this.isAtBottom = true;
          this.updateUserActivityTime();
          onSendMessage(message);
        }
      }
    });

    // Limit message length — must match server-side cap (currently 256)
    // Do not raise client-side alone: users would compose messages the server rejects/truncates.
    const MAX_MESSAGE_LENGTH = 256;
    chatInput.addEventListener("input", (event) => {
      const input = event.currentTarget;

      // 1. 字符限制（与服务端一致）
      if (input.value.length > MAX_MESSAGE_LENGTH) {
        input.value = input.value.slice(0, MAX_MESSAGE_LENGTH);
        if (!input.dataset.lengthToast) {
          input.dataset.lengthToast = '1';
          this.addChatMessage('系统', `消息过长，已截断至 ${MAX_MESSAGE_LENGTH} 字符（服务端限制）`, Date.now(), this.systemIcon, 'bg-red-600');
          setTimeout(() => { delete input.dataset.lengthToast; }, 2000);
        }
      }

      // 2. 自适应高度调整
      input.style.height = 'auto'; // 重置高度以获取正确的 scrollHeight
      const newHeight = Math.min(Math.max(input.scrollHeight, 22), 140);
      input.style.height = `${newHeight}px`;

      // 3. 超过最大高度时显示滚动条
      if (input.scrollHeight > 140) {
        input.style.overflowY = 'auto';
      } else {
        input.style.overflowY = 'hidden';
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

    // 附件按钮：显示/隐藏文件上传菜单
    this.setupFileUpload();
  }

  /**
   * 设置文件上传功能
   */
  setupFileUpload() {
    const { attachmentBtn, fileUploadMenu, imageInput, musicInput, fileInput, chatInput } = this.elements;

    if (!attachmentBtn || !fileUploadMenu) {
      console.warn('文件上传初始化失败: 未找到必需的元素');
      return;
    }

    // 点击附件按钮显示/隐藏菜单
    attachmentBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileUploadMenu.classList.toggle('hidden');
    });

    // 点击其他地方关闭菜单
    document.addEventListener('click', (e) => {
      if (!attachmentBtn.contains(e.target) && !fileUploadMenu.contains(e.target)) {
        fileUploadMenu.classList.add('hidden');
      }
    });

    // 菜单项点击
    const menuItems = fileUploadMenu.querySelectorAll('.file-upload-menu-item');
    menuItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const type = item.dataset.type;
        fileUploadMenu.classList.add('hidden');

        if (type === 'image') {
          imageInput.click();
        } else if (type === 'music') {
          musicInput.click();
        } else if (type === 'file') {
          fileInput.click();
        }
      });
    });

    // 拖拽上传支持
    const dropZone = document.body;
    let dragCounter = 0;

    // 创建拖拽覆盖层
    const overlay = document.createElement('div');
    overlay.className = 'drag-overlay hidden';
    overlay.innerHTML = `
      <div class="drag-message">
        <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
        <span>释放文件以上传</span>
      </div>
    `;
    document.body.appendChild(overlay);

    dropZone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) {
        overlay.classList.remove('hidden');
        // 强制重绘以触发 transition
        overlay.offsetHeight; 
        overlay.classList.add('visible');
      }
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter === 0) {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.classList.add('hidden'), 200);
      }
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      overlay.classList.remove('visible');
      setTimeout(() => overlay.classList.add('hidden'), 200);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        // 简单判断类型
        let type = 'file';
        if (file.type.startsWith('image/')) {
          type = 'image';
        } else if (file.type.startsWith('audio/')) {
          type = 'music';
        }
        this.handleFileUpload(file, type);
      }
    });

    // 粘贴上传支持
    if (chatInput) {
      chatInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (const item of items) {
          if (item.kind === 'file') {
            e.preventDefault();
            const file = item.getAsFile();
            let type = 'file';
            if (file.type.startsWith('image/')) {
              type = 'image';
            } else if (file.type.startsWith('audio/')) {
              type = 'music';
            }
            this.handleFileUpload(file, type);
            return; // 只处理第一个文件
          }
        }
      });
    }

    // 文件选择处理
    imageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleFileUpload(file, 'image');
      imageInput.value = ''; // 清空以允许重复选择同一文件
    });

    musicInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleFileUpload(file, 'music');
      musicInput.value = '';
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleFileUpload(file, 'file');
      fileInput.value = ''; // 清空以允许重复选择同一文件
    });
  }

  /**
   * 处理文件上传
   * @param {File} file 要上传的文件
   * @param {string} uploadType 上传类型：'image' 或 'file'
   */
  _insertPlaceholder(chatInput, placeholder) {
    if (!chatInput) return false;

    const cursorPos = chatInput.selectionStart || chatInput.value.length;
    const textBefore = chatInput.value.substring(0, cursorPos);
    const textAfter = chatInput.value.substring(cursorPos);

    chatInput.value = textBefore + placeholder + textAfter;

    const newPos = cursorPos + placeholder.length;
    chatInput.setSelectionRange(newPos, newPos);
    chatInput.focus();
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));

    return true;
  }

  _showUploadProgress(uploadProgress, uploadFilename, uploadPercent, uploadFill, filename) {
    uploadProgress.classList.remove('hidden');
    uploadFilename.textContent = filename;
    uploadPercent.textContent = '0%';
    uploadFill.style.width = '0%';
  }

  /**
   * 构造上传完成后插入输入框的 SEKAI token。
   *
   * 发送策略（服务端 256 字硬顶；渲染侧 v1+v2 全量支持）：
   * - Image / File / Music → v2（payload = uuid 或 legacy key）
   * - descriptions 按优先级塞入，保证整 token ≤ 256（编码后长度）
   * - Music：只发 title（不与 name 双写）；Unknown artist 省略
   * - Stamp 保持 v1 短语法
   *
   * @private
   */
  async _generateFileMessage(uploadType, fileUrl, file, result) {
    // Prefer SEKAI v2 uuid; fall back to legacy key; then full URL
    const id = (result && (result.uuid || result.key) != null)
      ? String(result.uuid || result.key).replace(/^\//, '')
      : (fileUrl || '');

    // v2 upload returns size already in kB; legacy returns bytes
    let sizeKb = '';
    if (result) {
      if (result.uuid != null && result.size != null) {
        sizeKb = +Number(result.size).toFixed(1);
      } else if (result.size_bytes != null) {
        sizeKb = +(Number(result.size_bytes) / 1024).toFixed(1);
      } else if (result.size != null) {
        // Heuristic: values > 100000 are almost certainly bytes
        const n = Number(result.size);
        sizeKb = n > 100000 ? +(n / 1024).toFixed(1) : +n.toFixed(1);
      }
    } else if (file && file.size != null) {
      sizeKb = +(file.size / 1024).toFixed(1);
    }

    const mime = (result && result.type) || (file && file.type) || 'application/octet-stream';
    const name = (result && result.name) || (file && file.name) || 'file';
    const baseName = name.replace(/\.[^/.]+$/, '');

    if (uploadType === 'image') {
      let w = result && result.w;
      let h = result && result.h;
      if (!(w > 0 && h > 0)) {
        try {
          const wh = await this._readImageDimensions(file);
          if (wh) {
            w = wh.w;
            h = wh.h;
          }
        } catch (_) { /* ignore */ }
      }
      // Priority: w/h (layout) > name (optional label)
      const fields = [];
      if (w > 0 && h > 0) {
        fields.push({ key: 'w', value: String(w), encode: false });
        fields.push({ key: 'h', value: String(h), encode: false });
      }
      fields.push({ key: 'name', value: name, encode: true });
      return this._buildSekaiV2Token('Image', fields, id);
    }

    if (uploadType === 'music') {
      const metadata = await this.extractAudioMetadata(file);
      const title = (metadata.title || baseName || 'track').trim();
      const artist = (metadata.artist || '').trim();
      // Priority: type (audio→music routing) → duration (compact) → title → artist.
      // Do NOT emit name alongside title — they were the same filename and
      // percent-encoding CJK twice blew past the 256-char hard cap.
      const fields = [
        { key: 'type', value: mime || 'audio/mpeg', encode: true }
      ];
      if (metadata.durationSec != null && !Number.isNaN(metadata.durationSec) && metadata.durationSec > 0) {
        fields.push({ key: 'duration', value: String(metadata.durationSec), encode: false });
      }
      fields.push({ key: 'title', value: title, encode: true });
      // Skip placeholder artists; only keep a real one when budget allows
      const artistPlaceholder = /^(unknown(\s+artist)?|未知|未知艺术家)$/i;
      if (artist && !artistPlaceholder.test(artist)) {
        fields.push({ key: 'artist', value: artist, encode: true });
      }
      return this._buildSekaiV2Token('Files', fields, id);
    }

    // Generic file card
    const fields = [
      { key: 'type', value: mime, encode: true },
      { key: 'name', value: name, encode: true }
    ];
    if (sizeKb !== '') {
      fields.push({ key: 'size', value: String(sizeKb), encode: false });
    }
    return this._buildSekaiV2Token('Files', fields, id);
  }

  /**
   * Percent-encode a description value (SEKAI §3.4), matching the renderer.
   * @private
   */
  _sekaiEncode(str) {
    if (this.sekaiRenderer && typeof this.sekaiRenderer.percentEncode === 'function') {
      return this.sekaiRenderer.percentEncode(str);
    }
    return encodeURIComponent(String(str == null ? '' : str));
  }

  /**
   * Clip a string so its percent-encoded form fits in `maxEncoded` chars.
   * @private
   * @returns {string}
   */
  _clipToEncodedBudget(str, maxEncoded) {
    const s = String(str == null ? '' : str);
    if (maxEncoded <= 0) return '';
    if (this._sekaiEncode(s).length <= maxEncoded) return s;

    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this._sekaiEncode(s.slice(0, mid)).length <= maxEncoded) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo);
  }

  /**
   * Build a single-line SEKAI v2 token that never exceeds maxLen.
   * Fields are packed in priority order; oversize encoded values are clipped;
   * remaining fields that still don't fit are dropped.
   *
   * Wire form: <$SEKAI:Type:k=v;k2=v2:payload>
   *
   * @private
   * @param {string} type
   * @param {Array<{key:string,value:string,encode?:boolean}>} fields
   * @param {string} payload
   * @param {number} [maxLen=256]
   * @returns {string}
   */
  _buildSekaiV2Token(type, fields, payload, maxLen = 256) {
    const payloadStr = String(payload || '');
    const prefix = `<$SEKAI:${type}:`;
    const suffix = `:${payloadStr}>`;
    let budget = maxLen - prefix.length - suffix.length;

    // Payload alone already over budget (legacy full URL etc.) — strip descs
    if (budget < 0) {
      // Last resort: keep a valid-looking shell truncated by the input cap
      return (prefix + suffix).slice(0, maxLen);
    }

    const included = [];
    for (const f of fields) {
      if (f == null || f.value == null || f.value === '') continue;

      const sep = included.length ? 1 : 0; // ';'
      const keyPart = `${f.key}=`;
      const overhead = sep + keyPart.length;
      if (overhead >= budget) continue;

      let raw = String(f.value);
      let encoded = f.encode === false ? raw : this._sekaiEncode(raw);

      if (encoded.length + overhead > budget) {
        if (f.encode === false) {
          // Numeric / fixed fields can't be partially useful — skip
          continue;
        }
        const avail = budget - overhead;
        if (avail < 1) continue;
        raw = this._clipToEncodedBudget(raw, avail);
        if (!raw) continue;
        encoded = this._sekaiEncode(raw);
        // Defensive: binary-search should fit, but re-check
        if (encoded.length + overhead > budget) continue;
      }

      included.push(keyPart + encoded);
      budget -= overhead + encoded.length;
    }

    return prefix + included.join(';') + suffix;
  }

  /**
   * 读取图片宽高（用于 SEKAI v2 Image w/h 描述）
   * @private
   * @returns {Promise<{w:number,h:number}|null>}
   */
  _readImageDimensions(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = (val) => {
        URL.revokeObjectURL(url);
        resolve(val);
      };
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => done(null);
      // 超时保护
      setTimeout(() => done(null), 2000);
      img.src = url;
    });
  }

  _replacePlaceholderInInput(chatInput, placeholder, fileMsg, placeholderInserted) {
    if (!chatInput) return;

    if (placeholderInserted && chatInput.value.includes(placeholder)) {
      const currentPos = chatInput.selectionStart;
      const placeholderIndex = chatInput.value.indexOf(placeholder);

      chatInput.value = chatInput.value.replace(placeholder, fileMsg);

      if (currentPos > placeholderIndex) {
        const extraChars = fileMsg.length - placeholder.length;
        const newPos = currentPos + extraChars;
        chatInput.setSelectionRange(newPos, newPos);
      } else {
        chatInput.setSelectionRange(currentPos, currentPos);
      }
    } else {
      const text = chatInput.value;
      chatInput.value = text + (text.length > 0 && !text.endsWith(' ') ? ' ' : '') + fileMsg;
      chatInput.scrollTop = chatInput.scrollHeight;
    }

    chatInput.focus();
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  _removePlaceholder(chatInput, placeholder, placeholderInserted) {
    if (chatInput && placeholderInserted && chatInput.value.includes(placeholder)) {
      chatInput.value = chatInput.value.replace(placeholder, '');
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async handleFileUpload(file, uploadType) {
    const { uploadProgress, uploadFilename, uploadPercent, uploadFill, chatInput } = this.elements;

    // 验证文件大小：上传服务会按 direct / multipart / compat 选择端口。
    const maxSize = this.fileUploadService.multipartMaxUploadBytes || FileUploadService.MULTIPART_MAX_UPLOAD_BYTES;
    if (!FileUploadService.validateSize(file, maxSize)) {
      this.addChatMessage('系统', `文件过大，最大支持 ${FileUploadService.formatSize(maxSize)}`, Date.now(), this.systemIcon, 'bg-red-600');
      return;
    }

    const placeholder = `[上传中: ${file.name}...]`;
    const placeholderInserted = this._insertPlaceholder(chatInput, placeholder);
    this._showUploadProgress(uploadProgress, uploadFilename, uploadPercent, uploadFill, file.name);

    try {
      // Pre-read image dimensions so v2 upload can store w/h in meta
      let extra = { kind: uploadType === 'image' ? 'image' : 'file' };
      if (uploadType === 'image') {
        try {
          const wh = await this._readImageDimensions(file);
          if (wh) {
            extra.w = wh.w;
            extra.h = wh.h;
          }
        } catch (_) { /* ignore */ }
      }

      // 进度条是「假进度」：传输映射到 ~0–92%，等服务端落盘时缓爬到 99%，
      // 真正 2xx 后才到 100%。全程只显示百分比，不切换文案。
      const result = await this.fileUploadService.upload(file, file.name, (percent) => {
        uploadPercent.textContent = `${percent}%`;
        uploadFill.style.width = `${percent}%`;
      }, extra);

      // 服务端已响应；拼 token 期间保持 100%，避免条先消失、输入框还是占位符
      uploadPercent.textContent = '100%';
      uploadFill.style.width = '100%';

      const id = result.uuid || result.key;
      const kind = result.kind || extra.kind || 'file';
      const fileUrl = this.fileUploadService.getFileUrl(id, kind);
      const fileMsg = await this._generateFileMessage(uploadType, fileUrl, file, result);

      this._replacePlaceholderInInput(chatInput, placeholder, fileMsg, placeholderInserted);
      uploadProgress.classList.add('hidden');

    } catch (error) {
      console.error('文件上传失败:', error);
      uploadProgress.classList.add('hidden');
      this.addChatMessage('系统', `文件上传失败: ${error.message}`, Date.now(), this.systemIcon, 'bg-red-600');
      this._removePlaceholder(chatInput, placeholder, placeholderInserted);
    }
  }

  /**
   * 提取音频文件元数据
   * @param {File} file 音频文件
   * @returns {Promise<{title: string, artist: string, duration: string}>}
   */
  async extractAudioMetadata(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(file);
      const title = (file.name || 'track').replace(/\.[^/.]+$/, '');

      audio.addEventListener('loadedmetadata', () => {
        // v2: duration as seconds (float); keep formatted for any legacy consumers
        const durationSec = Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 10) / 10
          : 0;
        const minutes = Math.floor(durationSec / 60);
        const seconds = Math.floor(durationSec % 60).toString().padStart(2, '0');

        URL.revokeObjectURL(objectUrl);

        resolve({
          title,
          artist: 'Unknown Artist',
          duration: `${minutes}:${seconds}`,
          durationSec
        });
      });

      audio.addEventListener('error', () => {
        URL.revokeObjectURL(objectUrl);
        resolve({
          title,
          artist: 'Unknown Artist',
          duration: '0:00',
          durationSec: 0
        });
      });

      audio.src = objectUrl;
    });
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

    // 使用 RAF 优化 DOM 操作
    const appendOperation = () => {
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
    };

    if (typeof PerformanceOptimizer !== 'undefined') {
      PerformanceOptimizer.raf(appendOperation);
    } else {
      appendOperation();
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

    // 使用 RAF 优化 DOM 操作
    const appendOperation = () => {
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
    };

    if (typeof PerformanceOptimizer !== 'undefined') {
      PerformanceOptimizer.raf(appendOperation);
    } else {
      appendOperation();
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
    this.elements.chatInput.style.height = 'auto'; // 重置为单行高度
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
    // 只添加到 messages 数组，不触发 DOM 操作（由 renderMessages 统一渲染）
    const messages = [
      { text: `警告: 此聊天室的参与者是互联网上的随机用户。用户名未经认证，任何人都可以冒充任何人。聊天记录将被保存。`, color: 'bg-red-600' },
      { text: '提示: 若要修改你的昵称，点击左侧在线用户列表中你的昵称并输入新昵称。', color: 'bg-default' },
      { text: `欢迎来到聊天室: ${data.roomname}`, color: 'bg-default' }
    ];

    messages.forEach(({ text, color }) => {
      const messageData = this.createMessageData('系统', text, null, this.systemIcon, color);
      this.messages.push(messageData);
    });
  }

  /**
   * 显示错误消息
   * @param {string} message - 错误消息内容
   */
  showError(message) {
    this.addChatMessage('系统', `错误: ${message}`, null, this.systemIcon, 'bg-red-600');
  }

  /**
   * 显示结构化的认证错误弹层。
   *
   * 入参是 `window.describeAuthError(error)` 的返回值：带错误码、中文标题、
   * 原因说明、解决方案，以及供调试用的 sourceCode / originalMessage。
   *
   * 与聊天流内的 {@link showError} 不同，登录失败发生在进入聊天室之前，
   * 此时没有消息流可写，所以用一个独立的模态弹层承载。
   *
   * @param {{code: string, title: string, description: string, solution: string, sourceCode: (string|null), originalMessage: string}} descriptor
   * @param {{onRetry?: () => void}} [options] 提供 onRetry 时显示「重新登录」按钮
   */
  showAuthError(descriptor, options = {}) {
    const esc = window.escapeHtml || ((v) => String(v == null ? '' : v));
    const d = descriptor || {};
    const code = esc(d.code || 'ERR_AUTH_UNKNOWN');
    const title = esc(d.title || '登录失败');
    const description = esc(d.description || '');
    const solution = esc(d.solution || '');
    // 调试细节：优先展示原始英文 message，附带 SDK 的 sourceCode
    const debugParts = [];
    if (d.sourceCode) debugParts.push(`code=${d.sourceCode}`);
    if (d.originalMessage) debugParts.push(d.originalMessage);
    const debug = esc(debugParts.join(' · '));

    // 移除可能残留的旧弹层，避免叠加
    const existing = document.getElementById('auth-error-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'auth-error-overlay';
    overlay.className = 'auth-error-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'auth-error-title');

    const retryButton = typeof options.onRetry === 'function'
      ? '<button type="button" class="auth-error-btn auth-error-btn--primary" data-action="retry">重新登录</button>'
      : '';

    overlay.innerHTML = `
      <div class="auth-error-dialog">
        <div class="auth-error-icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </div>
        <div class="auth-error-code">${code}</div>
        <h2 id="auth-error-title" class="auth-error-title">${title}</h2>
        ${description ? `<p class="auth-error-desc">${description}</p>` : ''}
        ${solution ? `<div class="auth-error-solution"><span class="auth-error-solution__label">解决方案</span><span>${solution}</span></div>` : ''}
        ${debug ? `<div class="auth-error-debug">${debug}</div>` : ''}
        <div class="auth-error-actions">
          ${retryButton}
          <button type="button" class="auth-error-btn" data-action="close">关闭</button>
        </div>
      </div>
    `;

    const close = () => {
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-action="close"]').addEventListener('click', close);
    const retryEl = overlay.querySelector('[data-action="retry"]');
    if (retryEl) {
      retryEl.addEventListener('click', () => {
        close();
        options.onRetry();
      });
    }
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    document.body.appendChild(overlay);
    // 聚焦首个按钮，便于键盘操作
    const firstBtn = overlay.querySelector('.auth-error-btn');
    if (firstBtn) firstBtn.focus();
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

    // 存储 timestamp 用于回复跳转 + v2 Reply 预览元数据
    if (msg.timestamp) {
      msgDiv.dataset.timestamp = msg.timestamp;
      this.messageIndex.set(msg.timestamp, msgDiv);
      this.messageIndex.set(Number(msg.timestamp), msgDiv);
      this.messageMeta.set(msg.timestamp, { user: msg.user, text: msg.text || '' });
      this.messageMeta.set(Number(msg.timestamp), { user: msg.user, text: msg.text || '' });
    }

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
      p.className = 'message-text sekai-message__text';

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

    // 回复按钮（只给非系统消息添加）
    if (msg.user !== '系统' && msg.timestamp) {
      const replyBtn = this.createReplyButton(msg);
      msgDiv.appendChild(replyBtn);
    }

    return msgDiv;
  }

  /**
   * 创建回复按钮
   * @param {Object} msg - 消息对象
   * @returns {HTMLElement}
   * @private
   */
  createReplyButton(msg) {
    const btn = document.createElement('button');
    btn.className = 'message-reply-btn';
    btn.title = '回复此消息';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="currentColor">
      <path d="M760-200v-160q0-50-35-85t-85-35H273l144 144-57 56-240-240 240-240 57 56-144 144h367q83 0 141.5 58.5T840-360v160h-80Z"/>
    </svg>`;

    btn.onclick = (e) => {
      e.stopPropagation();
      this.insertReplyReference(msg);
    };

    return btn;
  }

  /**
   * 在输入框插入回复引用
   * 发送策略：Reply 使用 SEKAI v2（无 wire preview，通常比 v1 更短；预览渲染时客户端派生）
   * @param {Object} msg - 要引用的消息对象
   * @private
   */
  insertReplyReference(msg) {
    const input = this.elements.chatInput;
    if (!input) return;

    // SEKAI v2 Reply：payload = timestamp only
    const reference = `<$SEKAI:Reply::${msg.timestamp}> `;

    // 插入到当前光标位置
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || start;
    const current = input.value;

    input.value = current.substring(0, start) + reference + current.substring(end);

    // 设置光标位置到引用后面
    const newPos = start + reference.length;
    input.setSelectionRange(newPos, newPos);

    // 聚焦输入框
    if (window.innerWidth > 768) {
      input.focus();
    }

    // 触发 input 事件以通知其他监听器
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 从消息文本中提取纯文本内容
   * 移除嵌套回复引用和 SEKAI 标记，保留有文本意义的内容
   * @param {string} text - 原始消息文本
   * @returns {string} 纯文本内容
   * @private
   */

  /**
   * 按 SEKAI v2 规范构造匹配 token 的正则。
   *
   * Type 的形状取自 SekaiRenderer.V2_TYPE_SOURCE（规范 §3.3），
   * **不要在这里另写一份**。此前这几处用的是 `<\$SEKAI:[^>\n]*>`，
   * 不校验 Type，于是 `<$SEKAI:123:x>` 这类畸形 token 在渲染器眼里是
   * 纯文本、在这里却是 token —— 屏幕上看得见，复制/引用时整段消失。
   *
   * 渲染器不可用时回落到宽松形状：宁可沿用旧行为，也不要因为脚本
   * 加载顺序变了就把所有 token 都漏掉。
   * @private
   */
  _v2TokenRe(flags) {
    const type = (typeof SekaiRenderer !== 'undefined' && SekaiRenderer.V2_TYPE_SOURCE) || '[^>\\n]*';
    return new RegExp(`<\\$SEKAI:${type}:[^>\\n]*>`, flags);
  }

  /** 多行块：`<$SEKAI:Type:desc>` + 换行 + 内容 + `<&SEKAI>`。 */
  _v2BlockRe() {
    const type = (typeof SekaiRenderer !== 'undefined' && SekaiRenderer.V2_TYPE_SOURCE) || '[^\\n>]*';
    return new RegExp(`<\\$SEKAI:${type}:[^\\n>]*>\\r?\\n[\\s\\S]*?^<&SEKAI>\\s*$`, 'gm');
  }

  extractPlainTextForReply(text) {
    if (!text) return '';

    let plainText = text;

    // --- SEKAI v2 ---
    // Multi-line blocks: drop entirely (code etc.)
    plainText = plainText.replace(this._v2BlockRe(), '');

    // Format: try to keep decoded payload text
    plainText = plainText.replace(/<\$SEKAI:Format:([^>]*):([^>]*)>/gi, (_, desc, payload) => {
      if (/enc=base64/i.test(desc) && this.sekaiRenderer) {
        try {
          return this.sekaiRenderer.base64DecodeUtf8(payload);
        } catch (_) { /* fall through */ }
      }
      return payload || '';
    });

    // Mention: keep display name if present
    plainText = plainText.replace(/<\$SEKAI:Mention:([^>]*):([^>]*)>/gi, (_, desc, payload) => {
      const m = /(?:^|;)display=([^;]*)/.exec(desc);
      if (m) {
        try { return '@' + decodeURIComponent(m[1].replace(/\+/g, '%20')); }
        catch { return '@' + m[1]; }
      }
      return payload ? '@' + payload : '';
    });

    // Other single-line v2 tokens — remove
    plainText = plainText.replace(this._v2TokenRe('g'), '');

    // --- SEKAI v1 ---
    // 1. 移除嵌套回复标记 [re:timestamp|preview]
    plainText = plainText.replace(/\[re:[^\]]+\]/g, '');

    // 2. 处理有文本内容的 SEKAI 标记
    plainText = plainText.replace(/\[(color|truecolor):([^|\]]+)\|([^\]]+)\]/g, '$3');
    plainText = plainText.replace(/\[img:[^|\]]+\|([^\]]+)\]/g, '$1');
    plainText = plainText.replace(/\[link:[^|\]]+\|([^\]]+)\]/g, '$1');

    // 3. 移除其他 SEKAI 标记（stamp, file, audio, code 等）
    plainText = plainText.replace(/\[(\w+):([^\]]+)\]/g, '');

    // 4. 移除 Markdown 格式标记
    plainText = plainText.replace(/\*\*(.+?)\*\*/g, '$1');
    plainText = plainText.replace(/\*(.+?)\*/g, '$1');
    plainText = plainText.replace(/~~(.+?)~~/g, '$1');
    plainText = plainText.replace(/\|\|(.+?)\|\|/g, '$1');
    plainText = plainText.replace(/`(.+?)`/g, '$1');
    plainText = plainText.replace(/^>\s+/gm, '');

    // 5. 清理多余空白
    plainText = plainText.trim();

    return plainText;
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
