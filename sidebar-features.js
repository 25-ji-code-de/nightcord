/* SPDX-License-Identifier: AGPL-3.0-only */
(function (global) {
  'use strict';
  const TITLES = { search: '搜索', inbox: '收件箱', tasks: '任务', help: '帮助' };
  const PAGE_SIZE = 50;
  const HELP = [
    ['搜索聊天记录', '在搜索中输入关键词，可按发送者和日期筛选，点击结果回到原消息。搜索范围是当前房间已加载的聊天记录，包括本浏览器保存的历史；不包含尚未加载的服务器记录。Ctrl / ⌘ + K 可快速打开搜索。'],
    ['收件箱与 @ 提及', '收件箱汇总当前房间中提及你和 @everyone 的消息。自己的消息和 AI 回复不会计入。可筛选未读、逐条标记已读或未读，也可全部标为已读。打开收件箱本身不会清除未读数，点击消息后才标为已读。已读状态保存在当前浏览器。'],
    ['管理我的任务', '任务属于当前身份和当前房间，仅保存在此浏览器。输入标题并选择可选的截止日期即可添加；支持编辑、完成、重新打开、删除和撤销删除。清除浏览器站点数据会删除这些任务。'],
    ['发送消息、表情与附件', 'Enter 发送消息，Shift + Enter 换行，每条最多 256 字。输入 @ 选择成员或 AI，输入 :: 选择表情。输入框旁的附件按钮可上传图片、音乐或文件。点击消息的回复按钮可引用原消息。'],
    ['账号和成员资料', '点击成员头像或昵称查看资料。点击侧边栏底部自己的头像可修改访客昵称，或前往 SEKAI Pass 编辑账号资料。访客身份依赖浏览器 Cookie；同名成员仍是不同身份。'],
    ['语音聊天', '房间语音目前在测试房间开放，需 SEKAI Pass 登录。加入后可控制麦克风、收听和退出通话；请允许浏览器访问麦克风。侧边栏的摄像头图标目前仅显示状态。'],
    ['外观与导航', '齿轮按钮打开设置，可调整配色和成员列表样式。双箭头展开或收起成员列表，主页回到聊天底部。搜索、收件箱、任务和帮助在主内容区打开，按 Escape 或点击返回聊天可退出。手机上点顶栏菜单切换功能。'],
    ['连接或保存失败', '网络断开后会自动重连。无法发送时先等待连接恢复；登录失效时重新登录。若提示无法保存，请检查是否禁用了站点存储或存储空间已满；未能保存的任务和已读状态仅在当前页面保留。'],
    ['私信', '私信入口暂未开放，架构确定后再接入。当前聊天区的消息会发送给房间内所有成员。'],
  ];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action, className = 'tool-button') {
    const node = element('button', className, text);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
  }
  function field(label, type, id, parent) {
    const wrapper = element('label', 'tool-field');
    wrapper.append(element('span', 'tool-field-label', label));
    const input = element('input'); input.type = type; input.id = id;
    wrapper.append(input); parent.append(wrapper);
    return input;
  }
  const messageKey = message => `${message.timestamp}:${message.profile?.id || message.user}`;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));

  class SidebarFeatures {
    constructor(ui) {
      this.ui = ui;
      this.memory = new Map();
      this.unsaved = new Set();
      this.kind = null;
      this.limit = PAGE_SIZE;
      this.inboxFilter = 'all';
      this.taskFilter = 'all';
      for (const kind of Object.keys(TITLES)) {
        const navigation = document.querySelector(`#navigation-${kind}`);
        navigation?.removeAttribute('aria-haspopup');
        navigation?.addEventListener('click', () => this.open(kind));
      }
      for (const id of ['navigation-chat', 'navigation-channel', 'navigation-mentions']) {
        document.querySelector(`#${id}`)?.addEventListener('click', () => this.close(false), true);
      }
      document.addEventListener('reply-jump', () => this.close(false), true);
      for (const event of ['message:received', 'room:ready', 'room:synced', 'room:changed', 'session:updated', 'session:unavailable']) {
        ui.eventBus.on(event, () => this.scheduleRefresh());
      }
      global.addEventListener('storage', event => {
        if (event.key === null || event.key === this.key()) {
          if (event.key === null) { this.memory.clear(); this.unsaved.clear(); }
          else { this.memory.delete(event.key); this.unsaved.delete(event.key); }
          this.scheduleRefresh();
        }
      });
      document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.isComposing
          && !document.querySelector('dialog[open], .name-chooser:not(.hidden)')) {
          event.preventDefault(); this.open('search');
        }
      });
      // 导航按钮的 aria-controls 与面板的 aria-labelledby 需要目标一开始就存在
      this.ensurePanel();
    }

    key() {
      return this.ui.currentUser?.id && this.ui.currentRoom
        ? `nightcord-sidebar:${encodeURIComponent(this.ui.currentRoom)}:${encodeURIComponent(this.ui.currentUser.id)}` : null;
    }

    read() {
      const key = this.key();
      if (!key) return { tasks: [], read: {} };
      if (this.unsaved.has(key)) return this.memory.get(key);
      let data;
      try { data = JSON.parse(localStorage.getItem(key) || '{}'); }
      catch { this.storageError = true; return this.memory.get(key) || { tasks: [], read: {} }; }
      const tasks = (Array.isArray(data?.tasks) ? data.tasks : []).filter(task => task && typeof task.id === 'string'
        && typeof task.title === 'string' && task.title.trim()).slice(0, 200).map(task => ({
        id: task.id.slice(0, 80), title: task.title.slice(0, 200), done: task.done === true, due: validDate(task.due) ? task.due : '',
      }));
      const read = Object.fromEntries(Object.entries(data?.read && typeof data.read === 'object' ? data.read : {})
        .filter(([key, value]) => key.length < 300 && value === true && Number.isFinite(Number(key.split(':')[0])))
        .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0])).slice(0, 2000));
      const state = { tasks, read };
      this.memory.set(key, state);
      return state;
    }

    save(change) {
      const key = this.key();
      if (!key) return null;
      const state = this.read();
      change(state);
      state.read = Object.fromEntries(Object.entries(state.read)
        .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0])).slice(0, 2000));
      this.memory.set(key, state);
      try {
        localStorage.setItem(key, JSON.stringify(state));
        this.unsaved.delete(key); this.storageError = false;
      } catch { this.unsaved.add(key); this.storageError = true; }
      return state;
    }

    saveTasks(change) {
      const state = this.save(change);
      if (!state) return;
      this.renderTasks(state);
      this.renderStorageWarning();
    }

    saveRead(change) {
      const mentions = this.mentions();
      const state = this.save(state => change(state.read, mentions));
      if (state) this.refresh(state, mentions);
    }

    scheduleRefresh() {
      if (this.refreshPending) return;
      this.refreshPending = true;
      queueMicrotask(() => { this.refreshPending = false; this.refresh(); });
    }

    messages() {
      return this.ui.messages.filter(message => message.user !== '系统' && !message.localNakoMessageId
        && Number.isFinite(message.timestamp) && typeof message.text === 'string');
    }

    mentions() {
      const user = this.ui.currentUser;
      if (!user) return [];
      const seen = new Set();
      return this.messages().filter(message => {
        const key = messageKey(message);
        if (!message.profile?.id || message.profile.id === user.id || message.sender || seen.has(key)
          || !this.ui.mentions?.isMentioned(message.text, user)) return false;
        seen.add(key); return true;
      }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 2000);
    }

    refresh(state = this.read(), mentions = this.mentions()) {
      const unread = mentions.filter(message => !state.read[messageKey(message)]);
      const nav = document.querySelector('#navigation-inbox');
      if (nav) {
        let badge = nav.querySelector('.navigation-badge');
        if (!badge) { badge = element('span', 'navigation-badge'); badge.setAttribute('aria-hidden', 'true'); nav.append(badge); }
        badge.textContent = unread.length > 99 ? '99+' : String(unread.length); badge.hidden = !unread.length;
        nav.setAttribute('aria-label', unread.length ? `收件箱，${unread.length} 条未读` : '收件箱');
      }
      if (!this.panel || this.panel.hidden) return;
      if (this.scope !== this.key()) {
        this.scope = this.key(); this.limit = PAGE_SIZE; this.deletedTask = null; this.editingTask = null;
        this.buildContent();
      }
      if (this.kind === 'search') this.renderSearch();
      if (this.kind === 'inbox') this.renderInbox(state, mentions, unread);
      if (this.kind === 'tasks') this.renderTasks(state);
      this.renderStorageWarning();
    }

    renderStorageWarning() {
      this.warning.textContent = this.storageError || this.unsaved.has(this.key())
        ? '浏览器存储不可用或数据无法读取，改动仅在当前页面保留。' : '';
      this.warning.hidden = !this.warning.textContent;
    }

    ensurePanel() {
      if (this.panel) return;
      this.panel = element('section', 'sidebar-tools');
      this.panel.hidden = true;
      this.panel.id = 'sidebar-tools';
      this.panel.setAttribute('aria-labelledby', 'sidebar-tools-title');
      const header = element('header', 'chat-header tools-header');
      const menu = element('button', 'tools-menu');
      menu.type = 'button';
      menu.setAttribute('aria-label', '打开导航');
      menu.setAttribute('aria-controls', 'member-sidebar');
      menu.setAttribute('aria-expanded', 'false');
      const menuIcon = document.querySelector('.sidebar-toggle svg')?.cloneNode(true);
      if (menuIcon) menu.append(menuIcon);
      this.headerIcon = element('span', 'tools-header-icon');
      this.context = element('span', 'tools-room');
      this.title = element('h1'); this.title.id = 'sidebar-tools-title';
      const close = button('返回聊天', () => this.close(), 'tools-back'); close.setAttribute('aria-label', '返回聊天');
      header.append(menu, this.headerIcon, this.title, this.context, close);
      this.content = element('div', 'tools-content');
      this.body = element('div', 'tools-body');
      this.warning = element('p', 'tools-warning'); this.warning.setAttribute('role', 'status'); this.warning.hidden = true;
      this.body.append(this.warning, this.content);
      this.panel.append(header, this.body);
      this.panel.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault(); event.stopPropagation(); this.close();
        }
      });
      this.ui.elements.main.append(this.panel);
    }

    open(kind) {
      if (!TITLES[kind]) return;
      this.ensurePanel();
      this.ui.closeMentionPicker({ restoreFocus: false });
      this.returnFocus = document.activeElement;
      if (this.panel.hidden) this.chatScrollTop = this.ui.elements.chatlog.scrollTop;
      document.querySelector(`#navigation-${this.kind}`)?.classList.remove('is-active');
      document.querySelector(`#navigation-${this.kind}`)?.removeAttribute('aria-current');
      this.kind = kind; this.scope = this.key(); this.limit = PAGE_SIZE; this.deletedTask = null; this.editingTask = null;
      this.buildContent();
      this.ui.closeNavigationDrawer?.();
      this.ui.elements.main.classList.add('tool-view');
      this.panel.hidden = false;
      this.body.scrollTop = 0;
      document.querySelector('#navigation-chat')?.removeAttribute('aria-current');
      document.querySelector(`#navigation-${kind}`)?.classList.add('is-active');
      document.querySelector(`#navigation-${kind}`)?.setAttribute('aria-current', 'page');
      this.refresh();
      (this.content.querySelector('input:not(:disabled), button:not(:disabled), summary') || this.panel.querySelector('button')).focus();
    }

    close(restoreFocus = true) {
      if (!this.panel || this.panel.hidden) return;
      this.panel.hidden = true;
      this.ui.elements.main.classList.remove('tool-view');
      this.ui.elements.chatlog.scrollTop = this.chatScrollTop || 0;
      document.querySelector(`#navigation-${this.kind}`)?.classList.remove('is-active');
      document.querySelector(`#navigation-${this.kind}`)?.removeAttribute('aria-current');
      document.querySelector('#navigation-chat')?.setAttribute('aria-current', 'page');
      if (restoreFocus) {
        const visible = node => node?.isConnected && node.getClientRects().length && !node.closest('[inert]');
        const navigation = document.querySelector(`#navigation-${this.kind}`);
        const target = visible(this.returnFocus) ? this.returnFocus
          : visible(navigation) ? navigation : document.querySelector('.sidebar-toggle');
        target?.focus({ preventScroll: true });
      }
      this.returnFocus = null;
    }

    buildContent() {
      this.title.textContent = TITLES[this.kind];
      this.panel.dataset.tool = this.kind;
      this.context.textContent = this.ui.elements.roomName?.textContent || this.ui.currentRoom || '聊天室';
      this.headerIcon.replaceChildren(document.querySelector(`#navigation-${this.kind} > svg`).cloneNode(true));
      this.content.replaceChildren();
      if (this.kind === 'search') this.buildSearch();
      if (this.kind === 'inbox') this.buildInbox();
      if (this.kind === 'tasks') this.buildTasks();
      if (this.kind === 'help') this.buildHelp();
    }

    resultsList(renderMore = () => this.refresh()) {
      this.count = element('p', 'tools-count'); this.count.setAttribute('role', 'status');
      this.list = element('div', 'tools-results');
      this.list.tabIndex = -1;
      this.more = button('加载更多', () => {
        const previous = this.limit;
        this.limit += PAGE_SIZE; renderMore();
        this.list.children[previous]?.querySelector('button, input')?.focus();
      });
      this.content.append(this.count, this.list, this.more);
    }

    replaceResults(nodes, emptyText, count) {
      const focused = this.list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
      this.list.replaceChildren(...(nodes.length ? nodes : [element('p', 'tools-empty', emptyText)]));
      this.more.hidden = count <= this.limit;
      if (focused) {
        const target = [...this.list.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focused);
        (target || this.list.querySelector('button, input') || this.list).focus({ preventScroll: true });
      }
    }

    preview(message) {
      return this.ui.extractPlainTextForReply(message.text).trim() || message.text;
    }

    messageRow(message, readState) {
      const row = element('article', 'tool-message');
      const key = messageKey(message);
      const unread = readState && !readState[key];
      row.classList.toggle('is-unread', !!unread);
      const jump = button('', () => this.jump(message, !!readState), 'tool-message-link');
      jump.dataset.focus = `jump:${key}`;
      const meta = element('span', 'tool-message-meta');
      meta.append(element('strong', '', message.user), element('time', '', this.ui.formatDate(message.timestamp)));
      const avatar = element('span', 'tool-message-avatar avatar');
      const fallback = this.ui.generateAvatar(message.user);
      avatar.classList.add(fallback.color); avatar.textContent = message.user.slice(0, 1);
      this.ui.profileUI.avatar(avatar, message.profile);
      const content = element('span', 'tool-message-content');
      content.append(meta, element('span', 'tool-message-preview', this.preview(message)));
      if (unread) meta.append(element('span', 'tool-unread-label', '未读'));
      jump.append(avatar, content);
      jump.title = '跳转到消息';
      row.append(jump);
      if (readState) {
        const toggle = button(unread ? '标为已读' : '标为未读', () => this.saveRead(read => {
          if (unread) read[key] = true; else delete read[key];
        }));
        toggle.dataset.focus = `read:${key}`; row.append(toggle);
      }
      return row;
    }

    jump(message, markRead) {
      const target = this.ui.messageIndex.get(message.timestamp);
      if (!target?.isConnected) {
        this.count.textContent = '这条消息尚未显示，请稍后重试。'; return;
      }
      if (markRead) this.saveRead(read => { read[messageKey(message)] = true; });
      this.returnFocus = null;
      this.close(); this.ui.closeNavigationDrawer?.();
      this.ui.isAtBottom = false; this.ui.updateUserActivityTime();
      target.tabIndex = -1; target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      target.classList.add('message-highlighted');
      setTimeout(() => target.classList.remove('message-highlighted'), 2000);
    }

    buildSearch() {
      const toolbar = element('div', 'tools-search-bar');
      this.query = field('关键词', 'search', 'tools-search-query', toolbar); this.query.placeholder = '搜索聊天记录';
      const icon = document.querySelector('#navigation-search > svg').cloneNode(true);
      this.query.parentElement.prepend(icon);
      const disclosure = element('details', 'tools-search-options');
      const summary = element('summary', '', '筛选');
      disclosure.append(summary);
      const filters = element('div', 'tools-filters');
      this.author = field('发送者', 'search', 'tools-search-author', filters); this.author.placeholder = '昵称或用户 ID';
      this.after = field('开始日期', 'date', 'tools-search-after', filters);
      this.before = field('结束日期', 'date', 'tools-search-before', filters);
      filters.addEventListener('input', () => { this.limit = PAGE_SIZE; this.renderSearch(); });
      this.query.addEventListener('input', () => { this.limit = PAGE_SIZE; this.renderSearch(); });
      filters.append(button('清除筛选', () => {
        for (const input of [this.query, this.author, this.after, this.before]) input.value = '';
        this.limit = PAGE_SIZE; this.renderSearch(); this.query.focus();
      }));
      disclosure.append(filters);
      this.content.append(toolbar, disclosure, element('p', 'tools-description', '当前房间 · 已加载的聊天记录'));
      this.resultsList();
    }

    renderSearch() {
      if (this.after.value && this.before.value && this.after.value > this.before.value) {
        this.count.textContent = '结束日期不能早于开始日期。';
        this.replaceResults([], '请调整日期范围。', 0); return;
      }
      const query = this.query.value.trim().toLocaleLowerCase();
      const author = this.author.value.trim().toLocaleLowerCase();
      const start = this.after.value ? new Date(`${this.after.value}T00:00:00`).getTime() : -Infinity;
      const end = this.before.value ? new Date(`${this.before.value}T23:59:59.999`).getTime() : Infinity;
      const results = this.messages().filter(message => message.timestamp >= start && message.timestamp <= end
        && (!query || `${message.text}\n${this.preview(message)}`.toLocaleLowerCase().includes(query))
        && (!author || `${message.user}\n${message.profile?.id || ''}`.toLocaleLowerCase().includes(author)))
        .sort((a, b) => b.timestamp - a.timestamp);
      this.count.textContent = `${results.length} 条结果 · 最新消息在前`;
      this.replaceResults(results.slice(0, this.limit).map(message => this.messageRow(message)), '没有找到匹配消息，试试其他关键词或筛选条件。', results.length);
    }

    filters(options, selected, onChange) {
      const group = element('div', 'tools-filter-buttons');
      for (const [value, label] of options) {
        const control = button(label, () => {
          for (const child of group.children) child.setAttribute('aria-pressed', String(child === control));
          this.limit = PAGE_SIZE; onChange(value);
        });
        control.setAttribute('aria-pressed', String(value === selected)); group.append(control);
      }
      return group;
    }

    buildInbox() {
      this.content.append(element('p', 'tools-description', '提及你的消息，都在这里。'));
      const toolbar = element('div', 'tools-inbox-toolbar');
      toolbar.append(this.filters([['all', '全部提醒'], ['unread', '只看未读']], this.inboxFilter, value => { this.inboxFilter = value; this.refresh(); }));
      this.markAll = button('全部标为已读', () => this.saveRead((read, mentions) => {
        for (const message of mentions) read[messageKey(message)] = true;
      }));
      toolbar.append(this.markAll); this.content.append(toolbar); this.resultsList();
    }

    renderInbox(state, mentions, unread) {
      const results = this.inboxFilter === 'unread' ? unread : mentions;
      this.markAll.disabled = !unread.length;
      this.count.textContent = `${unread.length} 条未读 · ${mentions.length} 条提醒`;
      this.replaceResults(results.slice(0, this.limit).map(message => this.messageRow(message, state.read)),
        !this.key() ? '连接聊天室后即可查看提及你的消息。' : this.inboxFilter === 'unread' ? '没有未读提醒。' : '还没有提及你的消息。', results.length);
    }

    buildTasks() {
      this.content.append(element('p', 'tools-description', '记下接下来要做的事。任务保存在此浏览器。'));
      this.taskForm = element('form', 'tools-task-form');
      this.taskTitle = field('任务标题', 'text', 'tools-task-title', this.taskForm); this.taskTitle.maxLength = 200; this.taskTitle.required = true;
      this.taskTitle.placeholder = '添加一件要做的事…';
      this.taskDue = field('截止日期（可选）', 'date', 'tools-task-due', this.taskForm);
      this.taskSubmit = element('button', 'tool-button tool-primary', '添加任务'); this.taskSubmit.type = 'submit';
      this.cancelEdit = button('取消编辑', () => this.resetTaskForm()); this.cancelEdit.hidden = true;
      this.taskForm.append(this.taskSubmit, this.cancelEdit);
      this.taskForm.addEventListener('submit', event => {
        event.preventDefault();
        const title = this.taskTitle.value.trim();
        if (!title) { this.taskTitle.setCustomValidity('请输入任务标题。'); this.taskTitle.reportValidity(); return; }
        const id = this.editingTask;
        const state = this.read();
        if (id && !state.tasks.some(task => task.id === id)) { this.count.textContent = '该任务已在其他标签页删除，请取消编辑。'; return; }
        if (!id && state.tasks.length >= 200) { this.count.textContent = '已达到 200 项上限，请先删除不需要的任务。'; return; }
        this.saveTasks(next => {
          const task = id ? next.tasks.find(task => task.id === id) : null;
          if (task) { task.title = title; task.due = this.taskDue.value; }
          else next.tasks.unshift({ id: crypto.randomUUID(), title, due: this.taskDue.value, done: false });
        });
        this.resetTaskForm(); this.taskTitle.focus();
      });
      this.taskTitle.addEventListener('input', () => this.taskTitle.setCustomValidity(''));
      this.content.append(this.taskForm, this.filters([['all', '全部任务'], ['active', '未完成'], ['done', '已完成']], this.taskFilter,
        value => { this.taskFilter = value; this.renderTasks(this.read()); }));
      this.undo = button('撤销删除', () => this.saveTasks(state => {
        const task = this.deletedTask;
        if (!task || state.tasks.length >= 200) return;
        if (!state.tasks.some(existing => existing.id === task.id)) state.tasks.unshift(task);
        this.deletedTask = null;
      }));
      this.undo.hidden = true; this.content.append(this.undo); this.resultsList(() => this.renderTasks(this.read()));
    }

    resetTaskForm() {
      this.editingTask = null; this.taskForm.reset(); this.taskTitle.setCustomValidity('');
      this.taskSubmit.textContent = '添加任务'; this.cancelEdit.hidden = true;
    }

    renderTasks(state) {
      const available = !!this.key();
      for (const control of this.taskForm.elements) control.disabled = !available;
      const done = state.tasks.filter(task => task.done).length;
      this.count.textContent = available ? `${done} / ${state.tasks.length} 项已完成` : '连接聊天室后即可管理自己的任务。';
      this.undo.hidden = !this.deletedTask; this.undo.disabled = state.tasks.length >= 200;
      const tasks = state.tasks.filter(task => this.taskFilter === 'all' || (this.taskFilter === 'done') === task.done);
      const rows = tasks.slice(0, this.limit).map(task => {
        const row = element('article', 'tool-task'); row.classList.toggle('is-complete', task.done);
        const label = element('label', 'tool-task-check');
        const check = element('input'); check.type = 'checkbox'; check.checked = task.done; check.dataset.focus = `task:${task.id}`;
        check.addEventListener('change', () => this.saveTasks(state => { const current = state.tasks.find(item => item.id === task.id); if (current) current.done = check.checked; }));
        label.append(check, element('span', 'tool-task-title', task.title)); row.append(label);
        if (task.due) {
          const date = element('span', 'tool-task-date', `截止 ${task.due}`);
          if (!task.done && new Date(`${task.due}T23:59:59.999`) < new Date()) { date.textContent += ' · 已逾期'; date.classList.add('is-overdue'); }
          row.append(date);
        }
        const actions = element('div', 'tool-task-actions');
        const edit = button('编辑', () => {
          this.editingTask = task.id; this.taskTitle.value = task.title; this.taskDue.value = task.due;
          this.taskSubmit.textContent = '保存修改'; this.cancelEdit.hidden = false; this.taskTitle.focus();
        }); edit.dataset.focus = `edit:${task.id}`;
        const remove = button('删除', () => {
          this.deletedTask = task;
          this.saveTasks(state => { state.tasks = state.tasks.filter(item => item.id !== task.id); });
          if (this.editingTask === task.id) this.resetTaskForm();
          this.undo.focus();
        }); remove.setAttribute('aria-label', `删除任务：${task.title}`);
        actions.append(edit, remove); row.append(actions); return row;
      });
      this.replaceResults(rows, available ? '这里还没有任务。' : '任务会在身份确认后显示。', tasks.length);
    }

    buildHelp() {
      this.content.append(element('p', 'tools-description', '关于 Nightcord，你可能想知道的事。'));
      const search = field('搜索帮助', 'search', 'tools-help-query', this.content);
      search.placeholder = '搜索使用帮助';
      const results = element('div', 'tools-help'); results.id = 'tools-help-results'; search.setAttribute('aria-controls', results.id);
      const render = () => {
        const query = search.value.trim().toLocaleLowerCase();
        results.replaceChildren();
        for (const [title, text] of HELP.filter(entry => entry.join(' ').toLocaleLowerCase().includes(query))) {
          const detail = element('details'); detail.open = !!query;
          detail.append(element('summary', '', title), element('p', '', text)); results.append(detail);
        }
        if (!results.children.length) results.append(element('p', 'tools-empty', '没有匹配的帮助内容。'));
      };
      search.addEventListener('input', render); this.content.append(results); render();
      const links = element('p', 'tools-links');
      for (const [label, url] of [['项目文档', 'https://github.com/25-ji-code-de/nightcord#readme'], ['反馈问题', 'https://github.com/25-ji-code-de/nightcord/issues']]) {
        const link = element('a', '', label); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
      }
      this.content.append(links);
    }
  }
  global.SidebarFeatures = SidebarFeatures;
})(window);
