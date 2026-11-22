/* SPDX-License-Identifier: AGPL-3.0-only */
(function (global) {
  'use strict';
  const { TITLES, PAGE_SIZE, HELP, element, button, helpEntry, externalLink, field, messageKey, validDate, timestamp, pad, localDate, localTime, durationText, listOf, safeText, punch, resume, imprint, taskIcon, clockDial, ticketNumber, timeCard, onRail } = SidebarHelpers;

  class SidebarFeatures {
    get storage() { return this._storage ||= new SidebarStorage(() => ({ room: this.ui.currentRoom, userId: this.ui.currentUser?.id })); }
    get messageTools() { return this._messageTools ||= new SidebarMessages(this); }
    get taskFormView() { return this._taskFormView ||= new TaskFormView(this); }
    get taskTickets() { return this._taskTickets ||= new TaskTicketView(this); }
    get taskSlips() { return this._taskSlips ||= new TaskSlipView(this); }
    get helpView() { return this._helpView ||= new SidebarHelpView(this); }

    get memory() { return this.storage.memory; }
    get unsaved() { return this.storage.unsaved; }
    get storageError() { return this.storage.storageError; }

    constructor(ui) {
      this.ui = ui;
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

    key(...args) { return this.storage.key(...args); }

    read(...args) { return this.storage.read(...args); }

    save(...args) { return this.storage.save(...args); }

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

    messages(...args) { return this.messageTools.messages(...args); }

    mentions(...args) { return this.messageTools.mentions(...args); }

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
        if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) {
          // The phone drawer stacks above the tool panel: Escape belongs to the
          // topmost layer, so the drawer (not the panel) is what closes.
          if (this.ui.isNavigationDrawerOpen?.()) return;
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
      clearTimeout(this.clockTick);
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
      clearTimeout(this.clockTick);
      this.selectedSlip = null;
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

    resultsList(...args) { return this.messageTools.resultsList(...args); }

    replaceResults(...args) { return this.messageTools.replaceResults(...args); }

    preview(...args) { return this.messageTools.preview(...args); }

    messageRow(...args) { return this.messageTools.messageRow(...args); }

    jump(...args) { return this.messageTools.jump(...args); }

    buildSearch(...args) { return this.messageTools.buildSearch(...args); }

    renderSearch(...args) { return this.messageTools.renderSearch(...args); }

    filters(...args) { return this.messageTools.filters(...args); }

    buildInbox(...args) { return this.messageTools.buildInbox(...args); }

    renderInbox(...args) { return this.messageTools.renderInbox(...args); }

    buildTasks(...args) { return this.taskFormView.buildTasks(...args); }

    setTaskFormOpen(...args) { return this.taskFormView.setTaskFormOpen(...args); }

    resetTaskForm(...args) { return this.taskFormView.resetTaskForm(...args); }

    scrollBehavior(...args) { return this.taskFormView.scrollBehavior(...args); }

    setPaperMode(...args) { return this.taskFormView.setPaperMode(...args); }

    renderOrderPreview(...args) { return this.taskFormView.renderOrderPreview(...args); }

    bindTicketDrop(...args) { return this.taskTickets.bindTicketDrop(...args); }

    showRackTicket(...args) { return this.taskTickets.showRackTicket(...args); }

    hangTicket(...args) { return this.taskTickets.hangTicket(...args); }

    stampTicket(...args) { return this.taskTickets.stampTicket(...args); }

    fileTicket(...args) { return this.taskTickets.fileTicket(...args); }

    redSlip(...args) { return this.taskSlips.redSlip(...args); }

    attachSlip(...args) { return this.taskSlips.attachSlip(...args); }

    bindSlipDrop(...args) { return this.taskSlips.bindSlipDrop(...args); }

    renderLooseSlips(...args) { return this.taskSlips.renderLooseSlips(...args); }

    renderPocket(...args) { return this.taskTickets.renderPocket(...args); }

    renderDrawer(...args) { return this.taskTickets.renderDrawer(...args); }

    moveTicket(...args) { return this.taskTickets.moveTicket(...args); }

    renderTasks(...args) { return this.taskTickets.renderTasks(...args); }

    ticketPaper(...args) { return this.taskTickets.ticketPaper(...args); }

    taskSheet(...args) { return this.taskTickets.taskSheet(...args); }

    taskTicket(...args) { return this.taskTickets.taskTicket(...args); }

    buildHelp(...args) { return this.helpView.buildHelp(...args); }
  }
  global.SidebarFeatures = SidebarFeatures;
})(window);
