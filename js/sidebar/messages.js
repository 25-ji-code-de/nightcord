/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SidebarMessages: messageTools component; sidebar supplies shared presentation context. */
const SidebarMessages = (() => {
const { PAGE_SIZE, element, button, field, messageKey, timestamp } = SidebarHelpers;
return class SidebarMessages {
  constructor(sidebar) { this.sidebar = sidebar; }

  messages() {
    return this.sidebar.ui.messages.filter(message => message.user !== '系统' && !message.localNakoMessageId
      && Number.isFinite(message.timestamp) && typeof message.text === 'string');
  }

  mentions() {
    const user = this.sidebar.ui.currentUser;
    if (!user) return [];
    const seen = new Set();
    const messages = new Map(this.messages().map(message => [Number(message.replyKey || message.timestamp), message]));
    return this.messages().filter(message => {
      const key = messageKey(message);
      if (!message.profile?.id || message.profile.id === user.id || message.sender || seen.has(key)
        || !(this.sidebar.ui.alerts ? this.sidebar.ui.alerts.reasons(message, ts => messages.get(ts)).some(kind => kind !== 'message')
          : this.sidebar.ui.mentions?.isMentioned(message.text, user))) return false;
      seen.add(key); return true;
    }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 2000);
  }

  resultsList(renderMore = () => this.sidebar.refresh()) {
    this.sidebar.count = element('p', 'tools-count'); this.sidebar.count.setAttribute('role', 'status');
    this.sidebar.list = element('div', 'tools-results');
    this.sidebar.list.tabIndex = -1;
    this.sidebar.more = button('加载更多', () => {
      const previous = this.sidebar.limit;
      this.sidebar.limit += PAGE_SIZE; renderMore();
      this.sidebar.list.children[previous]?.querySelector('button, input')?.focus();
    });
    this.sidebar.content.append(this.sidebar.count, this.sidebar.list, this.sidebar.more);
  }

  replaceResults(nodes, emptyText, count) {
    const focused = this.sidebar.list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    this.sidebar.list.replaceChildren(...(nodes.length ? nodes : [element('p', 'tools-empty', emptyText)]));
    this.sidebar.more.hidden = count <= this.sidebar.limit;
    if (focused) {
      const target = [...this.sidebar.list.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focused);
      (target || this.sidebar.list.querySelector('button, input') || this.sidebar.list).focus({ preventScroll: true });
    }
  }

  preview(message) {
    return this.sidebar.ui.extractPlainTextForReply(message.text).trim() || message.text;
  }

  messageRow(message, readState) {
    const row = element('article', 'tool-message');
    const key = messageKey(message);
    const unread = readState && !readState[key];
    row.classList.toggle('is-unread', !!unread);
    const jump = button('', () => this.jump(message, !!readState), 'tool-message-link');
    jump.dataset.focus = `jump:${key}`;
    const meta = element('span', 'tool-message-meta');
    meta.append(element('strong', '', message.user), element('time', '', this.sidebar.ui.formatDate(message.timestamp)));
    const avatar = element('span', 'tool-message-avatar avatar');
    const fallback = this.sidebar.ui.generateAvatar(message.user);
    avatar.classList.add(fallback.color); avatar.textContent = message.user.slice(0, 1);
    this.sidebar.ui.profileUI.avatar(avatar, message.profile);
    const content = element('span', 'tool-message-content');
    content.append(meta, element('span', 'tool-message-preview', this.preview(message)));
    if (unread) meta.append(element('span', 'tool-unread-label', '未读'));
    if (readState && this.sidebar.ui.alerts) {
      const labels = this.sidebar.ui.alerts.reasons(message).filter(kind => kind !== 'message').map(kind => MessageAlerts.labels[kind]);
      meta.append(element('span', 'tool-alert-kind', labels.join(' · ')));
    }
    jump.append(avatar, content);
    jump.title = '跳转到消息';
    row.append(jump);
    if (readState) {
      const toggle = button(unread ? '标为已读' : '标为未读', () => this.sidebar.saveRead(read => {
        if (unread) read[key] = true; else delete read[key];
      }));
      toggle.dataset.focus = `read:${key}`; row.append(toggle);
    }
    return row;
  }

  jump(message, markRead) {
    const target = this.sidebar.ui.messageIndex.get(message.timestamp);
    if (!target?.isConnected) {
      this.sidebar.count.textContent = '这条消息尚未显示，请稍后重试。'; return;
    }
    if (markRead) this.sidebar.saveRead(read => { read[messageKey(message)] = true; });
    this.sidebar.returnFocus = null;
    this.sidebar.close(); this.sidebar.ui.closeNavigationDrawer?.();
    this.sidebar.ui.isAtBottom = false; this.sidebar.ui.updateUserActivityTime();
    target.tabIndex = -1; target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.classList.add('message-highlighted');
    setTimeout(() => target.classList.remove('message-highlighted'), 2000);
  }

  buildSearch() {
    const toolbar = element('div', 'tools-search-bar');
    this.sidebar.query = field('关键词', 'search', 'tools-search-query', toolbar); this.sidebar.query.placeholder = '搜索聊天记录';
    const icon = document.querySelector('#navigation-search > svg').cloneNode(true);
    this.sidebar.query.parentElement.prepend(icon);
    const disclosure = element('details', 'tools-search-options');
    const summary = element('summary', '', '筛选');
    disclosure.append(summary);
    const filters = element('div', 'tools-filters');
    this.sidebar.author = field('发送者', 'search', 'tools-search-author', filters); this.sidebar.author.placeholder = '昵称或用户 ID';
    this.sidebar.after = field('开始日期', 'date', 'tools-search-after', filters);
    this.sidebar.before = field('结束日期', 'date', 'tools-search-before', filters);
    filters.addEventListener('input', () => { this.sidebar.limit = PAGE_SIZE; this.renderSearch(); });
    this.sidebar.query.addEventListener('input', () => { this.sidebar.limit = PAGE_SIZE; this.renderSearch(); });
    filters.append(button('清除筛选', () => {
      for (const input of [this.sidebar.query, this.sidebar.author, this.sidebar.after, this.sidebar.before]) input.value = '';
      this.sidebar.limit = PAGE_SIZE; this.renderSearch(); this.sidebar.query.focus();
    }));
    disclosure.append(filters);
    this.sidebar.content.append(toolbar, disclosure, element('p', 'tools-description', '当前房间 · 已加载的聊天记录'));
    this.resultsList();
  }

  renderSearch() {
    if (this.sidebar.after.value && this.sidebar.before.value && this.sidebar.after.value > this.sidebar.before.value) {
      this.sidebar.count.textContent = '结束日期不能早于开始日期。';
      this.replaceResults([], '请调整日期范围。', 0); return;
    }
    const query = this.sidebar.query.value.trim().toLocaleLowerCase();
    const author = this.sidebar.author.value.trim().toLocaleLowerCase();
    const start = this.sidebar.after.value ? new Date(`${this.sidebar.after.value}T00:00:00`).getTime() : -Infinity;
    const end = this.sidebar.before.value ? new Date(`${this.sidebar.before.value}T23:59:59.999`).getTime() : Infinity;
    const results = this.messages().filter(message => message.timestamp >= start && message.timestamp <= end
      && (!query || `${message.text}\n${this.preview(message)}`.toLocaleLowerCase().includes(query))
      && (!author || `${message.user}\n${message.profile?.id || ''}`.toLocaleLowerCase().includes(author)))
      .sort((a, b) => b.timestamp - a.timestamp);
    this.sidebar.count.textContent = `${results.length} 条结果 · 最新消息在前`;
    this.replaceResults(results.slice(0, this.sidebar.limit).map(message => this.messageRow(message)), '没有找到匹配消息，试试其他关键词或筛选条件。', results.length);
  }

  filters(options, selected, onChange) {
    const group = element('div', 'tools-filter-buttons');
    for (const [value, label] of options) {
      const control = button(label, () => {
        for (const child of group.children) child.setAttribute('aria-pressed', String(child === control));
        this.sidebar.limit = PAGE_SIZE; onChange(value);
      });
      control.setAttribute('aria-pressed', String(value === selected)); group.append(control);
    }
    return group;
  }

  buildInbox() {
    this.sidebar.content.append(element('p', 'tools-description', '回复与提及你的消息，都在这里。'));
    const toolbar = element('div', 'tools-inbox-toolbar');
    toolbar.append(this.filters([['all', '全部提醒'], ['unread', '只看未读']], this.sidebar.inboxFilter, value => { this.sidebar.inboxFilter = value; this.sidebar.refresh(); }));
    toolbar.append(this.filters([['all', '所有类型'], ['mention', '@ 我'], ['reply', '回复我'], ['everyone', '全体提及']], this.sidebar.inboxKind || 'all', value => { this.sidebar.inboxKind = value; this.sidebar.refresh(); }));
    this.sidebar.markAll = button('全部标为已读', () => this.sidebar.saveRead((read, mentions) => {
      for (const message of mentions) read[messageKey(message)] = true;
    }));
    toolbar.append(this.sidebar.markAll); this.sidebar.content.append(toolbar); this.resultsList();
  }

  renderInbox(state, mentions, unread) {
    let results = this.sidebar.inboxFilter === 'unread' ? unread : mentions;
    if (this.sidebar.inboxKind && this.sidebar.inboxKind !== 'all') {
      results = results.filter(message => this.sidebar.ui.alerts?.reasons(message).includes(this.sidebar.inboxKind));
    }
    this.sidebar.markAll.disabled = !unread.length;
    this.sidebar.count.textContent = `${unread.length} 条未读 · ${mentions.length} 条提醒`;
    this.replaceResults(results.slice(0, this.sidebar.limit).map(message => this.messageRow(message, state.read)),
      !this.sidebar.key() ? '连接聊天室后即可查看回复与提及。' : this.sidebar.inboxFilter === 'unread' ? '没有未读提醒。' : '没有符合条件的回复或提及。', results.length);
  }
};
})();
