/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatUIEvents: events component; ui supplies shared presentation context. */
class ChatUIEvents {
  constructor(ui) { this.ui = ui; }
  onPublic(event, callback) {
    this.ui.eventBus.on(event, data => { if (!this.ui.managedChat) callback(data); });
  }

  /**
   * 决定一条消息该触发哪一种提醒。
   *
   * @ 优先于回复：同一条消息既回复我又 @ 我时只出卡片一条。
   *
   * @param {string} text 消息原文
   * @returns {'mention'|'reply'|null}
   */
  noticeFor(text) {
    if (this.ui.isMentioned(text)) return 'mention';
    if (this.ui.isReplyToMe(text)) return 'reply';
    return null;
  }

  /**
   * 设置事件监听器，订阅业务逻辑事件
   * @private
   */
  setupEventListeners() {
    // 设置移动端菜单
    this.ui.setupMobileMenu();

    // Subscribe to chat room events
    this.onPublic('message:received', (data) => {
      // 只存储非系统消息
      if (data.name === '系统') return;

      // 已确认消息的重放不能被误认作下一次同内容调用的回传。
      const exists = this.ui.messages.some(
        m => !m.localNakoMessageId && m.text === data.message && m.user === data.name
          && m.profile?.id === data.user?.id && m.sender?.id === data.sender?.id && m.timestamp === data.timestamp
      );
      if (exists) return;

      // 回传确认原预览，使用服务器时间和实际代发者，不能直接丢弃。
      if (data.isNako && this.ui.confirmLocalNakoMessage(data)) return;

      this.ui.addChatMessage(data.name, data.message, data.timestamp, undefined, undefined, data.user, data.sender);
      const repeated = data.repeated || this.ui.messageFolds?.repeated({ timestamp: data.timestamp });
      // 提醒路由：同一条消息既回复我又 @ 我时，@ 赢 —— 一个人点一下给两条提醒是噪音。
      if (!repeated && this.ui.mentionsReady && !data.isNako && this.ui.currentUser?.id && data.user?.id
          && data.user.id !== this.ui.currentUser.id) {
        const kind = this.noticeFor(data.message);
        if (kind === 'mention') {
          if (!this.ui.alerts) this.ui.showMentionNotice(data);
          this.ui.eventBus.emit('message:mentioned', data);
        } else if (kind === 'reply') {
          if (!this.ui.alerts) this.ui.showReplyNotice(data);
          this.ui.eventBus.emit('message:replied', data);
        }
      }
      this.ui.alerts?.receive({ ...data, repeated });
    });
    this.onPublic('message:error', (data) => this.ui.showError(data.error));
    this.onPublic('message:sent', () => this.ui.clearChatInput());
    this.onPublic('message:notice', ({ message }) => this.ui.addSystemMessage(message));
    this.onPublic('user:joined', (data) => this.ui.addUserToRoster(data.username, data.user));
    this.onPublic('user:quit', (data) => this.ui.removeUserFromRoster(data.username, data.userId));
    this.ui.eventBus.on('session:updated', (data) => {
      const previousId = this.ui.currentUser?.id;
      if (previousId !== data.user.id) this.ui.clearNotices();
      this.ui.currentUser = data.user;
      this.ui.updateNavigationProfile();
      if (this.ui.managedChat) return;
      if (!data.visibility || data.visibility === 'online') this.ui.addUserToRoster(data.user.displayName, data.user);
      else {
        if (data.visibility === 'hidden') this.ui.roomMembers.delete(data.user.id);
        this.ui.removeUserFromRoster(data.user.displayName, data.user.id);
      }
      if (previousId !== data.user.id && this.ui.messages.length && this.ui.elements?.chatlog) this.ui.renderMessages();
    });
    this.onPublic('user:profile', (data) => this.ui.addUserToRoster(data.user.displayName, data.user));
    this.onPublic('room:visibility', state => {
      this.ui.roomVisibility = state;
      this.ui.alerts?.view.refreshVisibility();
    });
    this.onPublic('user:rename', (data) => this.ui.handleUserRename(data.oldUsername, data.newUsername));
    this.onPublic('room:members', ({ users }) => {
      this.ui.roomMembers = new Map((users || []).filter(user => user.authenticated && user.id?.startsWith('sekai:')).map(user => [user.id, user]));
      this.ui.renderVoiceUsers();
    });
    this.ui.eventBus.on('voice:state', ({ snapshot }) => {
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < this.ui.voiceRevision || !Array.isArray(snapshot.members)) return;
      this.ui.voiceRevision = snapshot.revision;
      this.ui.voiceMembers = new Map(snapshot.members.map(member => [member.user.id, member]));
      this.ui.renderVoiceUsers();
    });
    this.ui.eventBus.on('voice:changed', state => {
      this.ui.localVoice = state.joined ? { memberId: state.memberId, microphone: state.microphone } : null;
      const indicator = document.querySelector('#navigation-microphone');
      const label = state.joined ? state.microphone ? '麦克风已开启' : '麦克风已静音' : '未加入语音';
      indicator?.querySelector('svg')?.classList.toggle('is-active', !!(state.joined && state.microphone));
      indicator?.setAttribute('aria-label', label);
      if (indicator) indicator.title = label;
      this.ui.renderVoiceUsers();
    });
    this.ui.eventBus.on('voice:activity', ids => {
      for (const row of this.ui.elements.voiceRoster.children) row.classList.toggle('is-speaking', ids.includes(row.dataset.memberId));
    });
    this.onPublic('roster:clear', () => {
      this.ui.clearRoster();
      this.ui.mentionsReady = false;
      this.ui.clearNotices();
    });
    this.onPublic('room:left', () => {
      this.ui.mentionsReady = false;
      this.ui.clearNotices();
      this.ui.setConnectionStatus('已断开连接');
    });
    this.onPublic('room:joining', () => this.ui.setConnectionStatus('正在连接…'));
    for (const event of ['room:changed', 'session:unavailable']) {
      this.ui.eventBus.on(event, () => this.ui.clearNotices());
    }
    this.onPublic('connection:error', () => this.ui.setConnectionStatus('连接失败，正在重试…'));
    this.onPublic('connection:close', () => this.ui.setConnectionStatus('连接中断，正在重试…'));
    this.onPublic('room:ready', (data) => {
      this.ui.setConnectionStatus('');
      // room:synced also runs after reconnects, when the welcome is already shown.
      this.ui.mentionsReady = true;
      // data.messages 为服务器返回的最新100条消息，格式应为 [{user, text, timestamp}, ...]
      const room = data.roomname || this.ui.currentRoom || 'nightcord-default';
      this.ui.currentRoom = room;
      let serverMsgs = Array.isArray(data.messages) ? data.messages : [];
      // 只保留非系统消息
      serverMsgs = serverMsgs.filter(m => m.user !== '系统');
      // 取本地消息中比服务器最早一条还早的部分
      let localMsgs = ((this.ui.storage ? this.ui.storage.loadMessages(room) : this.ui.loadLocalMessages(room)) || [])
        .filter(m => m.user !== '系统');
      if (serverMsgs.length > 0 && localMsgs.length > 0) {
        const minServerTs = Math.min(...serverMsgs.map(m => m.timestamp));
        // 只取比服务器最早一条还早的本地消息
        localMsgs = localMsgs.filter(m => m.timestamp < minServerTs);
      }
      // 合并：本地早期消息 + 服务器消息
      this.ui.messages = [...localMsgs, ...serverMsgs].map(m => {
        // 兼容老数据
        const { user, text, timestamp } = m;
        const { name, avatar, color } = this.ui.generateAvatar(user);
        return {
          user: name,
          avatar,
          color,
          text,
          timestamp,
          profile: m.profile,
          sender: m.sender
        };
      });
      // 先记录聊天历史的时间戳，避免欢迎提示推进同步游标。
      if (this.ui.messages.length > 0) {
        const lastTs = this.ui.messages[this.ui.messages.length - 1].timestamp;
        if (this.ui.storage) this.ui.storage.setLastMsgTimestamp(room, lastTs); else this.ui.setLastMsgTimestamp(room, lastTs);
      }
      this.ui.showWelcomeMessages(data);
      this.ui.renderMessages();
    });
    this.ui.eventBus.on('error', (data) => this.ui.showError(data.message));
    this.onPublic('room:synced', () => { this.ui.mentionsReady = true; this.ui.setConnectionStatus(''); });

    // Nako AI 事件监听
    this.setupNakoEventListeners();
  }

  /**
   * 设置 Nako AI 事件监听器
   * @private
   */
  setupNakoEventListeners() {
    // Nako 开始回复
    this.onPublic('nako:stream:start', (data) => {
      this.ui.startStreamingMessage(data.messageId, data.user);
    });

    // Nako 流式片段
    this.onPublic('nako:stream:chunk', (data) => {
      this.ui.appendStreamingContent(data.messageId, data.chunk);
    });

    // Nako 完成回复
    this.onPublic('nako:stream:end', (data) => {
      // 去掉开头和结尾的换行符
      const cleanContent = data.fullContent.trim();
      const reasoning = data.reasoning || ''; // 思考过程

      // 完成流式显示
      this.ui.finishStreamingMessage(data.messageId, data.user, cleanContent, reasoning);


    });

    // Nako 错误
    this.onPublic('nako:error', (data) => {
      this.ui.showError(`Nako: ${data.error}`);

      // 移除流式消息
      if (data.messageId) {
        this.ui.streamingView.cancelStreamingMessage(data.messageId);
      }
    });

    // Nako 取消
    this.onPublic('nako:cancelled', (data) => {
      // 移除流式消息
      if (data.messageId) {
        this.ui.streamingView.cancelStreamingMessage(data.messageId);
      }
    });
  }
}
