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
 * 组装 UI 子组件，协调共享视图状态并保留对外接口
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

  // Lazy components keep the public facade usable in isolated view tests.
  get events() { return this._events ||= new ChatUIEvents(this); }
  get nameChooser() { return this._nameChooser ||= new NameChooserView(this); }
  get roomView() { return this._roomView ||= new ChatRoomView(this); }
  get rosterView() { return this._rosterView ||= new RosterView(this); }
  get messageList() { return this._messageList ||= new MessageListView(this); }
  get streamingView() { return this._streamingView ||= new StreamingMessageView(this); }
  get composer() { return this._composer ||= new ChatComposerView(this); }
  get uploads() { return this._uploads ||= new UploadView(this); }
  get attachmentMessages() {
    return this._attachmentMessages ||= new AttachmentMessageBuilder({
      percentEncode: value => this.sekaiRenderer
        ? this.sekaiRenderer.percentEncode(value) : encodeURIComponent(String(value ?? ''))
    });
  }
  get messageView() { return this._messageView ||= new ChatMessageView(this); }
  get replies() { return this._replies ||= new ReplyView(this); }
  get notifications() { return this._notifications ||= new ChatNotifications(this); }
  get mentionPicker() { return this._mentionPicker ||= new MentionPickerView(this); }
  get navigation() { return this._navigation ||= new ChatNavigation(this); }

  /** @param {EventBus} eventBus - 事件总线实例 */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.isAtBottom = true;

    // 触摸和滚动检测
    this.lastUserActivityTime = Date.now(); // 最后一次用户活动时间（触摸、滚轮、滚动等），初始化为当前时间
    this.scrollThreshold = 150; // 距离底部超过此像素数认为在阅读历史消息
    this.interactionTimeWindow = 5000; // 5秒内有用户交互活动则不自动滚动

    // 未收到服务器确认的 AI 预览；同内容的多次调用分别跟踪。
    this.localNakoMessages = new Map(); // messageId -> { message, senderId, room }

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
      roomName: document.querySelector("#navigation-channel .channel-name"),
      goPublicButton: document.querySelector("#go-public"),
      goPrivateButton: document.querySelector("#go-private"),
      chatroom: document.querySelector("#chatroom"),
      chatlog: document.querySelector("#messages"),
      chatInput: document.querySelector("#messageInput"),
      stickerButton: document.querySelector('#stickerBtn'),
      roster: document.querySelector("#online-users"),
      voiceRoster: document.querySelector("#voice-users"),
      offlineRoster: document.querySelector("#offline-users"),
      attachmentBtn: document.querySelector("#attachmentBtn"),
      fileUploadMenu: document.querySelector("#fileUploadMenu"),
      imageInput: document.querySelector("#imageInput"),
      musicInput: document.querySelector("#musicInput"),
      fileInput: document.querySelector("#fileInput"),
      uploadProgress: document.querySelector("#fileUploadProgress"),
      uploadFilename: document.querySelector("#uploadFilename"),
      uploadPercent: document.querySelector("#uploadPercent"),
      uploadFill: document.querySelector("#uploadFill"),
      navigationProfile: document.querySelector("#navigation-profile"),
      navigationAvatar: document.querySelector("#navigation-avatar"),
      navigationName: document.querySelector("#navigation-username"),
      navigationProfileInfo: document.querySelector("#navigation-profile-info"),
      mentionPicker: document.querySelector("#mention-picker"),
      mentionPickerList: document.querySelector("#mention-picker-list"),
      mentionPickerQuery: document.querySelector("#mention-picker-query"),
    };

    this.onSetUser = null;

    // 当前房间（由外部调用 setCurrentRoom / room:ready 设置）
    this.currentRoom = null;
    // 每条消息对象只保留 user/text/timestamp 存入 localStorage；渲染层会补充 avatar/color，时间由 timestamp 在渲染时计算
    this.messages = [];
    this.messageRenderFrame = null;
    this.messageRenderPending = false;
    this.pendingMessageAppends = [];
    this.messageBuild = null;
    this.lastMsgTimestamp = 0;
    this.roster = [];
    this.rosterElements = new Map();
    this.roomMembers = new Map();
    this.voiceMembers = new Map();
    this.voiceRevision = -1;
    this.localVoice = null;
    this.currentUser = null;
    this.mentionPickerOpen = false;
    this.profileUI = new NightcordProfileUI(this);

    this.systemIcon = `<svg width="24" height="24" viewBox="8 7 34 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M41 24A16 16 0 1 1 9 24A16 16 0 1 1 41 24ZM41 24A12 12 0 1 1 17 24A12 12 0 1 1 41 24ZM27 24A2 2 0 1 1 23 24A2 2 0 1 1 27 24ZM35 24A2 2 0 1 1 31 24A2 2 0 1 1 35 24Z" fill="white" fill-rule="evenodd"></path></svg>`;

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
        stickerButton: this.elements.stickerButton,
        atButton: document.querySelector('#mentionBtn'),
        getAllUsers: () => this.getAllUsers(),
        formatMention: mention => this.mentions?.format(mention) || null,
        renderAvatar: (element, profile) => this.profileUI.avatar(element, profile),
        onError: message => this.showError(message),
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
        lookupReply: (ts) => this.lookupReplyMeta(ts),
        bindMention: (element, mention) => this.bindMentionAction(element, mention)
      });
    } else {
      console.warn('SekaiRenderer not available, falling back to basic text rendering');
      this.sekaiRenderer = null;
    }
    this.mentions = typeof NightcordMentions !== 'undefined' ? new NightcordMentions(this.sekaiRenderer) : null;

    // 监听回复跳转事件
    this.setupReplyJumpListener();
  }

  lookupReplyMeta(...args) { return this.replies.lookupReplyMeta(...args); }

  setupEventListeners(...args) { return this.events.setupEventListeners(...args); }

  setupReplyJumpListener(...args) { return this.replies.setupReplyJumpListener(...args); }

  setupNakoEventListeners(...args) { return this.events.setupNakoEventListeners(...args); }

  showNameChooser(...args) { return this.nameChooser.showNameChooser(...args); }

  bindNameChooserEvents(...args) { return this.nameChooser.bindNameChooserEvents(...args); }

  setupNameChooser(...args) { return this.nameChooser.setupNameChooser(...args); }

  setCurrentRoom(...args) { return this.roomView.setCurrentRoom(...args); }

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

  setSessionUnavailable(...args) { return this.roomView.setSessionUnavailable(...args); }

  updateNavigationProfile(...args) { return this.rosterView.updateNavigationProfile(...args); }

  setConnectionStatus(...args) { return this.roomView.setConnectionStatus(...args); }

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

  renderVoiceUsers(...args) { return this.rosterView.renderVoiceUsers(...args); }

  renderMessages(...args) { return this.messageList.renderMessages(...args); }

  scheduleMessageRender(...args) { return this.messageList.scheduleMessageRender(...args); }

  flushMessageRender(...args) { return this.messageList.flushMessageRender(...args); }

  shouldAutoScrollToBottom(...args) { return this.messageList.shouldAutoScrollToBottom(...args); }

  startStreamingMessage(...args) { return this.streamingView.startStreamingMessage(...args); }

  appendStreamingContent(...args) { return this.streamingView.appendStreamingContent(...args); }

  finishStreamingMessage(...args) { return this.streamingView.finishStreamingMessage(...args); }

  confirmLocalNakoMessage(...args) { return this.streamingView.confirmLocalNakoMessage(...args); }

  setupChatRoom(...args) { return this.composer.setupChatRoom(...args); }

  setFileUploadMenuOpen(...args) { return this.uploads.setFileUploadMenuOpen(...args); }

  setupFileUpload(...args) { return this.uploads.setupFileUpload(...args); }

  _insertPlaceholder(...args) { return this.uploads._insertPlaceholder(...args); }

  _showUploadProgress(...args) { return this.uploads._showUploadProgress(...args); }

  _generateFileMessage(...args) { return this.attachmentMessages._generateFileMessage(...args); }

  _sekaiEncode(...args) { return this.attachmentMessages._sekaiEncode(...args); }

  _clipToEncodedBudget(...args) { return this.attachmentMessages._clipToEncodedBudget(...args); }

  _buildSekaiV2Token(...args) { return this.attachmentMessages._buildSekaiV2Token(...args); }

  _readImageDimensions(...args) { return this.attachmentMessages._readImageDimensions(...args); }

  _replacePlaceholderInInput(...args) { return this.uploads._replacePlaceholderInInput(...args); }

  _removePlaceholder(...args) { return this.uploads._removePlaceholder(...args); }

  handleFileUpload(...args) { return this.uploads.handleFileUpload(...args); }

  extractAudioMetadata(...args) { return this.attachmentMessages.extractAudioMetadata(...args); }

  updateUserActivityTime(...args) { return this.messageList.updateUserActivityTime(...args); }

  addChatMessage(...args) { return this.messageView.addChatMessage(...args); }

  addSystemMessage(...args) { return this.messageView.addSystemMessage(...args); }

  addUserMessage(...args) { return this.messageView.addUserMessage(...args); }

  createMessageData(...args) { return this.messageView.createMessageData(...args); }

  saveMessageToStorage(...args) { return this.messageView.saveMessageToStorage(...args); }

  appendMessageToDOM(...args) { return this.messageList.appendMessageToDOM(...args); }

  clearChatInput(...args) { return this.composer.clearChatInput(...args); }

  addUserToRoster(...args) { return this.rosterView.addUserToRoster(...args); }

  handleUserRename(...args) { return this.rosterView.handleUserRename(...args); }

  removeUserFromRoster(...args) { return this.rosterView.removeUserFromRoster(...args); }

  clearRoster(...args) { return this.rosterView.clearRoster(...args); }

  getAllUsers(...args) { return this.rosterView.getAllUsers(...args); }

  showWelcomeMessages(...args) { return this.roomView.showWelcomeMessages(...args); }

  showError(...args) { return this.notifications.showError(...args); }

  showAuthError(...args) { return this.notifications.showAuthError(...args); }
  showAuthExpired(...args) { return this.notifications.showAuthExpired(...args); }

  /**
   * 获取所有 DOM 元素引用
   * @returns {Object} DOM 元素对象
   */
  getElements() {
    return this.elements;
  }

  isMentioned(...args) { return this.mentionPicker.isMentioned(...args); }

  noticeFor(...args) { return this.events.noticeFor(...args); }

  bindMentionAction(...args) { return this.mentionPicker.bindMentionAction(...args); }

  showMentionNotice(...args) { return this.notifications.showMentionNotice(...args); }

  showReplyNotice(...args) { return this.notifications.showReplyNotice(...args); }

  clearNotices(...args) { return this.notifications.clearNotices(...args); }

  isReplyToMe(...args) { return this.replies.isReplyToMe(...args); }

  replyTargets(...args) { return this.replies.replyTargets(...args); }

  createMessageElement(...args) { return this.messageView.createMessageElement(...args); }

  createReplyButton(...args) { return this.replies.createReplyButton(...args); }

  insertReplyReference(...args) { return this.replies.insertReplyReference(...args); }

  /**
   * 从消息文本中提取纯文本内容
   * 移除嵌套回复引用和 SEKAI 标记，保留有文本意义的内容
   * @param {string} text - 原始消息文本
   * @returns {string} 纯文本内容
   * @private
   */

  _v2TokenRe(...args) { return this.replies._v2TokenRe(...args); }

  _v2BlockRe(...args) { return this.replies._v2BlockRe(...args); }

  extractPlainTextForReply(...args) { return this.replies.extractPlainTextForReply(...args); }

  formatDate(...args) { return this.messageView.formatDate(...args); }

  setupMobileMenu(...args) { return this.navigation.setupMobileMenu(...args); }

  setupMentionPicker(...args) { return this.mentionPicker.setupMentionPicker(...args); }

  openMentionPicker(...args) { return this.mentionPicker.openMentionPicker(...args); }

  closeMentionPicker(...args) { return this.mentionPicker.closeMentionPicker(...args); }

  renderMentionPicker(...args) { return this.mentionPicker.renderMentionPicker(...args); }

  mentionPickerItem(...args) { return this.mentionPicker.mentionPickerItem(...args); }

  insertPickerMention(...args) { return this.mentionPicker.insertPickerMention(...args); }
}
