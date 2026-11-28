/* SPDX-License-Identifier: AGPL-3.0-only */
class RoomsView {
  constructor(ui, manager, options = {}) {
    this.ui = ui; this.manager = manager; this.options = options; this.settings = new RoomSettingsView(this); this.chat = new ManagedChatView(this);
    this.panel = this.element('section', 'rooms-panel'); this.panel.hidden = true; this.panel.id = 'managed-rooms';
    this.panel.setAttribute('aria-labelledby', 'rooms-title'); this.viewRevision = 0;
    const bar = this.element('header', 'rooms-header');
    const navigation = this.iconButton('导航', 'menu', () => {}); navigation.setAttribute('aria-controls', 'member-sidebar'); navigation.setAttribute('aria-expanded', 'false');
    this.title = this.element('h1', '', '房间大厅'); this.title.id = 'rooms-title'; this.title.tabIndex = -1;
    this.backAction = () => void this.lobby();
    this.back = this.button('返回大厅', () => this.backAction(), 'rooms-button rooms-back'); this.back.prepend(this.icon('back'));
    const official = this.button('返回官方频道', () => { this.close(); this.options.official?.(); this.ui.elements.chatInput?.focus(); }, 'rooms-button rooms-official-back');
    official.prepend(this.icon('back'));
    this.official = official; this.context = this.element('span', 'room-header-context');
    bar.append(navigation, this.icon('rooms'), this.title, this.context, this.back, official);
    this.status = this.element('p', 'rooms-status'); this.status.setAttribute('role', 'status');
    this.error = this.element('p', 'rooms-error'); this.error.setAttribute('role', 'alert');
    this.content = this.element('div', 'rooms-content');
    const body = this.element('div', 'rooms-body'); this.body = body; body.append(this.status, this.error, this.content);
    this.panel.append(bar, body); ui.elements.main.append(this.panel);
    this.nav = document.querySelector('#navigation-rooms'); this.nav?.addEventListener('click', () => void this.lobby());
    this.off = ui.eventBus.on('rooms:updated', () => {
      const previousRole = this.viewRole; this.viewRole = manager.role;
      this.status.textContent = manager.status;
      if (manager.config && ui.officialRooms !== manager.config.official) {
        ui.officialRooms = manager.config.official; ui.roomView.updateHeading();
      }
      if (this.viewGeneration !== manager.roomGeneration) { this.viewGeneration = manager.roomGeneration; this.settings.admin.reset(); if (ui.managedChat) this.chat.clear(); this.content.replaceChildren(); this.threadId = null; }
      this.chat.update();
      if (this.showingRoom) this.renderRoom();
      else if (ui.managedChat && !manager.room) this.renderRoom();
      else if (!this.panel.hidden && manager.room && manager.role && previousRole !== manager.role
        && ['details', 'members', 'settings', 'invites'].includes(this.panel.dataset.page)) this.details();
      if (RoomDestination.pending && manager.user && !this.restoring) {
        this.restoring = true; const pending = RoomDestination.pending; RoomDestination.clear();
        void this.enter(pending.id, pending.secret).finally(() => { this.restoring = false; });
      }
    });
    this.navigation = event => {
      const target = event.target.closest('#navigation-rooms, #navigation-chat, #navigation-channel, #navigation-dm, #navigation-search, #navigation-inbox, #navigation-tasks, #navigation-help, #navigation-mentions, #navigation-members');
      if (!target) return;
      const admin = this.settings.admin;
      if (!this.panel.hidden && (admin.pending || admin.dirty?.())) {
        event.preventDefault(); event.stopImmediatePropagation(); admin.guard(() => target.click()); return;
      }
      if (target.id === 'navigation-rooms') return;
      if (ui.managedChat && manager.room) {
        if (target.id === 'navigation-dm') return;
        if (!this.panel.hidden) this.renderRoom();
        return;
      }
      if (!this.panel.hidden || ui.managedChat) { this.close(); if (target.id !== 'navigation-dm') this.options.official?.(); }
    };
    document.addEventListener('click', this.navigation, true);
    this.panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]') || ui.isNavigationDrawerOpen?.()) return;
      const menu = this.panel.querySelector('details[open]');
      event.preventDefault(); event.stopPropagation();
      if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
      else if (this.panel.classList.contains('rooms-admin')) this.backAction();
    });
    this.panel.addEventListener('click', event => {
      for (const menu of this.panel.querySelectorAll('details[open]')) if (!menu.contains(event.target)) menu.open = false;
    });
    this.resume = () => { if (!document.hidden && manager.room && manager.transport.isConnected() && manager.protocol.expiresAt - Date.now() < 60000) void manager.transport.refreshAuthentication(); };
    window.addEventListener('focus', this.resume); document.addEventListener('visibilitychange', this.resume);
  }
  element(tag, className = '', text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
  button(label, action, className = 'rooms-button') { const button = this.element('button', className, label); button.type = 'button'; button.addEventListener('click', action); return button; }
  icon(name) {
    if (name === 'members' && this.ui.autocomplete) return this.ui.autocomplete.createMentionIcon('all');
    const source = { rooms: '#navigation-rooms > svg', menu: '.sidebar-toggle svg', channel: '#navigation-channel svg', members: '#navigation-mentions > svg', settings: '#navigation-settings > svg', invite: '#navigation-dm > svg' }[name];
    if (source && document.querySelector(source)) return document.querySelector(source).cloneNode(true);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', { more: 'M5 12h.01M12 12h.01M19 12h.01', back: 'm14 6-6 6 6 6', arrow: 'm9 6 6 6-6 6', plus: 'M12 5v14M5 12h14', refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5', chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2ZM8 9h8M8 13h5', lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3' }[name] || 'M4 6h16M4 12h16M4 18h16');
    svg.append(path); return svg;
  }
  iconButton(label, icon, action) {
    const button = this.button('', action, 'rooms-button rooms-icon-button');
    button.setAttribute('aria-label', label); button.title = label; button.append(this.icon(icon)); return button;
  }
  setPage(page, title) {
    this.settings.admin.reset(); this.panel.classList.remove('rooms-admin'); this.context.textContent = ''; this.official.hidden = false;
    this.backAction = () => void this.lobby(); this.back.replaceChildren(this.icon('back'), document.createTextNode('返回大厅'));
    this.viewRevision++; this.panel.dataset.page = page; this.title.textContent = title;
    this.back.hidden = page === 'lobby'; this.error.textContent = ''; this.status.textContent = '';
    this.title.focus({ preventScroll: true });
    return this.viewRevision;
  }
  empty(title, description, icon = 'chat') {
    const state = this.element('div', 'rooms-empty');
    state.append(this.icon(icon), this.element('h3', '', title), this.element('p', '', description)); return state;
  }
  roomCard(room, mine = false, official = false) {
    const card = this.button('', () => {
      if (official) { this.close(); this.options.official?.(room.id); this.ui.elements.chatInput?.focus(); }
      else void this.enter(room.id);
    }, 'rooms-card rooms-room-card');
    card.setAttribute('aria-label', room.name); card.dataset.kind = official ? 'official' : 'community';
    const top = this.element('span', 'rooms-card-top');
    top.append(this.icon(official ? 'channel' : 'chat'), this.element('span', 'rooms-badge', official ? '官方' : room.status === 'archived' ? '已归档' : mine ? '已加入' : '公开房间'));
    const footer = this.element('span', 'rooms-card-footer', official ? '进入频道' : '进入房间'); footer.append(this.icon('arrow'));
    card.append(top, this.element('span', 'rooms-card-name', room.name),
      this.element('span', 'rooms-card-description', room.description || (official ? 'Nightcord 官方公共聊天室。' : mine ? '已加入的用户房间' : '暂无简介')), footer);
    return card;
  }
  async attempt(action) {
    const gen = this.manager.generation, revision = this.viewRevision; this.error.textContent = '';
    try { return await action(); } catch (error) { if (gen === this.manager.generation && revision === this.viewRevision && error.name !== 'AbortError') { this.error.textContent = error.message; if (this.panel.hidden) this.ui.setConnectionStatus(error.message); } }
  }
  open() {
    this.ui.readingPosition?.leave();
    this.ui.directMessageView?.close(false); this.ui.sidebarFeatures?.close(false); this.ui.closeMentionPicker?.({ restoreFocus: false }); this.ui.closeNavigationDrawer?.();
    this.ui.elements.main.classList.add('rooms-view'); this.panel.hidden = false; this.nav?.setAttribute('aria-current', 'page');
    document.querySelector('#navigation-chat')?.removeAttribute('aria-current');
  }
  close() {
    if (this.panel.hidden && !this.ui.managedChat) return;
    this.settings.admin.reset(); this.chat.deactivate();
    this.viewRevision++; this.showingRoom = false; this.panel.hidden = true; this.manager.disconnect(); this.ui.elements.main.classList.remove('rooms-view');
    this.ui.readingPosition?.open();
    this.nav?.removeAttribute('aria-current'); RoomDestination.clear(); history.replaceState({}, '', location.pathname);
    document.querySelector('#navigation-chat')?.setAttribute('aria-current', 'page');
  }
  login() {
    const state = this.empty('登录后使用房间功能', '创建或加入用户房间需要登录 SEKAI Pass。', 'lock');
    state.append(this.button('使用 SEKAI Pass 登录', () => { RoomDestination.save(); this.ui.sekaiPassLoginCallback(); }, 'rooms-button rooms-primary'));
    this.content.replaceChildren(state);
  }
  async lobby(mine = false, cursor = '', refresh = false) {
    this.open(); this.showingRoom = false; this.chat.deactivate(); this.manager.disconnect(); this.threadId = null;
    RoomDestination.clear(); history.replaceState({}, '', location.pathname);
    const gen = this.manager.roomGeneration, revision = this.setPage('lobby', '房间大厅'); this.mine = mine;
    const current = () => gen === this.manager.roomGeneration && revision === this.viewRevision && !this.panel.hidden;
    const directory = this.element('div', 'rooms-directory');
    const intro = this.element('div', 'rooms-intro'), heading = this.element('div');
    heading.append(this.element('h2', '', mine ? '我的房间' : '浏览房间'), this.element('p', '', mine ? '查看并进入您已加入的房间。' : '浏览公开房间，或访问您已加入的房间。'));
    const create = this.button('创建房间', () => this.create(), 'rooms-button rooms-primary'); create.prepend(this.icon('plus'));
    intro.append(heading, create);
    const toolbar = this.element('div', 'rooms-toolbar'), filters = this.element('div', 'rooms-filters');
    filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '房间列表');
    for (const [value, label] of [[false, '公开房间'], [true, '我的房间']]) {
      const button = this.button(label, () => void this.lobby(value), 'rooms-button rooms-filter'); button.setAttribute('aria-pressed', String(value === mine)); filters.append(button);
    }
    const reload = this.iconButton('刷新列表', 'refresh', () => void this.lobby(mine, '', true)); reload.disabled = true;
    toolbar.append(filters, reload);
    const section = this.element('section', 'rooms-community'); section.setAttribute('aria-label', mine ? '我的房间' : '公开房间');
    const sectionHeading = this.element('div', 'rooms-section-heading');
    sectionHeading.append(this.element('h3', '', mine ? '已加入的房间' : '全部公开房间'));
    const listing = this.element('div', 'rooms-listing'); listing.setAttribute('aria-busy', 'true');
    const cards = this.element('div', 'rooms-cards'), feedback = this.element('div', 'rooms-list-feedback');
    const loading = this.element('p', 'rooms-loading', '正在加载房间列表…'); loading.setAttribute('role', 'status'); feedback.append(loading);
    listing.append(cards, feedback);
    section.append(sectionHeading, listing); directory.append(intro, toolbar, section); this.content.replaceChildren(directory);
    try {
      await this.manager.configPromise;
      if (!current()) return;
      create.hidden = this.manager.mode !== 'on' || this.manager.config?.create === false;
      if (!mine) {
        for (const room of this.manager.config?.official || []) cards.append(this.roomCard(room, false, true));
      }
      if (mine && !this.manager.user) {
        const state = this.empty('登录后查看已加入的房间', '请使用 SEKAI Pass 登录以查看房间列表。', 'lock');
        state.append(this.button('使用 SEKAI Pass 登录', () => this.ui.sekaiPassLoginCallback(), 'rooms-button rooms-primary')); feedback.replaceChildren(state); return;
      }
      if (this.manager.mode === 'off') { feedback.replaceChildren(this.empty('用户房间暂未开放', '当前可通过官方频道参与聊天。')); return; }
      if (!mine && this.manager.config?.discovery === false) { feedback.replaceChildren(this.empty('用户房间公开展示暂未开放', '可通过邀请链接加入房间，或在「我的房间」中访问已加入的房间。')); return; }
      const result = await this.manager.list(mine, cursor, refresh); if (!current()) return;
      for (const room of result.rooms) cards.append(this.roomCard(room, mine));
      feedback.replaceChildren();
      if (!cards.childElementCount) {
        const state = this.empty(mine ? '尚未加入房间' : '暂无公开房间', mine ? '可浏览公开房间，或通过房间链接加入。' : create.hidden ? '当前没有可展示的公开房间，请稍后重试。' : '当前没有可展示的公开房间，可创建房间并邀请成员加入。');
        if (mine) state.append(this.button('浏览公开房间', () => void this.lobby()));
        feedback.append(state);
      }
      if (cursor || result.cursor) {
        const pages = this.element('div', 'rooms-pagination');
        if (cursor) pages.append(this.button('返回首页', () => void this.lobby(mine)));
        if (result.cursor) pages.append(this.button('下一页', () => void this.lobby(mine, result.cursor)));
        listing.append(pages);
      }
    } catch (error) {
      if (current() && error.name !== 'AbortError') {
        const state = this.empty(mine ? '房间列表加载失败' : '用户房间列表加载失败', error.message || '请稍后重试。');
        state.setAttribute('role', 'alert'); state.append(this.button('重试', () => void this.lobby(mine, cursor, true))); feedback.replaceChildren(state);
      }
    } finally { if (current()) { listing.setAttribute('aria-busy', 'false'); reload.disabled = false; } }
  }
  create() { this.open(); this.showingRoom = false; this.setPage('create', '创建房间'); this.content.replaceChildren(); if (!this.manager.user) { this.login(); return; } this.settings.form(true); }
  async enter(id, secret) {
    this.open(); this.showingRoom = true; const revision = this.setPage('room', '用户房间');
    RoomDestination.pending = { id, secret }; history.replaceState({}, '', '/?room=' + id);
    if (!this.manager.user) { this.login(); return; }
    RoomDestination.clear(); this.options.enter?.(); this.chat.activate(id);
    await this.attempt(() => this.manager.enter(id, secret)); if (revision === this.viewRevision) this.renderRoom();
  }
  renderRoom() {
    const m = this.manager, room = m.room; this.showingRoom = true;
    this.chat.update();
    if (!room || !m.role) {
      this.open();
      if (this.panel.dataset.page !== 'room') this.setPage('room', '用户房间');
      const state = this.empty(room?.name || '用户房间', room ? room.description || '加入后可查看房间历史消息。' : m.status || '正在加载房间…');
      if (room) state.append(this.button('确认加入', () => void this.attempt(() => m.join()), 'rooms-button rooms-primary'));
      this.content.replaceChildren(state); return;
    }
    if (!this.panel.hidden) { this.viewRevision++; this.settings.admin.reset(); this.content.replaceChildren(); }
    this.panel.hidden = true; this.ui.elements.main.classList.remove('rooms-view');
    this.ui.readingPosition?.rendered();
    this.nav?.removeAttribute('aria-current');
    if (!this.ui.elements.main.matches('.tool-view, .dm-view')) document.querySelector('#navigation-chat')?.setAttribute('aria-current', 'page');
    this.input = this.ui.elements.chatInput;
  }
  details() { this.settings.details(); }
  destroy() { this.chat.destroy(); this.off(); document.removeEventListener('click', this.navigation, true); window.removeEventListener('focus', this.resume); document.removeEventListener('visibilitychange', this.resume); this.panel.remove(); }
}
