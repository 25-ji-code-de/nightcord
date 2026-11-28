/* SPDX-License-Identifier: AGPL-3.0-only */
/** Keeps a room-local reading bookmark and the two history navigation tabs. */
class ChatReadingPosition {
  constructor(ui) {
    this.ui = ui;
    this.memory = new Map();
    this.scope = null;
    this.version = 0;
    this.pendingOpen = false;
    this.engaged = false;
    const log = ui.elements.chatlog;
    this.anchor = document.createElement('div');
    this.anchor.className = 'chat-reading-anchor';
    log.before(this.anchor);
    this.resumeButton = this.button('chat-reading-resume', '回到上次读到的位置', 'M12 19V5m-5 5 5-5 5 5', () => void this.jumpBack());
    this.anchor.append(this.resumeButton);
    this.newButton = this.button('chat-reading-new', '', 'M12 5v14m-5-5 5 5 5-5', () => this.jumpUnread());
    (ui.elements.chatInput.closest('.input-area') || ui.elements.main).append(this.newButton);
    this.live = document.createElement('span');
    this.live.className = 'chat-alert-live'; this.live.setAttribute('role', 'status'); this.live.setAttribute('aria-atomic', 'true');
    this.anchor.append(this.live);
    this.onInteraction = () => { this.engaged = true; this.scheduleCapture(); };
    this.onScroll = () => { this.scheduleCapture(); this.render(); };
    for (const event of ['wheel', 'touchmove', 'pointerdown', 'keydown']) log.addEventListener(event, this.onInteraction, { passive: true });
    log.addEventListener('scroll', this.onScroll, { passive: true });
    this.onPageHide = () => this.leave();
    this.onVisibility = () => { if (document.hidden) this.leave(); else this.open(); };
    this.onPageShow = event => { if (event.persisted) this.open(); };
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.off = [
      ui.eventBus.on('room:changed', () => this.open()),
      ui.eventBus.on('session:updated', () => { if (this.key() !== this.scope) this.open(); }),
      ui.eventBus.on('session:unavailable', () => this.open()),
    ];
  }

  button(className, label, path, action) {
    const button = document.createElement('button'); button.type = 'button'; button.hidden = true;
    button.className = 'chat-reading-tab ' + className;
    button.setAttribute('aria-controls', this.ui.elements.chatlog.id);
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg><span></span>`;
    button.lastElementChild.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  key() {
    const { currentRoom, currentUser, managedChat } = this.ui;
    return currentRoom && currentUser?.id
      ? `nightcord-reading:${encodeURIComponent(currentUser.id)}:${managedChat ? 'managed' : 'public'}:${encodeURIComponent(currentRoom)}` : null;
  }
  read() {
    if (!this.scope) return null;
    let value = this.memory.get(this.scope);
    try { value = JSON.parse(localStorage.getItem(this.scope)) || value; } catch {}
    if (!value || !Number.isSafeInteger(value.timestamp) || value.timestamp <= 0
        || !Number.isFinite(value.offset) || Math.abs(value.offset) > 100000) return null;
    if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq <= 0)) return null;
    return value;
  }
  save() {
    if (!this.scope || !this.current) return;
    this.memory.set(this.scope, this.current);
    try { localStorage.setItem(this.scope, JSON.stringify(this.current)); } catch {}
  }
  visible() {
    const { main, chatlog } = this.ui.elements;
    return !!chatlog.getClientRects().length && !main.matches('.tool-view, .dm-view, .rooms-view') && !main.inert;
  }
  leave() {
    this.capture(); this.save(); clearTimeout(this.captureTimer); this.version++;
  }
  open() {
    this.save(); clearTimeout(this.captureTimer);
    this.scope = this.key(); this.version++;
    this.previous = this.read(); this.current = null; this.firstUnread = null;
    this.engaged = false; this.pendingOpen = true; this.loading = false;
    this.ui.isAtBottom = true;
    this.ui.alerts.unread = 0;
    this.resumeButton.disabled = false;
    this.resumeButton.lastElementChild.textContent = '回到上次读到的位置';
    this.ui.alerts.renderUnread();
    if (!this.ui.messageRenderPending && !this.ui.messageBuild) this.rendered();
  }
  scheduleCapture() {
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => { this.capture(); this.save(); }, 180);
  }
  capture() {
    const ui = this.ui, log = ui.elements.chatlog;
    if (!this.scope || this.key() !== this.scope || !this.visible() || this.pendingOpen
        || ui.messageRenderPending || ui.messageBuild || (!this.engaged && this.previous)) return;
    const bounds = log.getBoundingClientRect();
    let candidate;
    // Only measure message rows in visible batches; distant media stays skipped.
    for (const group of log.children) {
      const rect = group.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      for (const node of group.matches('.message') ? [group] : group.children) {
        const timestamp = Number(node.dataset.timestamp), seq = Number(node.dataset.seq);
        if (!timestamp || node.classList.contains('streaming') || node.dataset.localNakoMessageId
            || ui.messageMeta.get(timestamp)?.user === '系统') continue;
        const row = node.getBoundingClientRect();
        if (row.bottom > bounds.top && row.top < bounds.bottom) {
          candidate = { timestamp, offset: Math.round(row.top - bounds.top), ...(seq ? { seq } : {}) };
        }
      }
    }
    if (candidate) this.current = candidate;
  }
  node(position) {
    if (!position) return null;
    const node = this.ui.messageIndex.get(position.seq || position.timestamp);
    return node?.isConnected && (!position.seq || Number(node.dataset.seq) === position.seq) ? node : null;
  }
  receive(message) {
    if (!this.firstUnread) this.firstUnread = { timestamp: Number(message.timestamp), ...(message.seq ? { seq: message.seq } : {}) };
  }
  rendered() {
    if (this.key() !== this.scope) { this.open(); return; }
    if (this.pendingOpen && this.visible() && this.ui.messages.length) {
      const log = this.ui.elements.chatlog;
      this.ui.isAtBottom = true; log.scrollTop = log.scrollHeight; this.pendingOpen = false;
    }
    this.render(); this.scheduleCapture();
  }
  render() {
    const ui = this.ui, log = ui.elements.chatlog;
    const atBottom = ui.isAtBottom || log.scrollHeight - log.scrollTop - log.clientHeight < ui.scrollThreshold;
    const count = !atBottom ? ui.alerts.unread : 0;
    this.newButton.hidden = !count;
    const label = count ? `${count} 条新消息` : '';
    if (this.newButton.lastElementChild.textContent !== label) {
      this.newButton.lastElementChild.textContent = label;
      this.live.textContent = label;
    }
    if (!ui.alerts.unread) this.firstUnread = null;
    if (count && ui.alerts.unreadButton) ui.alerts.unreadButton.hidden = true;
    const previous = this.node(this.previous);
    const canLoad = this.previous?.seq && ui.managedChat?.manager.moreBefore;
    this.resumeButton.hidden = this.pendingOpen || !this.previous || (!previous && !canLoad);
    if (!this.resumeButton.hidden && previous) {
      this.resumeButton.hidden = previous.getBoundingClientRect().bottom >= log.getBoundingClientRect().top && !this.loading;
    }
  }
  jump(node, offset = 12) {
    if (!node) return false;
    const log = this.ui.elements.chatlog;
    this.engaged = true;
    log.scrollTop += node.getBoundingClientRect().top - log.getBoundingClientRect().top - offset;
    this.ui.isAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < this.ui.scrollThreshold;
    this.ui.updateUserActivityTime();
    node.tabIndex = -1; node.focus({ preventScroll: true });
    node.classList.add('message-highlighted');
    setTimeout(() => node.classList.remove('message-highlighted'), 2000);
    this.scheduleCapture(); this.ui.alerts.attention();
    return true;
  }
  jumpUnread() {
    const node = this.node(this.firstUnread);
    this.ui.alerts.unread = 0; this.firstUnread = null;
    if (!this.jump(node)) this.latest();
    this.ui.alerts.renderUnread();
  }
  latest() {
    this.engaged = true; this.pendingOpen = false;
    const log = this.ui.elements.chatlog;
    this.ui.isAtBottom = true; log.scrollTop = log.scrollHeight;
    this.ui.alerts.unread = 0; this.firstUnread = null;
    this.scheduleCapture(); this.ui.alerts.attention();
  }
  async jumpBack() {
    if (this.loading || !this.previous) return;
    const version = this.version, previous = this.previous, manager = this.ui.managedChat?.manager;
    this.loading = true; this.resumeButton.disabled = true;
    this.resumeButton.lastElementChild.textContent = '正在加载上次阅读的位置…';
    try {
      while (!this.node(previous) && previous.seq && manager?.moreBefore) {
        const earliest = Math.min(...manager.messages.keys());
        if (previous.seq >= earliest) break;
        await manager.older();
        if (this.version !== version) return;
        while (this.ui.messageRenderPending || this.ui.messageBuild || this.ui.messageRenderFrame !== null) {
          await new Promise(requestAnimationFrame);
          if (this.version !== version) return;
        }
        if (Math.min(...manager.messages.keys()) >= earliest) break;
      }
      if (this.version !== version) return;
      if (this.jump(this.node(previous), previous.offset)) this.previous = null;
      else { this.previous = null; this.ui.showError('上次阅读的消息已不在可用记录中。'); }
    } catch { if (this.version === version) this.ui.showError('暂时无法加载上次阅读的位置，请重试。'); }
    finally {
      if (this.version === version) {
        this.loading = false; this.resumeButton.disabled = false;
        this.resumeButton.lastElementChild.textContent = '回到上次读到的位置'; this.render();
      }
    }
  }
  destroy() {
    this.leave(); this.version++;
    for (const off of this.off) off();
    for (const event of ['wheel', 'touchmove', 'pointerdown', 'keydown']) this.ui.elements.chatlog.removeEventListener(event, this.onInteraction);
    this.ui.elements.chatlog.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('pagehide', this.onPageHide); window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.anchor.remove(); this.newButton.remove();
  }
}
