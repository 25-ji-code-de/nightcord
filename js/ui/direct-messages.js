/* SPDX-License-Identifier: AGPL-3.0-only */
/** Private message navigation and rendering; never enters the public chat pipeline. */
class DirectMessageView {
  constructor(ui, manager) {
    this.ui = ui; this.manager = manager; this.filter = 'all'; this.active = null; this.viewVersion = 0;
    this.nav = document.querySelector('#navigation-dm');
    this.openFromNav = () => this.open(); this.nav?.addEventListener('click', this.openFromNav);
    this.off = [
      ui.eventBus.on('dm:updated', () => this.render()),
      ui.eventBus.on('dm:incoming', ({ conversation }) => this.incoming(conversation)),
      ui.eventBus.on('dm:synced', () => { if (this.active && !this.panel?.hidden) void this.load(); }),
    ];
    this.navigation = event => {
      if (event.target.closest('#navigation-chat, #navigation-channel, #navigation-members, #navigation-mentions, #navigation-search, #navigation-inbox, #navigation-tasks, #navigation-help')) this.close(false);
    };
    document.addEventListener('click', this.navigation, true);
    this.dismissMenus = event => {
      for (const menu of this.panel.querySelectorAll('details[open]')) if (!menu.contains(event.target)) menu.open = false;
      for (const row of this.log.querySelectorAll('.is-selected')) if (!row.contains(event.target)) row.classList.remove('is-selected');
    };
    document.addEventListener('click', this.dismissMenus);
    this.resume = () => {
      if (!document.hidden) { void this.manager.resume(); this.markRead(); }
      else void this.manager.flushReads();
    };
    this.flushReads = () => { void this.manager.flushReads(); };
    window.addEventListener('blur', this.flushReads);
    window.addEventListener('pagehide', this.flushReads);
    window.addEventListener('focus', this.resume);
    window.addEventListener('online', this.resume);
    window.addEventListener('pageshow', this.resume);
    document.addEventListener('visibilitychange', this.resume);
    this.attention = () => this.markRead(); document.addEventListener('focusin', this.attention);
    this.ensure(); this.render();
    this.atBottom = true;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.atBottom && this.log.getClientRects().length) this.log.scrollTop = this.log.scrollHeight;
      this.logHeight = this.log.clientHeight; this.contentHeight = this.log.scrollHeight;
    });
    this.resizeObserver.observe(this.log);
  }
  element(tag, className, text) {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  button(text, action, className = 'dm-button') {
    const button = this.element('button', className, text); button.type = 'button';
    button.addEventListener('click', action); return button;
  }
  icon(name) {
    const shared = { send: '[data-navigation-icon="plane"]', search: '[data-navigation-icon="search"]',
      request: '[data-navigation-icon="envelope"]', emoji: '#stickerBtn svg' };
    const existing = shared[name] && document.querySelector(shared[name]);
    if (existing) return existing.cloneNode(true);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const paths = {
      more: 'M5 12h.01M12 12h.01M19 12h.01',
      back: 'm14 6-6 6 6 6', close: 'm6 6 12 12M6 18 18 6',
      search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      reply: 'm9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7v2',
      send: 'm3 3 18 6-8 4-4 8-6-18Zm0 0 10 10',
      emoji: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M8 9h.01M16 9h.01M8 15q4 4 8 0',
      sticker: 'M13 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8l-8 8Zm0 0v-6a2 2 0 0 1 2-2h6',
      request: 'M3 5h18v14H3V5Zm0 1 9 7 9-7',
    };
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path);
    if (name === 'more') svg.setAttribute('stroke-width', '3');
    return svg;
  }
  iconButton(label, icon, action, className = 'dm-icon-button') {
    const button = this.button('', action, className);
    button.title = label; button.setAttribute('aria-label', label); button.append(this.icon(icon)); return button;
  }
  menu(label, className) {
    const menu = this.element('details', className);
    const summary = this.element('summary', 'dm-icon-button');
    summary.title = label; summary.setAttribute('aria-label', label); summary.append(this.icon('more'));
    const content = this.element('div', 'dm-menu-content');
    menu.append(summary, content); return { menu, content };
  }
  async attempt(action) {
    const current = this.currentView();
    this.error.textContent = '';
    try { return await action(); }
    catch (error) { if (current() && error.code !== 'stale_session' && error.name !== 'AbortError') this.error.textContent = error.message || '操作未完成，请重试。'; }
  }
  currentView() {
    const version = this.viewVersion, gen = this.manager.generation;
    return () => version === this.viewVersion && gen === this.manager.generation;
  }
  changeView() {
    this.viewVersion++; this.loadingActive = null; this.prepending = false; this.failedLoad = null;
    this.older.disabled = false; this.older.textContent = '加载更早的消息';
  }
  ensure() {
    this.panel = this.element('section', 'dm-panel'); this.panel.id = 'direct-messages'; this.panel.hidden = true;
    this.panel.setAttribute('aria-labelledby', 'dm-title');
    const header = this.element('header', 'chat-header dm-list-header');
    const menu = this.button('', () => {}, 'tools-menu');
    menu.setAttribute('aria-label', '打开导航'); menu.setAttribute('aria-controls', 'member-sidebar'); menu.setAttribute('aria-expanded', 'false');
    const icon = document.querySelector('.sidebar-toggle svg')?.cloneNode(true);
    if (icon) menu.append(icon);
    this.title = this.element('h1', '', '私信'); this.title.id = 'dm-title'; this.title.tabIndex = -1;
    const management = this.menu('私信管理', 'dm-manage');
    for (const [filter, label] of [['requests', '私信请求'], ['hidden', '已隐藏的会话']]) {
      management.content.append(this.button(label, () => { management.menu.open = false; this.showList(filter); }, 'dm-menu-item'));
    }
    management.content.append(this.button('返回聊天室', () => { management.menu.open = false; this.close(); }, 'dm-menu-item'));
    header.append(menu, this.title, management.menu);
    this.status = this.element('p', 'dm-status'); this.status.setAttribute('role', 'status');
    this.error = this.element('p', 'dm-error'); this.error.setAttribute('role', 'alert');
    const layout = this.element('div', 'dm-layout');
    const aside = this.element('aside', 'dm-sidebar'); aside.setAttribute('aria-label', '私信会话');
    const searchLabel = this.element('label', 'dm-search-label');
    searchLabel.append(this.icon('search'), this.element('span', 'dm-sr-only', '查找会话'));
    this.search = this.element('input', 'dm-search'); this.search.type = 'search'; this.search.placeholder = '查找会话';
    searchLabel.append(this.search); this.search.addEventListener('input', () => this.renderList());
    this.requestNotice = this.button('', () => this.showList('requests'), 'dm-request-notice');
    this.listHeading = this.element('div', 'dm-list-heading');
    this.listBack = this.iconButton('返回会话', 'back', () => this.showList('all'));
    this.listTitle = this.element('h2', '', '最近会话'); this.listTitle.tabIndex = -1;
    this.listHeading.append(this.listBack, this.listTitle);
    this.list = this.element('div', 'dm-conversations');
    this.list.setAttribute('aria-label', '会话列表');
    this.self = this.button('', () => this.manager.user && this.ui.profileUI.open(this.manager.user), 'dm-self');
    aside.append(header, searchLabel, this.requestNotice, this.listHeading, this.list, this.self);
    this.thread = this.element('section', 'dm-thread'); this.thread.setAttribute('aria-label', '私信内容');
    this.empty = this.element('div', 'dm-empty');
    this.empty.append(this.icon('send'), this.element('h2', '', '开始一段对话'),
      this.element('p', '', '从成员资料卡发起私信，或在左侧选择一段会话。'));
    this.threadHeader = this.element('header', 'chat-header dm-thread-header');
    this.request = this.element('div', 'dm-request');
    this.requestActions = this.element('div', 'dm-request-actions');
    this.older = this.button('加载更早的消息', () => void this.load(!this.failedLoad), 'dm-older dm-button');
    this.log = this.element('div', 'dm-log'); this.log.tabIndex = 0; this.log.setAttribute('aria-label', '私信消息');
    this.log.addEventListener('scroll', () => {
      // Resizing can dispatch scroll before ResizeObserver. It isn't the user
      // leaving the bottom; retain their previous reading intent for that frame.
      if (this.logHeight === this.log.clientHeight && this.contentHeight === this.log.scrollHeight) {
        this.atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 70;
      }
      this.markRead();
    }, { passive: true });
    this.form = this.element('form', 'dm-composer');
    this.reply = this.element('div', 'dm-reply');
    const box = this.element('div', 'dm-composer-box');
    const label = this.element('label', 'dm-input-label');
    label.append(this.element('span', 'dm-sr-only', '消息'));
    this.input = this.element('textarea', 'dm-input'); this.input.id = 'dm-input'; this.input.maxLength = 256; this.input.rows = 1;
    this.input.placeholder = '写一条私信…'; label.append(this.input);
    this.input.addEventListener('input', () => {
      if (this.active) this.manager.drafts.set(this.active, this.input.value);
      this.resizeInput();
    });
    this.input.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || this.autocomplete?.isOpen()) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.form.requestSubmit(); }
    });
    const footer = this.element('div', 'dm-composer-tools');
    this.emojiButton = this.iconButton('表情', 'emoji', () => {});
    this.stickerButton = this.iconButton('贴纸', 'sticker', () => {});
    this.counter = this.element('span', 'dm-counter'); this.counter.hidden = true;
    this.sendButton = this.iconButton('发送', 'send', () => {}, 'dm-icon-button dm-send'); this.sendButton.type = 'submit';
    footer.append(this.emojiButton, this.stickerButton, this.counter, this.sendButton);
    this.pickerPanel = this.element('div', 'mention-list hidden dm-picker'); this.pickerPanel.id = 'dm-picker';
    this.autocomplete = new AutocompleteManager({
      input: this.input, list: this.pickerPanel,
      pickerButtons: { emoji: this.emojiButton, sticker: this.stickerButton },
      getEmojis: () => this.ui.emojiService?.getEmojis() || [],
      getStickers: () => this.ui.stickerService?.getStickers() || [],
      onError: message => { this.error.textContent = message; }
    });
    box.append(this.reply, label, footer); this.form.append(this.pickerPanel, box);
    this.form.addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    this.thread.append(this.empty, this.threadHeader, this.older, this.log, this.requestActions, this.form);
    layout.append(aside, this.thread);
    this.panel.append(this.status, this.error, layout); this.ui.elements.main.append(this.panel);
    this.panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || this.ui.isNavigationDrawerOpen?.()) return;
      event.preventDefault();
      const expanded = this.panel.querySelector('details[open]');
      if (expanded) { expanded.open = false; expanded.querySelector('summary').focus(); }
      else if (this.autocomplete.isOpen()) { this.autocomplete.hideList(); this.input.focus(); }
      else if (this.log.contains(document.activeElement)) {
        for (const row of this.log.querySelectorAll('.is-selected')) row.classList.remove('is-selected');
        this.input.focus();
      }
      else if (this.compact() && this.panel.classList.contains('has-active')) this.showList(this.filter);
      else if (this.filter !== 'all') this.showList('all');
      else this.close();
    });
  }
  compact() { return window.matchMedia('(max-width: 768px), (max-width: 1024px) and (pointer: coarse)').matches; }
  resizeInput() {
    this.input.style.height = 'auto'; this.input.style.height = Math.min(140, this.input.scrollHeight) + 'px';
    this.counter.textContent = this.input.value.length + ' / 256'; this.counter.hidden = this.input.value.length < 200;
  }
  showList(filter = 'all') {
    this.changeView();
    this.flushReads();
    this.autocomplete.hideList();
    if (filter !== this.filter) { this.active = null; this.replyTo = null; this.reply.replaceChildren(); }
    this.filter = filter; this.search.value = ''; this.panel.classList.remove('has-active');
    this.renderList(); this.renderThread(); (filter === 'all' ? this.title : this.listTitle).focus();
  }
  open(id) {
    this.changeView(); this.dismissToast();
    if (this.panel.hidden) { this.returnFocus = document.activeElement; this.scrollTop = this.ui.elements.chatlog.scrollTop; }
    this.ui.sidebarFeatures?.close(false); this.ui.closeMentionPicker({ restoreFocus: false }); this.ui.closeNavigationDrawer?.();
    this.ui.autocomplete?.hideList();
    this.ui.elements.main.classList.add('dm-view'); this.panel.hidden = false;
    document.querySelector('#navigation-chat')?.removeAttribute('aria-current');
    this.nav?.setAttribute('aria-current', 'page'); this.nav?.classList.add('is-active');
    if (id) this.select(id);
    else if (this.compact()) this.panel.classList.remove('has-active');
    this.render();
    if (!id) this.title.focus();
  }
  close(restore = true) {
    if (this.panel.hidden) return;
    this.changeView();
    this.flushReads();
    this.panel.hidden = true; this.autocomplete.hideList();
    for (const menu of this.panel.querySelectorAll('details[open]')) menu.open = false;
    this.ui.elements.main.classList.remove('dm-view');
    this.nav?.removeAttribute('aria-current'); this.nav?.classList.remove('is-active');
    document.querySelector('#navigation-chat')?.setAttribute('aria-current', 'page');
    this.ui.elements.chatlog.scrollTop = this.scrollTop || 0;
    if (restore) {
      const focus = this.returnFocus?.isConnected && this.returnFocus.getClientRects().length ? this.returnFocus
        : this.nav?.getClientRects().length ? this.nav : document.querySelector('.sidebar-toggle');
      focus?.focus();
    }
  }
  async start(peer) {
    this.open(); this.status.textContent = '正在打开会话…';
    const current = this.currentView();
    const conversation = [...this.manager.conversations.values()].find(item => item.peer.id === peer.id)
      || await this.attempt(() => this.manager.create(peer.id, this.ui.currentRoom, this.ui.managedChat ? 'managed' : undefined));
    if (!current()) return;
    if (conversation) { this.filter = conversation.hidden ? 'hidden' : 'all'; this.select(conversation.id); }
    this.render();
  }
  select(id) {
    this.changeView();
    this.flushReads();
    this.dismissToast();
    this.active = id; this.failedLoad = null; this.replyTo = null; this.reply.replaceChildren(); this.error.textContent = ''; this.autoScroll = true; this.atBottom = true;
    const item = this.manager.conversations.get(id);
    if (item?.hidden) this.filter = 'hidden';
    else if (item && item.initiator !== this.manager.user?.id && ['pending', 'rejected'].includes(item.state)) this.filter = 'requests';
    else this.filter = 'all';
    this.panel.classList.add('has-active');
    this.input.value = this.manager.drafts.get(id) || '';
    this.autocomplete.hideList(); this.headerSignature = ''; this.logSignature = '';
    this.render(); void this.load();
    this.resizeInput();
    if (!this.compact() && !this.input.disabled) this.input.focus();
    else this.threadHeader.querySelector('h2')?.focus();
  }
  avatar(profile) {
    const fallback = this.ui.generateAvatar(profile.displayName || '?');
    const avatar = this.element('span', 'avatar dm-avatar ' + fallback.color, fallback.avatar);
    this.ui.profileUI.avatar(avatar, profile); return avatar;
  }
  render() {
    const manager = this.manager;
    if (this.toastId && manager.conversations.get(this.toastId)?.hidden) this.dismissToast();
    if (this.nav) {
      this.nav.disabled = manager.mode === 'off';
      const count = [...manager.conversations.values()].reduce((sum, item) => sum + (item.hidden ? 0 : item.unread || 0), 0);
      this.nav.setAttribute('aria-label', manager.mode === 'off' ? '私信（暂未开放）' : count ? '私信，' + count + ' 条未读' : '私信');
      let badge = this.nav.querySelector('.navigation-badge');
      if (!badge) { badge = this.element('span', 'navigation-badge'); badge.setAttribute('aria-hidden', 'true'); this.nav.append(badge); }
      badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = !count;
      this.nav.querySelector('.navigation-tooltip').textContent = manager.mode === 'off' ? '私信（暂未开放）' : '私信';
    }
    if (!manager.user) {
      this.changeView();
      this.active = null; this.input.value = ''; this.reply.replaceChildren(); this.autocomplete.hideList();
      this.dismissToast(); this.log.replaceChildren(this.request); this.error.textContent = '';
      this.threadHeader.replaceChildren(); this.request.replaceChildren(); this.requestActions.replaceChildren(); this.counter.textContent = '0 / 256';
      this.headerSignature = ''; this.logSignature = '';
      this.panel.classList.remove('has-active'); this.self.replaceChildren();
    }
    this.status.textContent = manager.mode === 'off' ? '私信暂未开放。' : !manager.user ? '请使用 SEKAI Pass 登录后查看私信。' : manager.status;
    this.status.hidden = !this.status.textContent;
    if (manager.user) {
      this.self.replaceChildren(this.avatar(manager.user), this.element('span', '', manager.user.displayName));
      this.self.setAttribute('aria-label', '查看我的资料');
    }
    this.self.hidden = !manager.user;
    this.renderList(); this.renderThread();
  }
  renderList() {
    const received = item => item.initiator !== this.manager.user?.id && ['pending', 'rejected'].includes(item.state);
    const requests = [...this.manager.conversations.values()].filter(item => !item.hidden && received(item) && item.state === 'pending').length;
    this.requestNotice.hidden = !requests || this.filter !== 'all';
    this.requestNotice.replaceChildren(this.icon('request'), this.element('span', '', '新的私信请求'), this.element('span', 'dm-count', String(requests)));
    this.listBack.hidden = this.filter === 'all';
    this.listTitle.textContent = this.filter === 'hidden' ? '已隐藏的会话' : this.filter === 'requests' ? '私信请求' : '最近会话';
    const focused = this.list.contains(document.activeElement) ? document.activeElement.dataset.conversationId : null;
    this.list.replaceChildren();
    const query = this.search.value.trim().toLowerCase();
    const conversations = [...this.manager.conversations.values()].filter(item => {
      if (this.filter === 'hidden' ? !item.hidden : item.hidden) return false;
      if (this.filter === 'requests' && !received(item)) return false;
      if (this.filter === 'all' && received(item)) return false;
      return !query || [item.peer.displayName, item.peer.username, item.peer.id].some(value => value?.toLowerCase().includes(query));
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (!conversations.length) this.list.append(this.element('p', 'dm-list-empty', query ? '没有找到会话' : this.filter === 'hidden' ? '没有隐藏的会话' : this.filter === 'requests' ? '没有待处理的私信请求' : '从成员资料卡开始一段对话。'));
    for (const item of conversations) {
      const button = this.button('', () => this.select(item.id), 'dm-conversation');
      button.dataset.conversationId = item.id; button.setAttribute('aria-current', String(item.id === this.active));
      const text = this.element('span', 'dm-conversation-text');
      const name = this.element('strong', '', item.peer.displayName);
      const detail = item.hidden ? '已隐藏 · 消息仍会保存' : item.state === 'pending'
        ? item.initiator === this.manager.user?.id ? '等待对方接受' : '收到私信请求'
        : item.state === 'rejected' ? '请求已拒绝' : item.refuseIncoming ? '已拒收对方的新消息'
        : item.peer.username ? '@' + item.peer.username : '私信';
      text.append(name, this.element('span', 'dm-conversation-detail', detail));
      const meta = this.element('span', 'dm-conversation-meta');
      if (item.lastSeq) meta.append(this.element('span', 'dm-conversation-time', this.listTime(item.updatedAt)));
      if (item.unread && !item.hidden) meta.append(this.element('span', 'dm-count', item.unread > 99 ? '99+' : String(item.unread)));
      button.append(this.avatar(item.peer), text, meta);
      this.list.append(button);
      if (focused === item.id) button.focus({ preventScroll: true });
    }
  }
  listTime(timestamp) {
    const date = new Date(timestamp), today = new Date();
    return date.toDateString() === today.toDateString() ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  renderThread() {
    const item = this.manager.conversations.get(this.active);
    this.empty.hidden = !!item;
    this.threadHeader.hidden = this.request.hidden = this.requestActions.hidden = this.log.hidden = this.form.hidden = this.older.hidden = !item;
    if (!item) {
      const requests = this.filter === 'requests';
      this.empty.replaceChildren(this.icon(requests ? 'request' : 'send'),
        this.element('h2', '', requests ? '私信请求' : this.filter === 'hidden' ? '已隐藏的会话' : '开始一段对话'),
        this.element('p', '', requests ? '选择一项请求，查看对方发送的消息，然后决定是否接受。'
          : this.filter === 'hidden' ? '选择一段会话恢复显示，即可查看隐藏期间收到的消息。' : '从成员资料卡发起私信，或在左侧选择一段会话。'));
      return;
    }
    const signature = [item.id, item.state, item.initiator, item.refuseIncoming, item.hidden, item.peer.displayName, this.manager.mode].join(':');
    if (signature !== this.headerSignature) {
      this.headerSignature = signature; this.threadHeader.replaceChildren(); this.request.replaceChildren(); this.requestActions.replaceChildren();
      const identity = this.element('div', 'dm-peer');
      const label = this.element('div', '');
      const name = this.element('h2', '', item.peer.displayName); name.tabIndex = -1;
      label.append(name, this.element('small', '', item.peer.username ? '@' + item.peer.username : '私信'));
      identity.append(this.avatar(item.peer), label);
      const { menu: settings, content: actions } = this.menu('会话设置', 'dm-settings');
      const refuse = this.button(item.refuseIncoming ? '解除拒收' : '拒收消息', () => {
        settings.open = false; void this.attempt(() => this.manager.action(item.id, 'refuse', { refuseIncoming: !item.refuseIncoming }));
      }, 'dm-menu-item');
      refuse.setAttribute('aria-pressed', String(item.refuseIncoming));
      const hide = this.button(item.hidden ? '恢复显示' : '隐藏会话', () => {
        settings.open = false; void this.attempt(() => this.hide(item.id, !item.hidden));
      }, 'dm-menu-item');
      hide.setAttribute('aria-pressed', String(item.hidden));
      for (const [button, description, key] of [
        [refuse, item.refuseIncoming ? '恢复接收对方的新消息。' : '新消息将被拦截，发送者会收到通知。', 'refuse'],
        [hide, item.hidden ? '恢复显示消息和提醒。' : '内容和通知将被隐藏，但消息仍会保存。', 'hide']
      ]) {
        const title = this.element('span', 'dm-menu-label', button.textContent);
        const detail = this.element('span', 'dm-menu-description', description);
        detail.id = 'dm-menu-' + key + '-description';
        button.setAttribute('aria-label', button.textContent); button.setAttribute('aria-describedby', detail.id);
        button.replaceChildren(title, detail); actions.append(button);
      }
      this.threadHeader.append(this.iconButton('返回会话列表', 'back', () => this.showList(this.filter), 'dm-icon-button dm-thread-back'), identity, settings);
      if (item.hidden) {
        this.requestActions.append(this.element('p', '', '会话已隐藏，新消息仍会保存，但不会提醒你。恢复显示后可查看全部记录。'));
        this.requestActions.append(this.button('恢复显示', () => void this.attempt(() => this.hide(item.id, false)), 'dm-button dm-primary'));
      } else if (item.state === 'pending' || item.state === 'rejected') {
        const incoming = item.initiator !== this.manager.user?.id;
        const caption = this.element('div', 'dm-request-caption');
        caption.append(this.icon('request'), this.element('span', '', '私信请求'));
        this.request.append(caption,
          this.element('h3', '', item.state === 'rejected' ? '请求已拒绝' : incoming ? item.peer.displayName + ' 想与你交流' : '等待对方接受'),
          this.element('p', '', item.state === 'rejected' ? '此私信请求已被拒绝。'
            : incoming ? '在决定是否接受之前，先看看对方发来的信息。' : '已发送私信请求，等待对方接受。'));
        if (incoming) {
          this.requestActions.append(this.element('p', '', item.state === 'rejected'
            ? '改变主意了？你仍然可以允许进行此对话。' : '一旦接受，你们就可以互相发送消息了。'));
          const decisions = this.element('div', 'dm-request-decisions');
          const accept = this.button(item.state === 'rejected' ? '重新允许交流' : '接受请求', () => void this.attempt(async () => {
            const current = this.currentView();
            await this.manager.action(item.id, 'accept');
            if (current()) { this.filter = 'all'; this.renderList(); this.input.focus(); }
          }));
          accept.classList.add('dm-primary');
          accept.disabled = this.manager.mode !== 'on';
          if (item.state === 'pending') {
            const reject = this.button('拒绝请求', () => void this.attempt(() => this.manager.action(item.id, 'reject')));
            reject.classList.add('dm-secondary');
            reject.disabled = this.manager.mode !== 'on'; decisions.append(reject);
          }
          decisions.append(accept); this.requestActions.append(decisions);
        }
      } else if (item.state === 'none') this.request.append(this.element('p', '', '先发一条消息介绍自己，对方接受后即可继续交流。'));
      else if (item.refuseIncoming) this.request.append(this.element('p', '', '你已拒收对方的新消息。已有记录仍然保留。'));
    }
    this.request.hidden = !this.request.childElementCount;
    this.requestActions.hidden = !this.requestActions.childElementCount;
    this.log.hidden = this.form.hidden = item.hidden;
    this.older.hidden = item.hidden || (!this.manager.moreBefore.get(item.id) && !this.failedLoad);
    this.input.disabled = this.sendButton.disabled = this.emojiButton.disabled = this.stickerButton.disabled =
      item.hidden || this.manager.mode !== 'on' || !['none', 'accepted'].includes(item.state);
    this.form.hidden = this.input.disabled;
    if (this.input.disabled) this.autocomplete.hideList();
    const messages = this.manager.messages.get(item.id) || [];
    const pending = this.manager.pending.get(item.id) || [];
    const logSignature = JSON.stringify([item.id, item.hidden, item.state, this.manager.mode, messages.map(message => message.seq), pending]);
    if (logSignature !== this.logSignature) {
      this.logSignature = logSignature;
      const bottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 70;
      const oldHeight = this.log.scrollHeight, oldTop = this.log.scrollTop;
      const existing = new Map([...this.log.children].map(node => [node.dataset.key, node]));
      const nodes = [this.request];
      const appendMessage = (message, pending = false, grouped = false) => {
        const key = item.id + (pending ? ':pending:' + message.clientMessageId : ':message:' + message.seq);
        const quote = message.replyTo && messages.find(saved => saved.seq === message.replyTo)?.text;
        const signature = JSON.stringify([message, grouped, item.state, this.manager.mode, quote]);
        let row = existing.get(key);
        if (row?.dataset.signature !== signature) row = this.message(message, item, pending, grouped);
        row.dataset.key = key; row.dataset.signature = signature; nodes.push(row);
      };
      if (!item.hidden) {
        let previous;
        for (const message of messages) {
          const day = new Date(message.timestamp).toDateString();
          if (!previous || new Date(previous.timestamp).toDateString() !== day) {
            const key = 'day:' + day;
            const divider = existing.get(key) || this.element('div', 'dm-day');
            if (!divider.childElementCount) divider.append(this.element('span', '', new Date(message.timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })));
            divider.dataset.key = key; nodes.push(divider);
          }
          const grouped = previous?.senderId === message.senderId && message.timestamp - previous.timestamp < 300000 && new Date(previous.timestamp).toDateString() === day && !message.replyTo;
          appendMessage(message, false, grouped); previous = message;
        }
        for (const message of pending) {
          if (messages.some(saved => saved.clientMessageId === message.clientMessageId && saved.senderId === this.manager.user?.id)) continue;
          appendMessage(message, true);
        }
        if (!messages.length && !pending.length && item.state === 'accepted') nodes.push(this.element('p', 'dm-message-empty', '发一条消息，打个招呼吧。'));
      }
      // Keep existing message nodes attached so incoming messages preserve
      // keyboard focus, text selection and loaded sticker images.
      const retained = new Set(nodes);
      for (const node of [...this.log.children]) if (!retained.has(node)) node.remove();
      nodes.forEach((node, index) => { if (this.log.children[index] !== node) this.log.insertBefore(node, this.log.children[index] || null); });
      if (this.prepending) this.log.scrollTop = oldTop + this.log.scrollHeight - oldHeight;
      else if (this.autoScroll && item.state === 'pending' && item.initiator !== this.manager.user?.id) {
        this.log.scrollTop = 0; this.atBottom = this.log.scrollHeight - this.log.clientHeight < 70;
      }
      else if (bottom || this.autoScroll) { this.log.scrollTop = this.log.scrollHeight; this.atBottom = true; }
      this.logHeight = this.log.clientHeight; this.contentHeight = this.log.scrollHeight;
      this.autoScroll = false;
    }
    this.markRead();
    const awaitingOwnSend = item.lastSenderId === this.manager.user?.id && this.manager.syncedSeq.has(item.id)
      && this.manager.pending.get(item.id)?.some(message => message.status === 'sending');
    if (!this.panel.hidden && !item.hidden && !awaitingOwnSend && item.lastSeq > (this.manager.syncedSeq.get(item.id) || 0)
      && !this.loadingActive && this.failedLoad !== item.id + ':' + item.lastSeq) void this.load();
  }
  message(message, conversation, pending = false, grouped = false) {
    const own = pending || message.senderId === this.manager.user?.id;
    const profile = own ? this.manager.user : conversation.peer;
    const row = this.element('article', 'dm-message' + (own ? ' dm-message-own' : '') + (grouped ? ' dm-message-grouped' : ''));
    row.tabIndex = 0;
    row.setAttribute('aria-label', profile.displayName || '你');
    if (message.seq) row.dataset.seq = message.seq;
    row.append(this.avatar(profile));
    const body = this.element('div', 'dm-message-body');
    const header = this.element('div', 'dm-message-header');
    header.append(this.element('span', 'dm-message-author', profile.displayName || '你'));
    if (message.timestamp) {
      const time = this.element('time', 'dm-message-time', new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = new Date(message.timestamp).toISOString(); time.title = new Date(message.timestamp).toLocaleString('zh-CN'); header.append(time);
    }
    body.append(header);
    const surface = this.element('div', 'dm-message-surface');
    if (message.replyTo) {
      const target = this.manager.messages.get(conversation.id)?.find(saved => saved.seq === message.replyTo);
      const quote = this.element('div', 'dm-message-reply');
      quote.append(this.icon('reply'), this.element('span', '', target ? this.quote(target, conversation) : '回复较早的消息'));
      surface.append(quote);
    }
    const content = this.element('div', 'dm-message-content');
    if (message.kind === 'sticker') {
      const parts = message.text.split('/');
      if (parts.length === 2 && parts.every(part => part && part !== '.' && part !== '..' && !/[\\\u0000-\u001f]/.test(part))) {
        const image = this.element('img', 'dm-sticker'); image.alt = '贴纸：' + parts[1]; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
        image.src = 'https://sticker.nightcord.de5.net/stickers/' + parts.map(encodeURIComponent).join('/') + '.png';
        image.addEventListener('error', () => { content.textContent = image.alt; }, { once: true }); content.append(image);
      } else content.textContent = '[无法显示的贴纸]';
      row.classList.add('dm-message-sticker');
    } else {
      if (this.ui.stickerService) content.append(this.ui.stickerService.renderTextWithStickers(message.text));
      else content.textContent = message.text;
      this.ui.emojiService?.processElement(content);
      if (/^\s*\[[^\]]+\]\s*$/.test(message.text) && content.querySelector('.sticker')) row.classList.add('dm-message-sticker');
    }
    surface.append(content); body.append(surface); row.append(body);
    if (message.timestamp && conversation.state === 'accepted' && this.manager.mode === 'on') {
      body.append(this.iconButton('回复此消息', 'reply', () => {
        this.replyTo = message.seq;
        this.reply.replaceChildren(this.icon('reply'), this.element('span', '', this.quote(message, conversation)),
          this.iconButton('取消回复', 'close', () => { this.replyTo = null; this.reply.replaceChildren(); this.input.focus(); }));
        row.classList.remove('is-selected');
        this.input.focus();
      }, 'dm-icon-button dm-reply-button'));
      row.addEventListener('click', event => { if (!event.target.closest('button') && !window.getSelection()?.toString()) row.classList.toggle('is-selected'); });
    }
    if (!message.timestamp) {
      const meta = this.element('div', 'dm-message-meta');
      meta.append(this.element('span', '', message.status === 'sending' ? '发送中…' : message.error || '发送失败'));
      if (message.status === 'failed') meta.append(this.button('重试发送', () => void this.manager.send(conversation.id, {}, message)));
      body.append(meta);
    }
    return row;
  }
  quote(message, conversation) {
    const author = message.senderId === this.manager.user?.id ? '你' : conversation.peer.displayName;
    return author + '：' + (message.kind === 'sticker' ? '[贴纸]' : message.text.replace(/\s+/g, ' ').slice(0, 70));
  }
  async load(older = false) {
    const id = this.active;
    if (!id || this.panel.hidden || !this.log.getClientRects().length || this.manager.conversations.get(id)?.hidden || this.loadingActive) return;
    const current = this.currentView(), task = {};
    this.loadingActive = task; this.prepending = older;
    this.older.disabled = true;
    let success = false;
    await this.attempt(async () => { await this.manager.history(id, older); success = true; });
    if (!current() || this.loadingActive !== task) return;
    this.loadingActive = null; this.prepending = false; this.older.disabled = false;
    if (!success) {
      this.failedLoad = id + ':' + this.manager.conversations.get(id)?.lastSeq;
      this.older.hidden = false; this.older.textContent = '重新加载消息';
    } else { this.failedLoad = null; this.older.textContent = '加载更早的消息'; }
    if (success) { this.renderThread(); this.markRead(); }
  }
  async hide(id, hidden) {
    const current = this.currentView();
    await this.manager.action(id, 'hide', { hidden });
    if (!current()) return;
    this.filter = hidden ? 'hidden' : 'all'; this.render();
    if (!hidden) await this.load();
  }
  async send(payload) {
    if (!this.active || this.input.disabled) return;
    const content = payload || { kind: 'text', text: this.input.value };
    if (!content.text.trim()) return;
    if (!payload) {
      const code = /^\s*\[([^\]\n]+)\]\s*$/.exec(content.text)?.[1];
      const sticker = code && this.ui.stickerService?.getStickers().find(item => item.code === code);
      if (sticker) { content.kind = 'sticker'; content.text = sticker.category + '/' + sticker.label; }
    }
    if (this.replyTo) content.replyTo = this.replyTo;
    const id = this.active;
    this.input.value = ''; this.manager.drafts.delete(id); this.resizeInput();
    this.replyTo = null; this.reply.replaceChildren(); this.autoScroll = true; this.autocomplete.hideList();
    // Keep the editor focused immediately. A late acknowledgement must not
    // steal focus from a dialog or another conversation.
    this.input.focus();
    await this.manager.send(id, content);
  }
  viewing() {
    return !this.panel.hidden && !this.log.hidden && !!this.log.getClientRects().length && !document.hidden && document.hasFocus()
      && !this.panel.closest('[inert]') && ![...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(node => node.getClientRects().length)
      && this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight <= 70;
  }
  markRead() {
    if (!this.active || !this.viewing()) return;
    const id = this.active, seq = this.manager.messages.get(id)?.at(-1)?.seq;
    if (!seq || seq > (this.manager.syncedSeq.get(id) || 0)) return;
    void this.manager.read(id, seq).catch(() => {});
  }
  incoming(conversation) {
    if (this.active === conversation.id && this.viewing()) { void this.load(); return; }
    this.dismissToast();
    this.toastId = conversation.id;
    this.toast = this.element('div', 'dm-toast');
    this.toast.setAttribute('role', 'status');
    this.toast.append(this.button(conversation.peer.displayName + ' 发来私信 · 查看', () => this.open(conversation.id), 'dm-toast-open'),
      this.iconButton('关闭私信提醒', 'close', () => this.dismissToast(true)));
    const schedule = () => {
      clearTimeout(this.toastTimer);
      if (this.toast?.matches(':hover, :focus-within')) return;
      this.toastTimer = setTimeout(() => this.dismissToast(), 6500);
    };
    for (const event of ['mouseenter', 'focusin']) this.toast.addEventListener(event, () => clearTimeout(this.toastTimer));
    for (const event of ['mouseleave', 'focusout']) this.toast.addEventListener(event, schedule);
    document.body.append(this.toast); schedule();
  }
  dismissToast(restoreFocus = false) {
    clearTimeout(this.toastTimer);
    if (restoreFocus && this.toast?.contains(document.activeElement)) this.nav?.focus();
    this.toast?.remove(); this.toast = null; this.toastId = null;
  }
  destroy() {
    this.changeView(); this.dismissToast(); this.nav?.removeEventListener('click', this.openFromNav);
    this.autocomplete.destroy();
    this.off.forEach(off => off?.()); this.resizeObserver.disconnect(); clearTimeout(this.toastTimer); this.toast?.remove(); this.panel.remove();
    document.removeEventListener('click', this.navigation, true); document.removeEventListener('visibilitychange', this.resume);
    document.removeEventListener('click', this.dismissMenus);
    document.removeEventListener('focusin', this.attention);
    for (const event of ['focus', 'online', 'pageshow']) window.removeEventListener(event, this.resume);
    for (const event of ['blur', 'pagehide']) window.removeEventListener(event, this.flushReads);
  }
}
